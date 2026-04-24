# Using Mission Control

A quick operator refresher for the live stack:
- backend on Render
- worker on this Mac
- UI at [austincaddell.dev/mission-control](https://austincaddell.dev/mission-control)

## 1) Pre-flight check (30 seconds)

Open the UI:
- [https://austincadd.dev/mission-control](https://austincadd.dev/mission-control)

Healthy badge:
- `Backend: online` in green
- `Backend: degraded` means the backend is up but the worker heartbeat is stale/unhealthy
- `Backend: unreachable` means the frontend couldn’t reach the backend at all

One shell line that proves backend + worker are both alive:
```bash
curl -sS https://mission-control-api-mo8l.onrender.com/api/version && \
curl -sS https://mission-control-api-mo8l.onrender.com/api/worker/status
```

If something fails, look here first:
- `Backend: unreachable` → Render URL / browser network / CORS / auth token in the UI settings
- `Backend: degraded` → `/api/worker/status` and the worker launchd log
- API responds but the badge looks wrong → click `Reset & Reconnect` in the UI
- If the backend URL itself looks off, check the **Settings** panel in the UI

## 2) Creating and dispatching a task

Where to create:
- Click `+ Create (C)` in the top bar
- That creates a new task in the current project and opens its task panel

What fields matter:
- **Title**: the task name
- **Description**: what the worker should do
- **Status**: usually `Todo` before dispatch
- **Priority**: `No priority`, `Low`, `Medium`, `High`, or `Urgent`
- **Agent assignment / `agent_id`**: the backend now rejects unknown values
  - valid dispatch agent IDs: `guy`, `main`, `hermy`
  - blank is allowed, but if you do set one, it must be one of the three above

What happens when you dispatch:
- Click `Run Task (R)` in the task panel
- You should get a `Run dispatched` toast
- The run panel opens and starts showing the live run

Expected lifecycle:
- `queued` → `claimed` → `running` → `success`
- In the UI, you’ll see it in two places:
  - the task list `Run` column
  - the right-side **Live Run Panel** inside the task detail view

## 3) Watching a run execute

What to watch:
- **Event timeline**: the run’s event list in the right-side panel
- **stdout streaming**: live lines appear as `stdout` events
- **Overview tab**: global activity stream for all runs

How to tell it’s actually running:
- `queued` means the dispatch was accepted but the worker has not claimed it yet
- `claimed` means a worker owns the run
- `running` means OpenClaw is executing
- `success` means the run finished cleanly

What success looks like:
- green `success` badge
- no failure summary
- terminal run result shown in the run panel

What failure looks like:
- red `failed` / `cancelled` badge
- failure summary appears near the top of the run panel
- raw failure logs are available under **Raw failure logs**

## 4) Cancel and retry

**Cancel**
- Button label: `Cancel`
- Location: task panel, next to `Run Task (R)` and `Retry`
- Use it on a queued or running run when you want to stop it
- Expected result: the run becomes `cancelled`

**Retry**
- Button label: `Retry`
- Location: same task panel
- Use it after a failed/cancelled/completed run when you want a fresh attempt
- Expected result: a brand-new queued run is created and the panel switches to it

## 5) When something looks wrong

- **Backend shows unreachable**
  - First check: the Render URL in the UI **Settings** panel
  - Then check `/api/version` from terminal
  - If the browser still disagrees, hit `Reset & Reconnect`

- **Backend shows degraded**
  - First check: `/api/worker/status`
  - Then check the worker launchd service on this Mac
  - If the worker is unhealthy, restart the worker service

- **Run stuck in queued**
  - First check: `/api/worker/status`
  - Make sure the worker is healthy and heartbeating
  - Then check the worker launchd log for claim/probe errors

- **Run fails immediately**
  - First check: the failure summary and raw failure logs in the Live Run Panel
  - Then check the backend and worker logs
  - If the run was accepted but died fast, the worker usually has the reason

- **UI looks stale or weird**
  - Click `Reset & Reconnect`
  - That clears the saved UI state, closes streams, and re-probes the backend

## 6) Running the smoke test manually

Use this command to confirm the whole pipeline is green against Render:

```bash
EXPECTED_SHA=$(git rev-parse HEAD) \
API_BASE=https://mission-control-api-mo8l.onrender.com \
npm run smoke
```

How to read it:
- Success prints a line like:
  - `SMOKE_OK run_id=... sha=... worker=...`
- Failure prints one explicit code, like:
  - `SMOKE_FAIL code=sha_mismatch`
  - `SMOKE_FAIL code=worker_unhealthy`
  - `SMOKE_FAIL code=dispatch_not_queued`
  - `SMOKE_FAIL code=missing_terminal_status`
- If it fails, stop and inspect that code before rerunning

## Cross-reference

If you want the fuller reference, see `README.md`.
This walkthrough is just the operator-facing "click here, expect this, if broken look there" version.
