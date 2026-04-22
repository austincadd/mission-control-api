# Mission Control

Single-file frontend (`index.html`) + lightweight Node backend (`server.js`) for task execution runs with persistence + SSE streaming.

## Run it

```bash
cd /Users/austincaddell/.openclaw/workspace/projects/website_c88a201b/mission-control
npm install
npm run start
# open http://localhost:8787
```

Optional dev watch:

```bash
npm run dev
```

## Backend API

Implemented endpoints:

- `POST /api/tasks/:id/dispatch`
- `POST /api/runs/:run_id/cancel`
- `POST /api/runs/:run_id/retry`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/stream` (SSE)
- `GET /api/tasks/:id/runs`
- `GET /api/activity/stream` (global SSE)
- `GET /api/config`

Data persistence is local JSON in `data/runs.json`.

## Config / env

Set via environment variables when starting backend:

- `PORT` (default `8787`)
- `OPENCLAW_URL` (default `http://localhost:3333`)
- `OPENCLAW_TOKEN` (default empty)
- `DEFAULT_MODEL` (default `anthropic/claude-haiku-4-5`)
- `AUTO_TRANSITION_IN_PROGRESS` (`true`/`false`, default `true`)
- `AUTO_TRANSITION_DONE` (`true`/`false`, default `true`)

Frontend settings page also stores:

- gateway URL
- auth token
- default model
- auto status transitions

## Keyboard shortcuts

- `Cmd/Ctrl + K` : command palette shortcut hook
- `C` : create quick task
- `R` : run selected task (when task detail panel is open)
- `Esc` : close detail panel

## OpenClaw bridge status

Backend now uses a real OpenClaw execution adapter via the local `openclaw` CLI.

- ✅ Dispatch spawns an actual `openclaw agent --json` process
- ✅ `run_id -> process handle` mapping persisted in `data/run-handles.json` for cancel/status continuity
- ✅ Live process stdout/stderr is bridged into RunEvents (`stdout` + parsed `tool_call` hints)
- ✅ Process lifecycle updates run status (`queued -> running -> success|failed|cancelled`)
- ✅ Cancel uses real process termination (`SIGTERM`, escalates to `SIGKILL`)
- ✅ Retry creates a new run and re-dispatches through the same adapter
- ✅ Hermy path supported by passing `agent_id` (or `agent`) in dispatch payload

### Real adapter run instructions

```bash
cd /Users/austincaddell/.openclaw/workspace/projects/website_c88a201b/mission-control
npm install
npm run start
```

Optional env:

- `OPENCLAW_BIN` (default `openclaw`) – override CLI binary path
- `OPENCLAW_AGENT_CHANNEL` (default unset) – optional channel override for `openclaw agent`
- `DEFAULT_MODEL` (stored on run record; forwarded as metadata in prompt)

Dispatch example (Hermy):

```bash
curl -sS -X POST http://localhost:8787/api/tasks/demo-dispatch/dispatch \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "hermy",
    "model": "anthropic/claude-haiku-4-5",
    "task": "Say hello and summarize current status"
  }'
```

Stream events:

```bash
curl -N http://localhost:8787/api/runs/<run_id>/stream
```

Cancel:

```bash
curl -sS -X POST http://localhost:8787/api/runs/<run_id>/cancel
```

## Known limitations

- OpenClaw CLI currently does not expose a first-class `model` flag on `openclaw agent`; model is tracked in Mission Control and included in run prompt metadata.
- Structured upstream tool events are surfaced opportunistically from process output (exact shape depends on CLI output mode).
- If Mission Control restarts, running OpenClaw processes may continue independently; persisted PID mapping allows best-effort cancel but not full stream replay.
- Board drag/drop and command palette are intentionally lightweight in this pass.
- Frontend remains single-file for speed; modular split is recommended for long-term maintenance.
