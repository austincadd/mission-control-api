# Mission Control

Mission Control is a small execution control plane:

- **Frontend**: `index.html`
- **Backend API**: `server.js`
- **Worker**: `worker.js`
- **Oracle / smoke test**: `scripts/e2e-smoke.sh`

The backend owns run state and SSE. The worker claims runs and executes `openclaw`. The smoke test is the fastest way to verify the whole chain end-to-end.

## Quick start

```bash
cd /Users/austincaddell/.openclaw/workspace/projects/website_c88a201b/mission-control
npm install
npm run start
# open http://localhost:8787
```

Start the worker on a machine with the OpenClaw CLI installed:

```bash
npm run worker
```

Run the oracle smoke test against the deployed backend:

```bash
npm run smoke
```

The smoke test reads `.deploy/backend-sha` and `.deploy/frontend-sha`. If those files are missing, it falls back to `EXPECTED_SHA` for backward compatibility.

## Architecture

- **Render / API host**: authoritative run state, worker endpoints, SSE, version metadata
- **Local worker**: claims and executes OpenClaw runs
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

## Connectivity states

The frontend shows a tri-state backend badge:

- **online**: backend reachable and at least one worker heartbeat is fresh and healthy
- **degraded**: backend reachable, but the worker is stale or marked unhealthy
- **unreachable**: backend fetch/config probe failed

The **Reset & Reconnect** button clears stale localStorage state, restores defaults, closes streams, and re-probes the backend.

## Version / deploy metadata

These endpoints expose deploy identity:

- `GET /api/version`
- `GET /api/config`

Both include:

- `git_sha`
- `build_at`

SHA source fallback order:

1. `RENDER_GIT_COMMIT`
2. `GIT_SHA`
3. `.git-sha`
4. `unknown`

## Run lifecycle contract

Run payloads returned to clients are compact by design.

- `worker_message` is **server-side only** and should not appear in API run payloads
- `outcome` / terminal completion is written once
- duplicate terminal writes are rejected with `409 run_terminal_conflict`
- `success` cannot be written after error events

## Core routes

### UI / run lifecycle

- `POST /api/tasks/:id/dispatch`
- `POST /api/runs/:run_id/cancel`
- `POST /api/runs/:run_id/retry`
- `GET /api/runs/:run_id`
- `GET /api/runs/:run_id/events?limit=500&since=<event_id>`
- `GET /api/runs/:run_id/stream` (SSE)
- `GET /api/tasks/:id/runs`
- `GET /api/activity/stream` (global SSE)
- `GET /api/config`
- `GET /api/version`

### Worker protocol

- `POST /api/worker/claim`
- `POST /api/worker/runs/:run_id/events`
- `POST /api/worker/runs/:run_id/complete`
- `POST /api/worker/heartbeat`
- `GET /api/worker/status`

## Worker health behavior

The worker probes OpenClaw at startup with `openclaw config validate --json` to confirm the binary is installed and the config is schema-valid.

What this *does* verify:

- the `openclaw` binary is runnable
- the active config parses and validates
- the worker can report a clean startup health check

What this *does not* verify:

- gateway connectivity
- model reachability
- that real agent runs will succeed

Those are confirmed by the first claimed run.

When the probe succeeds, the worker reports `health_probe: config_validate` and stays eligible to claim runs.

If validation fails, the worker reports:

- `healthy: false`
- `health_reason: <specific config error>`

That state is surfaced by `/api/worker/status` and the smoke test treats it as `worker_unhealthy`.

## Worker auth

Set a shared secret for both the API and worker:

- `MISSION_CONTROL_API_TOKEN`
- `MISSION_CONTROL_WORKER_TOKEN`

Send it as:

```bash
Authorization: Bearer ***
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
- `WORKER_STARTUP_PROBE_TIMEOUT_MS` (worker only; startup probe timeout)
- `SMOKE_POLL_TIMEOUT` (smoke only; default `180`)
- `SMOKE_POLL_INTERVAL` (smoke only; default `2`)
- `SMOKE_WORKER_MAX_AGE` (smoke only; default `90`)
- `EXPECTED_SHA` (smoke only; deploy SHA oracle)

## Smoke test

The smoke test validates the full control plane:

1. `GET /api/version`
2. `GET /api/config`
3. `GET /api/worker/status`
4. `POST /api/tasks/:id/dispatch`
5. Poll the run to terminal state
6. `GET /api/runs/:run_id/events`
7. Re-POST terminal completion to verify duplicate-write rejection

Known failure codes include:

- `backend_unreachable`
- `version_fetch_failed`
- `version_parse_error`
- `sha_mismatch`
- `sha_unavailable`
- `worker_status_failed`
- `worker_status_endpoint_missing`
- `worker_unhealthy`
- `dispatch_failed`
- `run_never_claimed`
- `run_failed`
- `contradictory_state`
- `duplicate_terminal_write_not_rejected`

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

- Runs are honest: if no worker claims them before the claim TTL expires, they fail with `no_worker_available`.
- If a worker disappears, stale claimed/running runs fail with `worker_disconnected`.
- The frontend keeps a stale-localStorage reset path so a bad saved gateway does not brick the UI.
- The backend no longer embeds a fake runner fallback.
