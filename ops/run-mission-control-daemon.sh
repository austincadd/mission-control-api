#!/usr/bin/env bash
set -euo pipefail

MC_DIR="$HOME/.openclaw/workspace/projects/website_c88a201b/mission-control"
PORT="${MISSION_CONTROL_PORT:-8787}"
API_TOKEN_FILE="${MISSION_CONTROL_TOKEN_FILE:-$HOME/.config/mission-control/token}"

cd "$MC_DIR"

if [ ! -d node_modules ]; then
  npm install
fi

if [ -f "$API_TOKEN_FILE" ]; then
  export MISSION_CONTROL_API_TOKEN="$(cat "$API_TOKEN_FILE")"
  export MISSION_CONTROL_WORKER_TOKEN="$MISSION_CONTROL_API_TOKEN"
fi

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT

waited=0
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  if [ "$waited" -ge 10 ]; then
    echo "mission-control port $PORT is still in use after waiting ${waited}s" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

exec /usr/local/bin/npm run start
