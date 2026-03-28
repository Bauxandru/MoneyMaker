#!/usr/bin/env bash
# deploy.sh — One-command deploy: bump version, push to GitHub, update license server.
#
# Usage:
#   ./scripts/deploy.sh              # patch bump (1.0.0 → 1.0.1)
#   ./scripts/deploy.sh minor        # minor bump (1.0.0 → 1.1.0)
#   ./scripts/deploy.sh major        # major bump (1.0.0 → 2.0.0)
#   ./scripts/deploy.sh 2.5.0        # set exact version
#
# Required env vars (or set in .env):
#   LICENSE_SERVER  — e.g. https://your-ip:3457
#   LICENSE_ADMIN_KEY — admin key for the license server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

LICENSE_SERVER="${LICENSE_SERVER:-}"
LICENSE_ADMIN_KEY="${LICENSE_ADMIN_KEY:-}"

if [ -z "$LICENSE_SERVER" ] || [ -z "$LICENSE_ADMIN_KEY" ]; then
  echo "[DEPLOY] ERROR: Set LICENSE_SERVER and LICENSE_ADMIN_KEY in .env or environment"
  exit 1
fi

# ── Read current version ──
CURRENT=$(node -p "require('./package.json').version")
echo "[DEPLOY] Current version: $CURRENT"

# ── Calculate new version ──
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
BUMP="${1:-patch}"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
elif [ "$BUMP" = "patch" ]; then
  NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
elif [ "$BUMP" = "minor" ]; then
  NEW_VERSION="$MAJOR.$((MINOR + 1)).0"
elif [ "$BUMP" = "major" ]; then
  NEW_VERSION="$((MAJOR + 1)).0.0"
else
  echo "[DEPLOY] Unknown bump type: $BUMP (use patch, minor, major, or exact version)"
  exit 1
fi

echo "[DEPLOY] New version: $NEW_VERSION"

# ── Step 1: Bump version in package.json ──
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "[DEPLOY] package.json updated to $NEW_VERSION"

# ── Step 2: Commit and push to GitHub ──
git add package.json
git commit -m "release: v$NEW_VERSION"
git push
echo "[DEPLOY] Pushed to GitHub"

# ── Step 3: Update min_version on license server ──
SERVER_URL="${LICENSE_SERVER%/}/version"
HTTP_CODE=$(curl -sk -o /tmp/deploy_response.txt -w "%{http_code}" \
  -X POST "$SERVER_URL" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $LICENSE_ADMIN_KEY" \
  -d "{\"min_version\": \"$NEW_VERSION\"}")

if [ "$HTTP_CODE" = "200" ]; then
  echo "[DEPLOY] License server min_version set to $NEW_VERSION"
else
  echo "[DEPLOY] WARNING: License server returned HTTP $HTTP_CODE"
  cat /tmp/deploy_response.txt 2>/dev/null
  echo ""
  echo "[DEPLOY] Code is pushed but min_version was NOT updated. Set it manually."
fi

echo ""
echo "[DEPLOY] Done! All users will be prompted to update within 5 minutes."
echo "         v$CURRENT → v$NEW_VERSION"
