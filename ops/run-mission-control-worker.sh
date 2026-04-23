#!/usr/bin/env bash
set -euo pipefail

MC_DIR="$HOME/.openclaw/workspace/projects/website_c88a201b/mission-control"
API_TOKEN_FILE="${MISSION_CONTROL_TOKEN_FILE:-$HOME/.config/mission-control/token}"
cd "$MC_DIR"

if [ -f "$API_TOKEN_FILE" ]; then
  TOKEN_VALUE="$(tr -d '\r\n' < "$API_TOKEN_FILE")"
  export MISSION_CONTROL_WORKER_TOKEN="$TOKEN_VALUE"
  export MISSION_CONTROL_API_TOKEN="$MISSION_CONTROL_WORKER_TOKEN"
fi

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /usr/local/bin/npm run worker
