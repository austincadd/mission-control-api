# Mission Control

Single-file frontend (`index.html`) + lightweight Node backend (`server.js`) for task execution runs with persistence + SSE streaming.

## Run it locally

```bash
cd /Users/austincaddell/.openclaw/workspace/projects/website_c88a201b/mission-control
npm install
npm run start
# open http://localhost:8787
```

## Worker mode

Mission Control now uses an explicit worker protocol:

- **Render / API host**: stores run state, streams SSE, and exposes worker endpoints
- **Local worker**: the machine that actually runs `openclaw agent --json ...`

Start the worker on the machine that has the OpenClaw CLI available:

```bash
npm run worker
```

## Architecture

- **Frontend**: `index.html`
- **Backend API**: `server.js`
- **Execution engine**: local worker process running the `openclaw` CLI
- **Persistence**: local JSON files in `data/`
  - `data/runs.json`
- **Realtime updates**: Server-Sent Events (SSE)

## Request flow

1. The browser loads the UI.
2. The UI sends HTTP requests to backend routes like `/api/tasks/:id/dispatch`.
3. The backend creates a queued run record and waits for a worker claim.
4. A worker on a real OpenClaw host claims the run, spawns `openclaw`, and posts events back.
5. The backend appends those events and streams them to the UI over SSE.
6. The UI renders those events into the task/run views.

## Core routes

### UI / run lifecycle

- `POST /api/tasks/:id/dispatch`
- `POST /api/runs/:run_id/cancel`
- `POST /api/runs/:run_id/retry`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/stream` (SSE)
- `GET /api/tasks/:id/runs`
- `GET /api/activity/stream` (global SSE)
- `GET /api/config`

### Worker protocol

- `POST /api/worker/claim`
- `POST /api/worker/runs/:run_id/events`
- `POST /api/worker/runs/:run_id/complete`
- `POST /api/worker/heartbeat`
- `GET /api/worker/status`

## Worker auth

Set a shared secret for both the API and worker:

- `MISSION_CONTROL_API_TOKEN`
- `MISSION_CONTROL_WORKER_TOKEN`

Send it as:

```bash
Authorization: Bearer <token>
```

## Env

- `PORT` (default `8787`)
- `DEFAULT_MODEL` (default `openai-codex/gpt-5.3-codex`)
- `AUTO_TRANSITION_IN_PROGRESS` (`true`/`false`, default `true`)
- `AUTO_TRANSITION_DONE` (`true`/`false`, default `true`)
- `MISSION_CONTROL_API_TOKEN` (optional; enables UI/API auth if set)
- `MISSION_CONTROL_WORKER_TOKEN` (optional; enables worker auth if set)
- `WORKER_CLAIM_TTL_MS` (default `30000`)
- `WORKER_HEARTBEAT_INTERVAL_MS` (default `15000`)
- `WORKER_HEARTBEAT_TTL_MS` (default `60000`)
- `WORKER_SWEEP_INTERVAL_MS` (default `5000`)
- `OPENCLAW_BIN` (worker only; default `openclaw`)
- `OPENCLAW_AGENT_CHANNEL` (worker only; optional channel override)
- `MISSION_CONTROL_URL` (worker only; default `http://127.0.0.1:8787`)

## Dispatch example

```bash
curl -sS -X POST http://localhost:8787/api/tasks/demo-dispatch/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "hermy",
    "model": "openai-codex/gpt-5.3-codex",
    "task": "Say hello and summarize current status"
  }'
```

## Stream events

```bash
curl -N http://localhost:8787/api/runs/<run_id>/stream
```

## Cancel

```bash
curl -sS -X POST http://localhost:8787/api/runs/<run_id>/cancel
```

## Notes

- Runs are now honest: if no worker claims them before the claim TTL expires, they fail with `no_worker_available`.
- If a worker disappears, stale claimed/running runs fail with `worker_disconnected`.
- The backend no longer embeds a fake runner fallback.
- Frontend is intentionally still single-file for speed.
