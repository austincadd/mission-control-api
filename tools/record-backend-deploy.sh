#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SHA_SHORT="$(git rev-parse --short HEAD)"
SHA_FULL="$(git rev-parse HEAD)"

mkdir -p .deploy
if ! printf '%s\n' "$SHA_FULL" > .deploy/backend-sha; then
  echo "Failed to write .deploy/backend-sha" >&2
  exit 1
fi

echo "Recorded backend deploy SHA ${SHA_SHORT} in .deploy/backend-sha"
echo "Remember to commit .deploy/backend-sha after confirming Render picked up the deploy."
