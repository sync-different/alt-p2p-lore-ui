#!/usr/bin/env bash
# fetch-deps.sh — assemble the third-party payload the app bundles.
#
# Three things ship inside the installer so the user installs nothing (spec R3):
#
#   1. the `lore` CLI binary          — repository operations
#   2. alt-p2p-lore's fat JAR         — the P2P tunnel
#   3. a jlink'd Java runtime         — to run that JAR
#
# None of them belong in git: `lore` alone is 33 MB, and a JRE is ~45 MB. This script
# copies them in from known local paths, and writes a manifest recording the exact
# versions it copied — so any build can be traced back to what went into it, which a
# stable filename cannot tell you afterwards.
#
# Usage:  scripts/fetch-deps.sh [--check]
#           --check   report what is present and exit; copy nothing
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/src-tauri/binaries"
RES_DIR="$ROOT/src-tauri/resources"
MANIFEST="$RES_DIR/deps-manifest.json"

# Windows runs this under Git Bash, so bash and `file` are both available and the script
# stays one script rather than two that drift. What genuinely differs is named below:
# the `.exe` suffix Tauri requires on sidecars, where a JDK and `lore` are installed, and
# that the sidecar wrapper must be compiled rather than copied.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1; EXE=".exe" ;;
  *)                    IS_WINDOWS=0; EXE=""     ;;
esac

# Sources. Override with env vars when these move (a released artefact, another machine).
if [ "$IS_WINDOWS" = "1" ]; then
  LORE_SRC="${LORE_SRC:-$HOME/bin/lore.exe}"
  # No java_home on Windows; JAVA_HOME is the convention and is what the installers set.
  JDK_HOME="${JDK_HOME:-${JAVA_HOME:-}}"
else
  LORE_SRC="${LORE_SRC:-$HOME/.local/bin/lore}"
  JDK_HOME="${JDK_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null)}"
fi

# Pick the newest jar rather than pinning a version. A pinned name goes stale silently the
# next time alt-p2p-lore's version moves — it had already drifted to a 0.4.1 that no longer
# existed, and the failure is "not found" pointing at a path nobody had reason to doubt.
if [ -z "${JAR_SRC:-}" ]; then
  JAR_DIR="$HOME/Development/GitHub/alt-p2p-lore/target"
  JAR_SRC="$(ls -t "$JAR_DIR"/alt-p2p-lore-*.jar 2>/dev/null | grep -v -- '-sources\|-javadoc' | head -1)"
  JAR_SRC="${JAR_SRC:-$JAR_DIR/alt-p2p-lore.jar}"
fi

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say()  { printf '  %s\n' "$*"; }
fail() { printf '  ERROR: %s\n' "$*" >&2; exit 1; }

# Tauri resolves a sidecar by appending the host target triple to the configured name,
# so the file on disk MUST be `<name>-<triple>`. Getting this wrong fails at bundle time
# with a "binary not found" that does not mention the triple.
TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
[ -n "$TRIPLE" ] || fail "could not determine the Rust host triple (is rustc on PATH?)"

say "target triple : $TRIPLE"
say "lore source   : $LORE_SRC"
say "jar source    : $JAR_SRC"
say "jdk for jlink : ${JDK_HOME:-<none found>}"
echo

if [ "$CHECK_ONLY" = "1" ]; then
  for f in "$BIN_DIR/lore-$TRIPLE$EXE" "$BIN_DIR/run-java-$TRIPLE$EXE" \
           "$RES_DIR/alt-p2p-lore.jar" "$RES_DIR/jre/bin/java$EXE"; do
    [ -e "$f" ] && say "present : $f" || say "MISSING : $f"
  done
  [ -f "$MANIFEST" ] && { say "manifest:"; sed 's/^/    /' "$MANIFEST"; }
  exit 0
fi

mkdir -p "$BIN_DIR" "$RES_DIR"

# --- 1. lore -----------------------------------------------------------------
[ -x "$LORE_SRC" ] || fail "lore not found or not executable at $LORE_SRC (set LORE_SRC=)"
LORE_VER="$("$LORE_SRC" --version 2>&1 | head -1)"
# `file` spells the same architecture differently per binary format: Mach-O says `x86_64`,
# PE says `x86-64`. Matching only the underscore left this field empty on Windows — which
# a manifest exists to prevent, since it is read to answer "what went into this build?".
LORE_ARCH="$(file -b "$LORE_SRC" | grep -oE 'arm64|aarch64|x86[_-]64' | head -1 | tr '-' '_')"
cp -f "$LORE_SRC" "$BIN_DIR/lore-$TRIPLE$EXE"
chmod +x "$BIN_DIR/lore-$TRIPLE$EXE"
say "lore     -> binaries/lore-$TRIPLE$EXE   ($LORE_VER, ${LORE_ARCH:-unknown})"

# lore is MIT; shipping it means shipping its licence.
if [ -f "$ROOT/licenses/LORE-LICENSE" ]; then
  say "         (licence present in licenses/)"
else
  say "         NOTE: add licenses/LORE-LICENSE — lore is MIT and we redistribute it"
fi

# --- 1b. the run-java sidecar ------------------------------------------------
# This step is new. It was a manual copy on the machine this was built on, which no note
# recorded — so a fresh clone bundled everything except the wrapper that starts the tunnel,
# and Tauri reported only "binary not found". Staging it here is what makes the checkout
# reproducible on both platforms.
#
# Unix ships the shell script as-is. Windows cannot: a sidecar must be a real PE image and
# a renamed `.cmd` will not load, so the Rust counterpart is compiled with plain `rustc` —
# already required above for the target triple, so this adds no new prerequisite.
RUNJAVA_DEST="$BIN_DIR/run-java-$TRIPLE$EXE"
if [ "$IS_WINDOWS" = "1" ]; then
  # `+crt-static` is load-bearing, not a nicety.
  #
  # Rust's MSVC target links the C runtime dynamically by default, which made this binary
  # import **VCRUNTIME140.dll** — part of the Visual C++ Redistributable, which a developer
  # machine has and a **fresh Windows 11 does not**. The installed app then died on
  # "The code execution cannot proceed because VCRUNTIME140.dll was not found", and because
  # `run-java` *is* the program `prereq.rs` probes, both Alterante P2P and the Java runtime
  # reported "not reached" — one missing DLL presenting as two unrelated failures.
  #
  # Static linking removes the dependency outright, so nothing has to be installed alongside
  # the app. Neither of the other bundled executables needs this: `lore.exe` ships statically
  # linked already, and the Tauri binary imports only the Universal CRT (`api-ms-win-crt-*`),
  # which is part of Windows itself.
  #
  # Verify after changing this, on the binary rather than by reasoning:
  #   dumpbin /dependents binaries\run-java-<triple>.exe   # must list no VCRUNTIME140.dll
  rustc -O --edition 2021 -C target-feature=+crt-static \
    -o "$RUNJAVA_DEST" "$ROOT/src-tauri/scripts/run-java.rs" \
    || fail "could not compile src-tauri/scripts/run-java.rs"
  say "run-java -> binaries/run-java-$TRIPLE$EXE   (compiled from run-java.rs, static CRT)"

  # Left unsigned on purpose. Tauri signs it during `tauri build` via `signCommand`; `tauri dev`
  # never signs, and does not need to.
else
  cp -f "$ROOT/src-tauri/scripts/run-java.sh" "$RUNJAVA_DEST"
  chmod +x "$RUNJAVA_DEST"
  say "run-java -> binaries/run-java-$TRIPLE   (from run-java.sh)"
fi

# --- 2. alt-p2p-lore jar -----------------------------------------------------
[ -f "$JAR_SRC" ] || fail "alt-p2p-lore jar not found at $JAR_SRC (set JAR_SRC=)"
cp -f "$JAR_SRC" "$RES_DIR/alt-p2p-lore.jar"
say "jar      -> resources/alt-p2p-lore.jar   ($(basename "$JAR_SRC"))"

# --- 3. jlink runtime --------------------------------------------------------
# Only the modules the JAR actually needs. A full JDK is ~330 MB; this lands near 45 MB.
# If the app fails at runtime with NoClassDefFoundError, a module is missing here.
if [ -d "$RES_DIR/jre" ] && [ "${FORCE_JRE:-0}" != "1" ]; then
  say "jre      -> resources/jre (exists; FORCE_JRE=1 to rebuild)"
else
  [ -n "$JDK_HOME" ] || fail "no JDK 17 found for jlink (set JDK_HOME=)"

  # jlink writes its output READ-ONLY, so a plain rm -rf fails on the second run.
  [ -d "$RES_DIR/jre" ] && chmod -R u+w "$RES_DIR/jre"
  rm -rf "$RES_DIR/jre"

  # Ask jdeps what THIS jar needs rather than copying a module list from another app —
  # the answer changes with the jar's dependencies. jdeps does miss jdk.crypto.ec, which
  # the DTLS cipher suites need at runtime and nothing detects statically, so add it.
  MODULES="$("$JDK_HOME/bin/jdeps" --print-module-deps --ignore-missing-deps "$RES_DIR/alt-p2p-lore.jar" 2>/dev/null)"
  [ -n "$MODULES" ] || MODULES="java.base"
  MODULES="${MODULES},jdk.crypto.ec"
  say "jlink modules: $MODULES"

  # The compression flag changed spelling: JDK <=20 takes --compress=2, JDK 21+ takes
  # --compress=zip-6 and rejects the old form. Pick by version rather than pinning a JDK,
  # since the failure ("Invalid compression level") does not say which dialect it wanted.
  JLINK_MAJOR="$("$JDK_HOME/bin/jlink" --version 2>&1 | cut -d. -f1)"
  if [ "${JLINK_MAJOR:-17}" -ge 21 ] 2>/dev/null; then
    COMPRESS="--compress=zip-6"
  else
    COMPRESS="--compress=2"
  fi

  "$JDK_HOME/bin/jlink" \
    --add-modules "$MODULES" \
    --strip-debug --no-header-files --no-man-pages $COMPRESS \
    --output "$RES_DIR/jre" || fail "jlink failed"
  say "jre      -> resources/jre   ($("$RES_DIR/jre/bin/java$EXE" --version 2>&1 | head -1))"
fi

# --- manifest ----------------------------------------------------------------
cat > "$MANIFEST" <<EOF
{
  "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "triple": "$TRIPLE",
  "lore": { "version": "$LORE_VER", "arch": "$LORE_ARCH", "source": "$LORE_SRC" },
  "jar":  { "file": "$(basename "$JAR_SRC")" },
  "jre":  { "version": "$("$RES_DIR/jre/bin/java$EXE" --version 2>&1 | head -1)" }
}
EOF

echo
say "manifest written to resources/deps-manifest.json"

# jlink marks its output read-only, and Tauri copies the whole JRE into target/ at build
# time. On the SECOND build those copies cannot be overwritten and the build dies with a
# bare "Permission denied (os error 13)" that names no file — so make every copy writable
# now, while we still have the context to explain why.
for d in "$RES_DIR/jre" "$ROOT/src-tauri/target/release/jre" "$ROOT/src-tauri/target/debug/jre"; do
  [ -d "$d" ] && chmod -R u+w "$d" 2>/dev/null
done
say "made jre copies writable (jlink output is read-only; breaks rebuilds otherwise)"
say "total payload: $(du -sh "$BIN_DIR" "$RES_DIR" 2>/dev/null | awk '{s=$1; print s}' | paste -sd' + ' -)"
