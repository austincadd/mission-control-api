#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy: working tree is dirty." >&2
  git status --short >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
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

echo "Deploying ${SHA} to ${REMOTE_TARGET}:${REMOTE_DIR}"
scp -i "$SSH_KEY" -o BatchMode=yes index.html health-proxy.php "$REMOTE_TARGET:$REMOTE_DIR/"
echo "Deployed ${SHA} to Bluehost"