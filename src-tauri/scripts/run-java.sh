#!/bin/bash
# run-java — launches the bundled JRE, or falls back to a system one.
#
# This wrapper exists for one reason: **a macOS GUI app does not inherit your shell PATH**.
# An app launched from Finder or the Dock has a minimal environment, so calling `java`
# directly works when you run the app from a terminal and fails for everybody else — the
# worst possible failure mode, because it works on the developer's machine.
#
# Installed as a Tauri sidecar, so at runtime it lives in `<app>.app/Contents/MacOS/`
# while the JRE is in `<app>.app/Contents/Resources/jre/`. The `../Resources` hop below
# is exactly that bundle relationship.
#
# In `tauri dev` there is no Contents/ layout — the sidecar sits flat in target/debug —
# so the hop resolves to something that does not exist and we fall through to system Java.
# That is intended: dev uses your JDK, the bundle uses the shipped one. It also means a
# bundling mistake can be invisible in dev, so verify the packaged app, not just dev.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOURCES_DIR="$(dirname "$SCRIPT_DIR")/Resources"

BUNDLED_JAVA="$RESOURCES_DIR/jre/bin/java"
if [ -x "$BUNDLED_JAVA" ]; then
  exec "$BUNDLED_JAVA" "$@"
fi

# Fallbacks, most-correct first. java_home is the supported way to ask macOS.
if [ -x /usr/libexec/java_home ]; then
  JH="$(/usr/libexec/java_home 2>/dev/null)"
  if [ -n "$JH" ] && [ -x "$JH/bin/java" ]; then
    exec "$JH/bin/java" "$@"
  fi
fi

for candidate in /opt/homebrew/bin/java /usr/local/bin/java /usr/bin/java; do
  [ -x "$candidate" ] && exec "$candidate" "$@"
done

# Reported as JSON because the caller parses this stream; a bare message would be
# swallowed as an unparseable line and surface as a generic failure.
echo '{"event":"error","message":"No Java runtime found. The bundled runtime is missing and no system Java is installed."}'
exit 1
