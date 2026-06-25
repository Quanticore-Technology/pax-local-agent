#!/bin/bash
# Build a Windows .exe installer for the GoNails PAX Agent.
#
# This script does TWO things:
#   1. Cross-compile pax-agent.exe via @yao-pkg/pkg (works on any host).
#   2. Stage the installer payload (binary + nssm.exe + scripts) for Inno Setup.
#
# The final .exe installer is produced by Inno Setup (`iscc` compiler), which
# is Windows-native. This script will detect:
#   - If `iscc` is on PATH (Windows host or Wine) → run it directly.
#   - Otherwise → print clear instructions to compile elsewhere (CI, VM, dual-boot).
#
# Output:
#   installer/windows/build/staging/   — files ready for Inno Setup
#   installer/windows/dist/GoNailsPaxAgent-<version>.exe   — final installer
#
# CI: this script + GitHub Actions on `windows-latest` runner is the
# recommended production path. See installer/windows/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$AGENT_DIR"

VERSION="$(node -p "require('./package.json').version")"
# BOOTSTRAP_URL is the cloud backend endpoint the agent dials for first-time
# pairing. Different per environment:
#   dev:        http://localhost:8000           (default if env not set)
#   staging:    https://nail-salon-api-dev-rnkac.ondigitalocean.app
#   production: https://api.gonails.us
BOOTSTRAP_URL="${BOOTSTRAP_URL:-http://localhost:8000}"
ENV_LABEL="${ENV_LABEL:-dev}"
echo "==> Building for env=${ENV_LABEL}, bootstrap=${BOOTSTRAP_URL}"
NSSM_VERSION="2.24"
# NSSM 2.24 is the last stable release. nssm.cc is the canonical mirror but
# is intermittently down — try official first, fall back to community mirror.
NSSM_URLS=(
  "https://nssm.cc/release/nssm-${NSSM_VERSION}.zip"
  "https://web.archive.org/web/2023/https://nssm.cc/release/nssm-${NSSM_VERSION}.zip"
  "https://github.com/kirillkovalenko/nssm/releases/download/v${NSSM_VERSION}/nssm-${NSSM_VERSION}.zip"
)

STAGING_DIR="$SCRIPT_DIR/build/staging"
DIST_DIR="$SCRIPT_DIR/dist"
NSSM_CACHE="$SCRIPT_DIR/build/nssm-cache"

echo "==> Cleaning staging (keeping dist/ to support multi-env builds)"
rm -rf "$SCRIPT_DIR/build/staging"
mkdir -p "$STAGING_DIR/scripts" "$DIST_DIR" "$NSSM_CACHE"

# ---------------------------------------------------------------------------
# 1. Compile TS + bundle Node + agent into a single Windows .exe
# ---------------------------------------------------------------------------
echo "==> Compiling TypeScript"
yarn build >/dev/null

echo "==> Bundling Node binary (node20-win-x64) via @yao-pkg/pkg"
npx --yes @yao-pkg/pkg dist/index.js \
  --targets node20-win-x64 \
  --output  "$STAGING_DIR/pax-agent.exe" \
  --compress GZip >/dev/null

# ---------------------------------------------------------------------------
# 2. Fetch NSSM (Non-Sucking Service Manager) — runs the agent as a Service
# ---------------------------------------------------------------------------
NSSM_ZIP="$NSSM_CACHE/nssm-${NSSM_VERSION}.zip"
NSSM_VENDORED="$SCRIPT_DIR/assets/nssm.exe"
if [ ! -f "$NSSM_ZIP" ] && [ ! -f "$NSSM_VENDORED" ]; then
  echo "==> Downloading NSSM ${NSSM_VERSION}"
  for url in "${NSSM_URLS[@]}"; do
    echo "    trying $url"
    if curl -fsSL --max-time 30 -o "$NSSM_ZIP" "$url"; then
      break
    fi
    rm -f "$NSSM_ZIP"
  done
  if [ ! -f "$NSSM_ZIP" ]; then
    echo "    all mirrors failed — drop nssm.exe at: $NSSM_VENDORED"
    echo "    (download from https://nssm.cc/download once it's back, extract win64/nssm.exe)"
    exit 1
  fi
fi

# (Optional integrity check; nssm.cc has historically been HTTP-only on some
# mirrors. Skip strict pin in dev; CI should re-add `shasum -a 256 -c`.)
echo "==> Staging nssm.exe (x64)"
if [ -f "$NSSM_VENDORED" ]; then
  cp "$NSSM_VENDORED" "$STAGING_DIR/nssm.exe"
else
  unzip -p "$NSSM_ZIP" "nssm-${NSSM_VERSION}/win64/nssm.exe" > "$STAGING_DIR/nssm.exe"
fi
chmod 755 "$STAGING_DIR/nssm.exe" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Stage scripts + readme
# ---------------------------------------------------------------------------
echo "==> Staging scripts (with $ENV_LABEL bootstrap URL injected)"
# install-service.bat has __BOOTSTRAP_URL__ placeholder; replace at staging.
sed "s|__BOOTSTRAP_URL__|${BOOTSTRAP_URL}|g" \
  "$SCRIPT_DIR/scripts/install-service.bat" > "$STAGING_DIR/scripts/install-service.bat"
cp "$SCRIPT_DIR/scripts/uninstall-service.bat" "$STAGING_DIR/scripts/"
cp "$SCRIPT_DIR/scripts/launch-ui.bat"         "$STAGING_DIR/scripts/"
cp "$SCRIPT_DIR/README.txt"                    "$STAGING_DIR/"

# Keep CRLF line endings on .bat files for Windows compatibility.
for f in "$STAGING_DIR/scripts/"*.bat; do
  awk 'sub("$","\r")' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

echo
echo "✓ Staging ready: $STAGING_DIR"
echo "  pax-agent.exe ($(du -h "$STAGING_DIR/pax-agent.exe" | cut -f1))"
echo "  nssm.exe      ($(du -h "$STAGING_DIR/nssm.exe" | cut -f1))"

# ---------------------------------------------------------------------------
# 4. Compile the .iss → .exe installer (only if iscc is on PATH)
# ---------------------------------------------------------------------------
if command -v iscc >/dev/null 2>&1; then
  echo "==> Found iscc on PATH — compiling installer"
  iscc /Q \
    /DAppVersion="$VERSION" \
    /DStagingDir="$STAGING_DIR" \
    /DEnvLabel="$ENV_LABEL" \
    /O"$DIST_DIR" \
    "$SCRIPT_DIR/pax-agent.iss"
  FINAL="$DIST_DIR/GoNailsPaxAgent-${VERSION}-${ENV_LABEL}.exe"
  echo
  echo "✓ Built: $FINAL ($(du -h "$FINAL" | cut -f1))"
elif command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "==> Using Docker (amake/innosetup) — compiling installer"
  docker run --rm \
    -v "$AGENT_DIR:/work" \
    -w /work/installer/windows \
    amake/innosetup \
    /Q \
    "/DAppVersion=$VERSION" \
    "/DStagingDir=build/staging" \
    "/DEnvLabel=$ENV_LABEL" \
    "/Odist" \
    pax-agent.iss
  FINAL="$DIST_DIR/GoNailsPaxAgent-${VERSION}-${ENV_LABEL}.exe"
  if [ -f "$FINAL" ]; then
    echo
    echo "✓ Built: $FINAL ($(du -h "$FINAL" | cut -f1))"
  else
    echo "Docker compile produced no output — check logs above"
    exit 1
  fi
else
  echo
  echo "⚠  iscc (Inno Setup compiler) not found on PATH."
  echo
  echo "Two ways to finish the build:"
  echo
  echo "  A) On Windows (or in a VM):"
  echo "       cd ${SCRIPT_DIR/$AGENT_DIR\//}"
  echo "       iscc /DAppVersion=${VERSION} /DStagingDir=${STAGING_DIR} pax-agent.iss"
  echo
  echo "  B) Cross-compile via Wine on macOS:"
  echo "       brew install --cask --no-quarantine wine-stable"
  echo "       # download Inno Setup unicode .exe + run installer under Wine"
  echo "       wine iscc /D... pax-agent.iss"
  echo
  echo "  C) GitHub Actions (recommended for releases) — \`windows-latest\` runner has"
  echo "     iscc pre-installed via \`crazy-max/ghaction-chocolatey@v2 with package: innosetup\`."
  echo
  echo "Staging payload is ready at: $STAGING_DIR"
fi
