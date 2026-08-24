#!/bin/bash
# Build a macOS .pkg installer for the GoNails PAX Agent.
#
# Output: installer/macos/dist/GoNailsPaxAgent-<version>.pkg
#
# Steps:
#   1. tsc → dist/  (npm run build)
#   2. pkg → arm64 + x64 binaries, fused with lipo into one universal binary
#   3. pkgbuild → component .pkg (binary + plist + scripts)
#   4. productbuild → distribution .pkg (welcome/conclusion + version metadata)
#
# Code-signing + notarization are NOT done here — see README for the prod flow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$AGENT_DIR"

VERSION="$(node -p "require('./package.json').version")"

# Built as a universal binary rather than for the host arch. pkg cross-compiles
# happily, so the only cost is a second bundling pass — and building for
# `uname -m` alone meant every .pkg cut on an Apple Silicon machine simply did
# not run on the Intel Macs still common as salon POS hardware, while installing
# without complaint.

# BOOTSTRAP_URL is the cloud backend endpoint the agent dials for first-time
# pairing. Different per environment:
#   dev:        http://localhost:8000           (default if env not set)
#   staging:    https://nail-salon-api-dev-rnkac.ondigitalocean.app
#   production: https://api.gonails.us
#
# ENV is just a label that goes into the output filename so we can ship
# multiple variants side-by-side without confusion.
BOOTSTRAP_URL="${BOOTSTRAP_URL:-http://localhost:8000}"
ENV_LABEL="${ENV_LABEL:-dev}"

DIST_DIR="$SCRIPT_DIR/dist"
ROOT_DIR="$SCRIPT_DIR/build/root"
SCRIPTS_DIR="$SCRIPT_DIR/scripts"
RESOURCES_DIR="$SCRIPT_DIR/Resources"
COMPONENT_PKG="$SCRIPT_DIR/build/component.pkg"
FINAL_PKG="$DIST_DIR/GoNailsPaxAgent-${VERSION}-${ENV_LABEL}.pkg"

echo "==> Building for env=${ENV_LABEL}, bootstrap=${BOOTSTRAP_URL}"

echo "==> Cleaning intermediate build (keeping dist/ to support multi-env builds)"
rm -rf "$SCRIPT_DIR/build"
mkdir -p "$DIST_DIR" "$ROOT_DIR/usr/local/bin" \
         "$ROOT_DIR/Library/Application Support/GoNails/PaxAgent" \
         "$ROOT_DIR/usr/local/share/pax-agent" \
         "$ROOT_DIR/Applications"

echo "==> Compiling TypeScript"
npm run build >/dev/null

echo "==> Bundling Node binaries (arm64 + x64) via @yao-pkg/pkg"
ARCH_TMP="$SCRIPT_DIR/build/arch"
mkdir -p "$ARCH_TMP"
for slice in arm64 x64; do
  npx --yes @yao-pkg/pkg dist/index.js \
    --targets "node20-macos-${slice}" \
    --output  "$ARCH_TMP/pax-agent-${slice}" \
    --compress GZip >/dev/null
done

echo "==> Fusing into a universal binary"
lipo -create -output "$ROOT_DIR/usr/local/bin/pax-agent" \
  "$ARCH_TMP/pax-agent-arm64" "$ARCH_TMP/pax-agent-x64"
chmod 755 "$ROOT_DIR/usr/local/bin/pax-agent"
lipo -archs "$ROOT_DIR/usr/local/bin/pax-agent"

echo "==> Staging plist (with $ENV_LABEL bootstrap URL) + uninstall helper + .app launcher"
# Inject env-specific BOOTSTRAP_URL into the plist template at staging time.
# The template stores `__BOOTSTRAP_URL__` as a placeholder.
sed "s|__BOOTSTRAP_URL__|${BOOTSTRAP_URL}|g" \
  "$SCRIPT_DIR/com.gonails.paxagent.plist" \
  > "$ROOT_DIR/Library/Application Support/GoNails/PaxAgent/com.gonails.paxagent.plist"
cp "$SCRIPT_DIR/uninstall.sh" \
   "$ROOT_DIR/usr/local/share/pax-agent/uninstall.sh"
cp -R "$SCRIPT_DIR/app-template/GoNails PAX Agent.app" \
   "$ROOT_DIR/Applications/"

echo "==> Setting script executable bits"
chmod 755 "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"
chmod 755 "$ROOT_DIR/usr/local/share/pax-agent/uninstall.sh"

echo "==> pkgbuild → component package"
pkgbuild \
  --root "$ROOT_DIR" \
  --identifier "com.gonails.paxagent" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$COMPONENT_PKG" >/dev/null

echo "==> productbuild → distribution package"
productbuild \
  --distribution "$SCRIPT_DIR/distribution.xml" \
  --resources    "$RESOURCES_DIR" \
  --package-path "$SCRIPT_DIR/build" \
  "$FINAL_PKG" >/dev/null

echo
echo "✓ Built: $FINAL_PKG"
echo "  Size:  $(du -h "$FINAL_PKG" | cut -f1)"
echo
echo "Test on this Mac (will trigger a real install):"
echo "  sudo installer -pkg \"$FINAL_PKG\" -target /"
echo
echo "Uninstall:"
echo "  sudo bash /usr/local/share/pax-agent/uninstall.sh"
