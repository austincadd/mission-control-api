# Deferred followups

This file tracks known gaps that were deliberately deferred in the recent audit + fix cycle, not bugs to be hidden. Each item should eventually be either fixed or explicitly closed with reasoning.

## 1. Auth plumbing coded but not deployed
- **Description:** Server auth guard exists and the worker sends bearer tokens, but the live Render config still reports `auth_token_present: false` and `worker_token_present: false`.
- **Reference:** `server.js:302-309`, `worker.js:29-33`
- **Why deferred:** Deliberate for pre-launch; the change was left out of this changeset.
- **Priority:** medium (before any public exposure)

## 2. Worker shutdown doesn’t finalize in-flight runs
- **Description:** On `SIGINT`/`SIGTERM`, the worker kills the child process and exits without posting a terminal event or calling `/complete`. Runs can linger in `running` until the heartbeat TTL expires.
- **Reference:** `worker.js:333-349`
- **Why deferred:** The sweeper already handles eventual cleanup, so this was left for a later pass.
- **Priority:** low

## 3. No startup reconciliation on backend restart
- **Description:** `sweepStaleRuns` is the only recovery path. A restarted backend does not actively reattach to in-flight runs; it waits for the TTL sweep.
- **Reference:** `server.js:442-469`
- **Why deferred:** Existing stale-run sweep was considered sufficient for this cycle.
- **Priority:** low

## 4. Queued-run “no worker available” failure isn’t immediate
- **Description:** The claim TTL is set at dispatch, but the failure only surfaces on the sweeper tick. Users see a delay before “no worker” appears.
- **Reference:** `server.js:447-451`
- **Why deferred:** This was not changed in the audit/fix scope.
- **Priority:** low

## 5. BUILD_AT env var not set in Render
- **Description:** Smoke output consistently shows `build_at=unknown`. The SHA is enough to identify the deploy, but a timestamp would help distinguish redeploys of the same commit.
- **Reference:** Smoke output / deploy metadata path in the runtime
- **Why deferred:** SHA-based deploy identification was sufficient for this cycle.
- **Priority:** low

## 6. Frontend allows dispatch while worker is degraded
- **Description:** `dispatchTask` queues runs regardless of probe state.
- **Reference:** `index.html:329-337`
- **Why deferred:** Runs should fail loudly once Fix 4’s real probe rejects unhealthy workers, so this was left as-is.
- **Priority:** low

## 7. SSE connections don’t use gateway fallback candidates
- **Description:** `connectRunStream` and `connectActivity` use only `state.settings.gatewayUrl`, unlike `api.req`, which tries fallbacks. Stale config can cause brief SSE disconnects until `probeGateway` repairs state.
- **Reference:** `index.html:211-229`
- **Why deferred:** The fallback logic already exists for API requests; SSE handling was not expanded in this cycle.
- **Priority:** low

## 8. Frontend deploys are manual with no git sync
- **Description:** The frontend lives at `/home2/cvywazmy/public_html/website_c88a201b/mission-control/index.html` on Bluehost and is updated via manual SCP. There is no CI, no automated deploy, and no check that the live file matches the repo’s `index.html`. If someone (or you, months from now) commits frontend changes and forgets to SCP, the repo will show the fix as shipped but the live site won’t have it — and there’s no alerting for the drift.
- **Reference:** Live Bluehost deployment path and manual upload workflow
- **Why deferred:** Operational landmine, but not actively broken.
- **Realized on 2026-04-24:** This gap caused a live-site failure. The deployed `health-proxy.php` on Bluehost was an older version than the repo (hardcoded `/api/config`, ignored the `path` param), and `.htaccess` was missing entirely. Symptoms were `Backend: degraded` on the live site, `/mission-control/api/*` returning portfolio HTML, and CSP blocking Render SSE. Fixed by redeploying the proxy and adding `.htaccess` back.
- **Future fixes to note:**
  - Add a `tools/deploy-frontend.sh` script that SCPs the current repo `index.html` and logs the SHA to a deploy manifest
  - Or add a `/frontend-version` meta tag to `index.html` that the backend’s smoke test or a separate check could compare against repo HEAD
  - Or migrate frontend to a platform with git-based deploys (Netlify, Cloudflare Pages, Render static site) if that fits the project
- **Priority:** medium-high
