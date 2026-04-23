#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE_URL = os.getenv('MISSION_CONTROL_BASE_URL', 'https://mission-control-api-mo8l.onrender.com').rstrip('/')
API_TOKEN = os.getenv('MISSION_CONTROL_API_TOKEN') or os.getenv('API_TOKEN') or os.getenv('OPENCLAW_TOKEN') or ''
EXPECTED_SHA = os.getenv('EXPECTED_SHA') or ''
POLL_INTERVAL = float(os.getenv('SMOKE_POLL_INTERVAL', '2'))
POLL_TIMEOUT = float(os.getenv('SMOKE_POLL_TIMEOUT', '120'))
WORKER_MAX_AGE = float(os.getenv('SMOKE_WORKER_MAX_AGE', '90'))
HTTP_TIMEOUT = float(os.getenv('SMOKE_CURL_TIMEOUT', '15'))
TASK_ID = os.getenv('SMOKE_TASK_ID') or f"smoke-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{os.getpid()}"

if not EXPECTED_SHA:
    try:
        EXPECTED_SHA = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    except Exception:
        EXPECTED_SHA = ''


def fail(code: str, message: str) -> None:
    print(f'SMOKE_FAIL code={code} {message}', file=sys.stderr)
    sys.exit(1)


def info(message: str) -> None:
    print(f'SMOKE {message}')


def request(method: str, path: str, body=None, auth: bool = True):
    url = f'{BASE_URL}{path}'
    headers = {'Accept': 'application/json'}
    if auth and API_TOKEN:
        headers['Authorization'] = f'Bearer {API_TOKEN}'
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.getcode(), resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        fail('backend_unreachable', f'{method} {path} failed: {e}')


def parse_json(text: str, code: str):
    try:
        return json.loads(text)
    except Exception as e:
        fail(code, f'Invalid JSON: {e}')


def iso_age_seconds(iso: str) -> float:
    dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
    return (datetime.now(timezone.utc) - dt).total_seconds()


# Version / config
version_code, version_text = request('GET', '/api/version', auth=False)
actual_sha = ''
actual_build_at = ''
if version_code == 200:
    version_data = parse_json(version_text, 'version_parse_error')
    actual_sha = str(version_data.get('git_sha') or '')
    actual_build_at = str(version_data.get('build_at') or '')
elif version_code == 404:
    info('version endpoint missing; falling back to /api/config')
else:
    fail('version_fetch_failed', f'GET /api/version returned HTTP {version_code}')

config_code, config_text = request('GET', '/api/config', auth=False)
if config_code != 200:
    fail('backend_unreachable', f'GET /api/config returned HTTP {config_code}')
config_data = parse_json(config_text, 'config_parse_error')
config_sha = str(config_data.get('git_sha') or '')
config_build_at = str(config_data.get('build_at') or '')
backend_default_model = str(config_data.get('default_model') or 'openai-codex/gpt-5.3-codex')

if not actual_sha:
    actual_sha = config_sha
if not actual_build_at:
    actual_build_at = config_build_at
if not actual_sha:
    fail('sha_unavailable', 'Neither /api/version nor /api/config exposed git_sha')
if EXPECTED_SHA and actual_sha != EXPECTED_SHA:
    fail('sha_mismatch', f'expected {EXPECTED_SHA} but backend reports {actual_sha}')

# Worker health
worker_code, worker_text = request('GET', '/api/worker/status')
if worker_code in (401, 403):
    fail('worker_status_auth_required', 'GET /api/worker/status requires MISSION_CONTROL_API_TOKEN or OPENCLAW_TOKEN')
elif worker_code == 404:
    fail('worker_status_endpoint_missing', 'GET /api/worker/status returned 404')
elif worker_code != 200:
    fail('worker_status_failed', f'GET /api/worker/status returned HTTP {worker_code}')
worker_data = parse_json(worker_text, 'worker_parse_error')
workers = worker_data.get('workers') or []
if not workers:
    fail('worker_unhealthy', 'No workers reported by /api/worker/status')

fresh_worker = None
for worker in workers:
    hb = worker.get('last_heartbeat_at') or ''
    try:
        age = iso_age_seconds(hb)
    except Exception:
        continue
    if age <= WORKER_MAX_AGE:
        fresh_worker = (worker, age)
        break
if not fresh_worker:
    fail('worker_unhealthy', 'Worker heartbeat stale or missing')
worker, worker_age = fresh_worker
if worker.get('healthy') is False:
    fail('worker_unhealthy', f"Worker {worker.get('id') or 'unknown'} reported unhealthy: {worker.get('health_reason') or 'no reason provided'}")
worker_id = worker.get('id')
info(f'worker healthy: {worker_id} age={worker_age:.1f}s')

# Dispatch a run
payload = {
    'task': 'Smoke test for Mission Control',
    'project': 'Mission Control',
    'context': f'Oracle-first smoke test initiated at {TASK_ID}',
    'agent_id': 'guy',
    'model': backend_default_model,
    'related_tasks': [],
    'related_issues': [],
}

dispatch_code, dispatch_text = request('POST', f'/api/tasks/{TASK_ID}/dispatch', body=payload)
if dispatch_code in (401, 403):
    fail('dispatch_auth_required', 'POST /api/tasks/:id/dispatch requires MISSION_CONTROL_API_TOKEN or OPENCLAW_TOKEN')
elif dispatch_code != 202:
    fail('dispatch_failed', f'POST /api/tasks/{TASK_ID}/dispatch returned HTTP {dispatch_code}')
dispatch_data = parse_json(dispatch_text, 'dispatch_parse_error')
run = dispatch_data.get('run') or {}
run_id = str(run.get('id') or '')
run_status = str(run.get('status') or '')
if not run_id:
    fail('dispatch_failed', 'Dispatch response missing run.id')
if run_status != 'queued':
    fail('dispatch_failed', f'Dispatch response run.status expected queued, got {run_status or "empty"}')
if 'worker_message' in run:
    fail('dispatch_failed', 'Dispatch response leaked worker_message')
info(f'dispatched run {run_id}')

# Poll lifecycle
seen = []
end = time.time() + POLL_TIMEOUT
final_run = None
while time.time() < end:
    code, text = request('GET', f'/api/runs/{run_id}')
    if code in (401, 403):
        fail('run_fetch_auth_required', f'GET /api/runs/{run_id} requires auth token')
    if code == 404:
        fail('run_disappeared', f'Run {run_id} disappeared')
    if code != 200:
        fail('run_fetch_failed', f'GET /api/runs/{run_id} returned HTTP {code}')
    data = parse_json(text, 'run_parse_error')
    run_obj = data.get('run') or {}
    status = str(run_obj.get('status') or '')
    if not seen or seen[-1] != status:
        seen.append(status)
        info(f'run {run_id} -> {status}')
    if status in ('queued', 'claimed', 'running'):
        time.sleep(POLL_INTERVAL)
        continue
    final_run = run_obj
    break
else:
    fail('run_never_claimed', f'Run {run_id} did not reach a terminal state within {POLL_TIMEOUT}s (seen={seen})')

final_status = str((final_run or {}).get('status') or '')
if final_status != 'success':
    failure_summary = str((final_run or {}).get('failure_summary') or (final_run or {}).get('error') or 'unknown error')
    fail('run_failed', f'Run {run_id} finished as {final_status or "empty"}: {failure_summary}')
if seen[:1] != ['queued'] or 'running' not in seen:
    fail('run_progression_invalid', f'Unexpected status progression for {run_id}: {seen}')

# Events contract and pagination cap
code, text = request('GET', f'/api/runs/{run_id}/events?limit=5')
if code in (401, 403):
    fail('events_auth_required', f'GET /api/runs/{run_id}/events requires auth token')
elif code == 404:
    fail('events_endpoint_missing', f'GET /api/runs/{run_id}/events returned 404')
elif code != 200:
    fail('events_fetch_failed', f'GET /api/runs/{run_id}/events returned HTTP {code}')
events_data = parse_json(text, 'events_parse_error')
events = events_data.get('events') or []
if len(events) > 5:
    fail('events_pagination_broken', f'events limit not enforced: got {len(events)} items with limit=5')

full_code, full_text = request('GET', f'/api/runs/{run_id}/events?limit=50')
if full_code != 200:
    fail('events_fetch_failed', f'GET /api/runs/{run_id}/events?limit=50 returned HTTP {full_code}')
full_events_data = parse_json(full_text, 'events_parse_error_full')
full_events = full_events_data.get('events') or []
status_events = [e for e in full_events if e.get('type') == 'status']
if not status_events:
    fail('contradictory_state', 'No status events returned for successful run')
last_status = str(status_events[-1].get('payload', {}).get('status') or '')
if last_status != 'success':
    fail('contradictory_state', f'Last status event {last_status} contradicts terminal run status success')

if full_events:
    since_id = str(full_events[0].get('id') or '')
    if since_id:
        since_code, since_text = request('GET', f'/api/runs/{run_id}/events?since={since_id}&limit=50')
        if since_code != 200:
            fail('events_fetch_failed', f'GET /api/runs/{run_id}/events?since=... returned HTTP {since_code}')
        since_events_data = parse_json(since_text, 'events_parse_error_since')
        since_events = since_events_data.get('events') or []
        if any(str(evt.get('id') or '') == since_id for evt in since_events):
            fail('events_since_broken', 'events?since did not exclude the anchor event')

# Duplicate terminal write rejection must be explicit.
complete_payload = {'worker_id': worker_id, 'status': 'success', 'result': final_run.get('result')}
complete_code, complete_text = request('POST', f'/api/worker/runs/{run_id}/complete', body=complete_payload)
if complete_code != 409:
    fail('duplicate_terminal_write_not_rejected', f'Second completion returned HTTP {complete_code} instead of 409')
complete_data = parse_json(complete_text, 'duplicate_complete_parse_error') if complete_text.strip() else {}
complete_err = str(complete_data.get('code') or complete_data.get('error') or '')
if complete_err and 'run_terminal_conflict' not in complete_err and 'already finalized' not in complete_err:
    fail('duplicate_terminal_write_not_rejected', f'Second completion rejected with unexpected error: {complete_err}')

print(f'SMOKE_OK run_id={run_id} sha={actual_sha} build_at={actual_build_at or "unknown"} worker={worker_id}')
PY
