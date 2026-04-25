#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy: working tree is dirty." >&2
  git status --short >&2
  exit 1
fi

SHA_SHORT="$(git rev-parse --short HEAD)"
SHA_FULL="$(git rev-parse HEAD)"
REMOTE_DIR="/home2/cvywazmy/public_html/website_c88a201b/mission-control"
REMOTE_TARGET="${BLUEHOST_TARGET:-cvywazmy@austincaddell.dev}"
SSH_KEY="${BLUEHOST_SSH_KEY:-$HOME/.ssh/bluehost_deploy}"

if [[ ! -f index.html ]]; then
  echo "Missing index.html in repo root." >&2
  exit 1
fi

if [[ ! -f health-proxy.php ]]; then
  echo "Missing health-proxy.php in repo root." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
tmp_index="$tmp_dir/index.html"
trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p .deploy
if ! printf '%s\n' "$SHA_FULL" > .deploy/frontend-sha; then
  echo "Failed to write .deploy/frontend-sha" >&2
  exit 1
fi

cat index.html > "$tmp_index"
printf '\n<!-- frontend-sha: %s -->\n' "$SHA_FULL" >> "$tmp_index"

echo "Deploying ${SHA_SHORT} to ${REMOTE_TARGET}:${REMOTE_DIR}"
scp -i "$SSH_KEY" -o BatchMode=yes "$tmp_index" health-proxy.php "$REMOTE_TARGET:$REMOTE_DIR/"
echo "Deployed ${SHA_SHORT} to Bluehost"
echo "Remember to commit .deploy/frontend-sha before treating the frontend SHA as authoritative."
