#!/bin/bash
# Upload built installer artifacts to DigitalOcean Spaces (S3-compatible).
#
# Reads DO_SPACES_* env from nail-salon-api/.env. Uploads with public-read ACL
# so the dashboard "Download Installer" button can serve the file directly.
#
# Usage:
#   bash installer/upload-installer.sh                # macOS only (current)
#   bash installer/upload-installer.sh win            # Windows only (when added)
#   bash installer/upload-installer.sh all
#
# Output URL is printed at the end — paste it into NEXT_PUBLIC_PAX_AGENT_INSTALLER_URL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$AGENT_DIR/../.." && pwd)"
ENV_FILE="$REPO_ROOT/nail-salon-api/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Need DO_SPACES_* credentials."
  exit 1
fi

# Source the env (only DO_SPACES_* vars).
# Use tmpfile + set -a instead of process substitution — the latter has
# subshell quirks under `set -e` that swallow the exports.
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"' EXIT
grep -E '^DO_SPACES_' "$ENV_FILE" > "$TMP_ENV"
set -a
# shellcheck disable=SC1090
. "$TMP_ENV"
set +a

: "${DO_SPACES_REGION:?missing}"
: "${DO_SPACES_BUCKET_NAME:?missing}"
: "${DO_SPACES_ENDPOINT:?missing}"
: "${DO_SPACES_ACCESS_KEY_ID:?missing}"
: "${DO_SPACES_SECRET_ACCESS_KEY:?missing}"
: "${DO_SPACES_CDN_URL:?missing}"

# Endpoint may be stored as bare hostname (`syd1.digitaloceanspaces.com`) —
# AWS CLI requires a scheme. Normalize.
case "$DO_SPACES_ENDPOINT" in
  http://*|https://*) ;;
  *) DO_SPACES_ENDPOINT="https://$DO_SPACES_ENDPOINT" ;;
esac

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found. Install with: brew install awscli"
  exit 1
fi

VERSION="$(node -p "require('$AGENT_DIR/package.json').version")"
ENV_LABEL="${ENV_LABEL:-dev}"
PREFIX="pax-agent/v${VERSION}/${ENV_LABEL}"

# Run the upload via the AWS CLI with DO Spaces endpoint override.
upload() {
  local local_path="$1"
  local remote_key="$2"
  local content_type="$3"

  AWS_ACCESS_KEY_ID="$DO_SPACES_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$DO_SPACES_SECRET_ACCESS_KEY" \
  aws s3 cp "$local_path" "s3://$DO_SPACES_BUCKET_NAME/$remote_key" \
    --endpoint-url "$DO_SPACES_ENDPOINT" \
    --region "$DO_SPACES_REGION" \
    --acl public-read \
    --content-type "$content_type" \
    --cache-control "public, max-age=31536000, immutable"

  echo "  → ${DO_SPACES_CDN_URL%/}/$remote_key"
}

target="${1:-mac}"

PKG_NAME="GoNailsPaxAgent-${VERSION}-${ENV_LABEL}.pkg"
EXE_NAME="GoNailsPaxAgent-${VERSION}-${ENV_LABEL}.exe"

case "$target" in
  mac|all)
    PKG_FILE="$AGENT_DIR/installer/macos/dist/$PKG_NAME"
    if [ ! -f "$PKG_FILE" ]; then
      echo "ERROR: $PKG_FILE not built. Run: ENV_LABEL=$ENV_LABEL BOOTSTRAP_URL=... yarn installer:macos"
      exit 1
    fi
    echo "==> Uploading macOS .pkg env=$ENV_LABEL ($(du -h "$PKG_FILE" | cut -f1))"
    upload "$PKG_FILE" "$PREFIX/$PKG_NAME" "application/x-newton-compatible-pkg"
    ;;
esac

case "$target" in
  win|all)
    EXE_FILE="$AGENT_DIR/installer/windows/dist/$EXE_NAME"
    if [ -f "$EXE_FILE" ]; then
      echo "==> Uploading Windows .exe env=$ENV_LABEL ($(du -h "$EXE_FILE" | cut -f1))"
      upload "$EXE_FILE" "$PREFIX/$EXE_NAME" "application/x-msdownload"
    elif [ "$target" = "win" ]; then
      echo "ERROR: Windows installer not built yet for env=$ENV_LABEL (installer/windows/dist/$EXE_NAME)"
      exit 1
    fi
    ;;
esac

echo
echo "✓ Done. Env=$ENV_LABEL URLs:"
echo "  macOS:   ${DO_SPACES_CDN_URL%/}/$PREFIX/$PKG_NAME"
echo "  Windows: ${DO_SPACES_CDN_URL%/}/$PREFIX/$EXE_NAME"
