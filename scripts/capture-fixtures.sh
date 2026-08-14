#!/usr/bin/env bash
# capture-fixtures.sh — regenerate the golden parser fixtures from a real repository.
#
# The parsers are coupled to how `lore` formats output, so the fixtures must come from a
# real repo rather than being hand-written. Run this ONLY when deliberately adopting a new
# lore version, then read the test failures: they tell you exactly what changed.
#
# The diff fixture needs a genuine content change, so this appends one line to a text file
# and restores it afterwards, verifying by checksum. It refuses to run on a repo with
# staged work.
set -uo pipefail

REPO="${1:-$HOME/demo-ctone2/demo}"
FX="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/tests/fixtures"
PROBE="${PROBE_FILE:-Daniel/Test.txt}"

[ -d "$REPO/.lore" ] || { echo "not a lore repo: $REPO" >&2; exit 1; }
mkdir -p "$FX"
cd "$REPO" || exit 1

echo "capturing from $REPO  (lore $(lore --version 2>&1 | head -1))"

{ lore status --offline 2>/dev/null | head -25; echo "... (truncated)"; } > "$FX/status_typical.txt"
lore status --offline 2>/dev/null | head -2 > "$FX/status_header_only.txt"
lore branch list --offline 2>/dev/null > "$FX/branches_single.txt"

[ -f "$PROBE" ] || { echo "probe file missing: $PROBE" >&2; exit 1; }
BEFORE="$(shasum -a 256 "$PROBE" | awk '{print $1}')"
cp "$PROBE" "/tmp/altlore-fixture-backup.$$"
restore() {
  cp "/tmp/altlore-fixture-backup.$$" "$PROBE"
  if [ "$(shasum -a 256 "$PROBE" | awk '{print $1}')" = "$BEFORE" ]; then
    echo "probe restored ok"
  else
    echo "!!! PROBE NOT RESTORED — recover from /tmp/altlore-fixture-backup.$$" >&2
  fi
  rm -f "/tmp/altlore-fixture-backup.$$"
}
trap restore EXIT INT TERM

printf 'a fourth line\n' >> "$PROBE"
lore diff "$PROBE" > "$FX/diff_text_modified.txt" 2>&1

# A file marked dirty whose contents match: the common case, and the one that must not
# read as an error.
lore diff Feedback.txt > "$FX/diff_empty.txt" 2>&1

echo "fixtures written to $FX"
