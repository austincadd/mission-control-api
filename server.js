import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'runs.json');

const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || 'openai-codex/gpt-5.3-codex').replace(/^openai-coded\//, 'openai-codex/');
const AUTO_TRANSITION_IN_PROGRESS = (process.env.AUTO_TRANSITION_IN_PROGRESS || 'true') === 'true';
const AUTO_TRANSITION_DONE = (process.env.AUTO_TRANSITION_DONE || 'true') === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://austincaddell.dev')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const API_TOKEN = process.env.MISSION_CONTROL_API_TOKEN || process.env.OPENCLAW_TOKEN || '';
const WORKER_TOKEN = process.env.MISSION_CONTROL_WORKER_TOKEN || API_TOKEN || process.env.OPENCLAW_TOKEN || '';
const WORKER_CLAIM_TTL_MS = Number(process.env.WORKER_CLAIM_TTL_MS || 30_000);
const WORKER_HEARTBEAT_TTL_MS = Number(process.env.WORKER_HEARTBEAT_TTL_MS || 60_000);
const WORKER_HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15_000);
const WORKER_SWEEP_INTERVAL_MS = Number(process.env.WORKER_SWEEP_INTERVAL_MS || 5_000);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function uid(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`;
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function nowMs() {
  return Date.now();
}

function parseTime(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function readOptionalTextFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function getBuildMetadata() {
  const gitSha =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_SHA ||
    readOptionalTextFile(path.join(__dirname, '.git-sha')) ||
    'unknown';
  const buildAt =
    process.env.RENDER_BUILD_TIMESTAMP ||
    process.env.BUILD_AT ||
    readOptionalTextFile(path.join(__dirname, '.build-at')) ||
    null;
  return { git_sha: gitSha, build_at: buildAt };
}

function isTerminalStatus(status) {
  return ['success', 'failed', 'cancelled'].includes(status);
}

function ensureDbShape(db) {
  const out = { ...(db || {}) };
  out.runs = Array.isArray(out.runs) ? out.runs : [];
  out.events = Array.isArray(out.events) ? out.events : [];
  out.workers = out.workers && typeof out.workers === 'object' && !Array.isArray(out.workers) ? out.workers : {};
  return out;
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seededRunId = uid('run_');
    const seeded = ensureDbShape({
      runs: [
        {
          id: seededRunId,
          task_id: 'demo-task',
          agent_id: 'demo-agent',
          status: 'success',
          model: DEFAULT_MODEL,
          started_at: iso(nowMs() - 12 * 60_000),
          ended_at: iso(nowMs() - 10 * 60_000),
          input_tokens: 412,
          output_tokens: 1034,
          cost_estimate: 0.0112,
          error: null,
          source: 'seed',
          dispatch_context: {
            task: 'Seeded demo task',
            project: 'Mission Control',
            context: 'Seed data created on first launch',
            related_tasks: [],
            related_issues: [],
            agent: 'demo-agent'
          },
          claim_deadline_at: null,
          claimed_at: null,
          worker_id: null,
          heartbeat_at: null,
          running_at: null,
          result: { summary: 'Seeded success run' }
        }
      ],
      events: [
        { id: uid('evt_'), run_id: seededRunId, timestamp: iso(nowMs() - 12 * 60_000), type: 'status', payload: { status: 'queued' }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: iso(nowMs() - 11.5 * 60_000), type: 'message', payload: { text: 'Starting analysis pass' }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: iso(nowMs() - 11 * 60_000), type: 'tool_call', payload: { tool: 'read', args: { path: 'index.html' } }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: iso(nowMs() - 10.7 * 60_000), type: 'tool_result', payload: { ok: true, bytes: 8042 }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: iso(nowMs() - 10.2 * 60_000), type: 'status', payload: { status: 'success' }, level: 'info' }
      ],
      workers: {}
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));
    return seeded;
  }

  try {
    return ensureDbShape(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch {
    return ensureDbShape({ runs: [], events: [], workers: {} });
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(ensureDbShape(db), null, 2));
}

function getEventsForRun(db, runId) {
  return db.events.filter(e => e.run_id === runId).sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

function getRun(db, runId) {
  return db.runs.find(r => r.id === runId) || null;
}

function updateRun(db, runId, patch) {
  const run = getRun(db, runId);
  if (!run) return null;
  Object.assign(run, patch);
  writeDb(db);
  return run;
}

function summaryFromText(text) {
  if (!text) return null;
  return String(text).trim().split(/\r?\n/).find(Boolean)?.slice(0, 220) || null;
}

function computeFailureSummary(run, events) {
  if (!run || run.status === 'success') return null;
  if (run.failure_summary) return run.failure_summary;

  const ordered = (events || []).slice().sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const lastError = ordered.filter(e => e.type === 'error').at(-1);
  const lastStderr = ordered.filter(e => e.type === 'stdout' && e?.payload?.stream === 'stderr').at(-1);
  const lastStdout = ordered.filter(e => e.type === 'stdout' && e?.payload?.stream === 'stdout').at(-1);

  return (
    summaryFromText(lastError?.payload?.message) ||
    summaryFromText(lastStderr?.payload?.line) ||
    summaryFromText(lastStdout?.payload?.line) ||
    summaryFromText(run.error) ||
    (run.status === 'failed' ? 'Run failed without explicit upstream error detail.' : null)
  );
}

function compactRun(run, events = null) {
  const resolvedEvents = events || getEventsForRun(readDb(), run.id);
  return {
    id: run.id,
    task_id: run.task_id,
    agent_id: run.agent_id || null,
    status: run.status,
    model: run.model || DEFAULT_MODEL,
    source: run.source || null,
    started_at: run.started_at || null,
    ended_at: run.ended_at || null,
    input_tokens: typeof run.input_tokens === 'number' ? run.input_tokens : 0,
    output_tokens: typeof run.output_tokens === 'number' ? run.output_tokens : 0,
    cost_estimate: typeof run.cost_estimate === 'number' ? run.cost_estimate : 0,
    error: run.error || null,
    failure_summary: computeFailureSummary(run, resolvedEvents),
    claim_deadline_at: run.claim_deadline_at || null,
    claimed_at: run.claimed_at || null,
    worker_id: run.worker_id || null,
    running_at: run.running_at || null,
    heartbeat_at: run.heartbeat_at || null,
    result: run.result ?? null,
    cancel_requested_at: run.cancel_requested_at || null,
    cancel_acknowledged_at: run.cancel_acknowledged_at || null,
    retried_from: run.retried_from || null
  };
}

const KNOWN_DISPATCH_AGENT_IDS = new Set(['guy', 'main', 'hermy']);

function buildDispatchContext(body = {}) {
  return {
    task: body.task ?? null,
    project: body.project ?? null,
    context: body.context ?? null,
    related_tasks: Array.isArray(body.related_tasks) ? body.related_tasks : [],
    related_issues: Array.isArray(body.related_issues) ? body.related_issues : [],
    agent: body.agent || (body.agent_id ? { id: body.agent_id } : null)
  };
}

function extractRequestedAgentId(body = {}, fallback = null) {
  const raw = body.agent_id ?? body?.agent?.id ?? body.agent ?? fallback;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value || null;
}

function validateKnownDispatchAgentId(agentId) {
  if (!agentId) return { ok: true, normalized: null };
  const normalized = agentId.toLowerCase();
  if (!KNOWN_DISPATCH_AGENT_IDS.has(normalized)) {
    return {
      ok: false,
      status: 400,
      code: 'unknown_agent',
      error: `Unknown agent_id: ${agentId}`,
      agent_id: agentId
    };
  }
  return { ok: true, normalized };
}

function normalizeOpenClawAgentId(agentId) {
  const value = String(agentId || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'guy' || value === 'main') return 'main';
  if (value === 'hermy') return 'hermy';
  return null;
}

function buildWorkerMessage(run) {
  const dispatchContext = run.dispatch_context || {};
  return [
    `Mission Control run_id: ${run.id}`,
    `Task ID: ${run.task_id}`,
    `Requested model: ${run.model}`,
    `Assigned agent: ${run.agent_id || 'default'}`,
    '',
    'Task payload:',
    JSON.stringify({
      task: dispatchContext.task ?? null,
      project: dispatchContext.project ?? null,
      related_tasks: dispatchContext.related_tasks ?? [],
      related_issues: dispatchContext.related_issues ?? [],
      context: dispatchContext.context ?? null
    }, null, 2)
  ].join('\n');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return true;
  } catch {
    // ignore
  }
  return ALLOWED_ORIGINS.includes(origin);
}

function sendSse(res, event, data, id) {
  if (id) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const sseRunClients = new Map();
const sseActivityClients = new Set();

function sanitizeEventForActivity(evt) {
  if (!evt) return evt;
  if (evt.type === 'message') {
    return {
      ...evt,
      payload: {
        text: evt?.payload?.text || '',
        adapter: evt?.payload?.adapter || undefined,
        assigned_agent: evt?.payload?.assigned_agent || undefined
      }
    };
  }
  if (evt.type === 'stdout') {
    return {
      ...evt,
      payload: {
        stream: evt?.payload?.stream,
        line: String(evt?.payload?.line || '').slice(0, 200)
      }
    };
  }
  return evt;
}

function addEvent(db, runId, type, payload = {}, level = 'info') {
  const evt = { id: uid('evt_'), run_id: runId, timestamp: iso(), type, payload, level };
  db.events.push(evt);
  writeDb(db);

  const runClients = sseRunClients.get(runId) || new Set();
  for (const res of runClients) sendSse(res, 'run_event', evt, evt.id);
  for (const res of sseActivityClients) sendSse(res, 'activity', sanitizeEventForActivity(evt), evt.id);

  return evt;
}

function authGuard(token, label) {
  return (req, res, next) => {
    if (!token) return next();
    const hdr = req.get('authorization') || '';
    const queryToken = req.query?.token ? String(req.query.token) : '';
    if (hdr === `Bearer ${token}` || queryToken === token) return next();
    return res.status(401).json({ error: `Unauthorized ${label}` });
  };
}

function chooseClaimableRun(db, now = nowMs()) {
  return db.runs
    .slice()
    .sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''))
    .find(run => run.status === 'queued' && (!run.claim_deadline_at || parseTime(run.claim_deadline_at) > now) && !isTerminalStatus(run.status))
    || null;
}

function finalizeRunOnce(db, runId, status, details = {}) {
  const run = getRun(db, runId);
  if (!run) return null;

  if (!isTerminalStatus(status)) {
    const err = new Error('terminal status must be success, failed, or cancelled');
    err.status = 400;
    err.code = 'invalid_terminal_status';
    throw err;
  }

  if (isTerminalStatus(run.status)) {
    const err = new Error(`run already finalized as ${run.status}`);
    err.status = 409;
    err.code = 'run_terminal_conflict';
    err.run_status = run.status;
    throw err;
  }

  const patch = {
    status,
    ended_at: iso(),
    error: details.error ?? null,
    result: details.result ?? run.result ?? null,
    worker_id: details.worker_id ?? run.worker_id ?? null,
    heartbeat_at: details.heartbeat_at ?? run.heartbeat_at ?? null,
    running_at: run.running_at || details.running_at || null,
    claimed_at: run.claimed_at || details.claimed_at || null,
    failure_summary: details.failure_summary ?? (status === 'success' ? null : run.failure_summary || details.error || null)
  };

  if (status === 'cancelled') {
    patch.error = null;
    patch.failure_summary = null;
  }

  Object.assign(run, patch);
  writeDb(db);
  return run;
}

function applyWorkerEvent(db, run, event) {
  if (!event || !event.type) return null;

  const type = String(event.type);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const level = event.level || (type === 'error' ? 'error' : 'info');
  const evt = addEvent(db, run.id, type, payload, level);

  if (type === 'status') {
    const nextStatus = String(payload.status || '').trim();
    if (nextStatus === 'running') {
      updateRun(db, run.id, {
        status: 'running',
        running_at: run.running_at || iso(),
        worker_id: run.worker_id || event.worker_id || run.worker_id,
        heartbeat_at: iso(),
        error: null
      });
    } else if (nextStatus === 'claimed') {
      updateRun(db, run.id, {
        status: 'claimed',
        claimed_at: run.claimed_at || iso(),
        worker_id: run.worker_id || event.worker_id || run.worker_id,
        heartbeat_at: iso()
      });
    } else if (nextStatus === 'success' || nextStatus === 'failed' || nextStatus === 'cancelled') {
      finalizeRunOnce(db, run.id, nextStatus, {
        error: payload.error || null,
        result: payload.result || null,
        worker_id: run.worker_id || event.worker_id || run.worker_id,
        heartbeat_at: iso()
      });
    }
  }

  if (type === 'error') {
    updateRun(db, run.id, { error: payload.message || run.error || 'Worker reported error' });
  }

  if (type === 'tool_result' && payload && typeof payload === 'object') {
    updateRun(db, run.id, { result: payload.result || payload });
  }

  return evt;
}

function failRunForWorkerIssue(db, run, reason, status = 'failed') {
  if (!run || isTerminalStatus(run.status)) return null;
  updateRun(db, run.id, {
    status,
    ended_at: iso(),
    error: reason,
    failure_summary: reason
  });
  addEvent(db, run.id, 'error', { message: reason }, 'error');
  addEvent(db, run.id, 'status', { status }, status === 'cancelled' ? 'warn' : 'error');
  return getRun(db, run.id);
}

function getWorker(db, workerId) {
  return db.workers[workerId] || null;
}

function upsertWorker(db, workerId, patch = {}) {
  const current = db.workers[workerId] || { id: workerId, connected_at: iso(), last_heartbeat_at: null };
  db.workers[workerId] = {
    ...current,
    ...patch,
    id: workerId,
    updated_at: iso()
  };
  writeDb(db);
  return db.workers[workerId];
}

function listCancelledRunsForWorker(db, workerId) {
  return db.runs
    .filter(run => run.worker_id === workerId && run.status === 'cancelled' && !run.cancel_acknowledged_at)
    .map(run => run.id);
}

function sweepStaleRuns() {
  const db = readDb();
  const now = nowMs();
  let changed = false;

  for (const run of db.runs) {
    if (run.status === 'queued' && run.claim_deadline_at && parseTime(run.claim_deadline_at) <= now) {
      failRunForWorkerIssue(db, run, 'no_worker_available', 'failed');
      changed = true;
      continue;
    }

    if ((run.status === 'claimed' || run.status === 'running') && run.worker_id) {
      const worker = getWorker(db, run.worker_id);
      const lastHeartbeat = parseTime(worker?.last_heartbeat_at || run.heartbeat_at || run.claimed_at || run.started_at);
      if (!lastHeartbeat) continue;
      if (now - lastHeartbeat > WORKER_HEARTBEAT_TTL_MS) {
        failRunForWorkerIssue(db, run, 'worker_disconnected', 'failed');
        changed = true;
      }
    }
  }

  if (changed) writeDb(db);
}

if (!fs.existsSync(DB_FILE)) readDb();
setInterval(sweepStaleRuns, WORKER_SWEEP_INTERVAL_MS).unref();

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin || isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Worker-Id']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const requireApiAuth = authGuard(API_TOKEN, 'API');
const requireWorkerAuth = authGuard(WORKER_TOKEN, 'worker');

app.get('/api/config', (req, res) => {
  const build = getBuildMetadata();
  res.json({
    gateway_url: 'worker-protocol',
    auth_token_present: Boolean(API_TOKEN),
    worker_token_present: Boolean(WORKER_TOKEN),
    execution_mode: 'worker-protocol',
    default_model: DEFAULT_MODEL,
    git_sha: build.git_sha,
    build_at: build.build_at,
    toggles: {
      auto_transition_in_progress: AUTO_TRANSITION_IN_PROGRESS,
      auto_transition_done: AUTO_TRANSITION_DONE
    },
    worker_protocol: {
      claim_ttl_ms: WORKER_CLAIM_TTL_MS,
      heartbeat_interval_ms: WORKER_HEARTBEAT_INTERVAL_MS,
      heartbeat_ttl_ms: WORKER_HEARTBEAT_TTL_MS
    }
  });
});

app.get('/api/version', (req, res) => {
  const build = getBuildMetadata();
  res.json({
    service: 'mission-control',
    git_sha: build.git_sha,
    build_at: build.build_at
  });
});

app.post('/api/tasks/:id/dispatch', requireApiAuth, async (req, res) => {
  const requestedAgentId = extractRequestedAgentId(req.body);
  const agentValidation = validateKnownDispatchAgentId(requestedAgentId);
  if (!agentValidation.ok) {
    return res.status(agentValidation.status).json({
      error: agentValidation.error,
      code: agentValidation.code,
      agent_id: agentValidation.agent_id
    });
  }

  const db = readDb();
  const taskId = req.params.id;
  const active = db.runs.find(r => r.task_id === taskId && !isTerminalStatus(r.status));
  if (active) return res.status(409).json({ error: 'Task already has an active run', active_run_id: active.id });

  const dispatchContext = buildDispatchContext(req.body);
  const run = {
    id: uid('run_'),
    task_id: taskId,
    agent_id: requestedAgentId,
    status: 'queued',
    model: req.body.model || DEFAULT_MODEL,
    started_at: iso(),
    ended_at: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_estimate: 0,
    error: null,
    failure_summary: null,
    source: 'dispatch',
    dispatch_context: dispatchContext,
    worker_message: '',
    claim_deadline_at: iso(nowMs() + WORKER_CLAIM_TTL_MS),
    claimed_at: null,
    worker_id: null,
    running_at: null,
    heartbeat_at: null,
    result: null,
    cancel_requested_at: null,
    cancel_acknowledged_at: null
  };
  run.worker_message = buildWorkerMessage(run);

  db.runs.unshift(run);
  writeDb(db);

  addEvent(db, run.id, 'status', { status: 'queued', auto_transition_in_progress: AUTO_TRANSITION_IN_PROGRESS });
  addEvent(db, run.id, 'message', {
    text: 'Dispatch accepted',
    context: dispatchContext
  });

  res.status(202).json({ run: compactRun(run, getEventsForRun(db, run.id)) });
});

app.post('/api/runs/:run_id/cancel', requireApiAuth, async (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (isTerminalStatus(run.status)) return res.status(409).json({ error: `Cannot cancel run in status ${run.status}` });

  updateRun(db, run.id, {
    status: 'cancelled',
    ended_at: iso(),
    error: null,
    failure_summary: null,
    cancel_requested_at: iso(),
    cancel_acknowledged_at: run.cancel_acknowledged_at || null
  });
  addEvent(db, run.id, 'status', { status: 'cancelled' }, 'warn');
  res.json({ ok: true, run_id: run.id });
});

app.post('/api/runs/:run_id/retry', requireApiAuth, async (req, res) => {
  const db = readDb();
  const prev = getRun(db, req.params.run_id);
  if (!prev) return res.status(404).json({ error: 'Run not found' });

  const requestedAgentId = extractRequestedAgentId(req.body, prev.agent_id);
  const agentValidation = validateKnownDispatchAgentId(requestedAgentId);
  if (!agentValidation.ok) {
    return res.status(agentValidation.status).json({
      error: agentValidation.error,
      code: agentValidation.code,
      agent_id: agentValidation.agent_id
    });
  }

  const active = db.runs.find(r => r.task_id === prev.task_id && !isTerminalStatus(r.status));
  if (active) return res.status(409).json({ error: 'Task already has an active run', active_run_id: active.id });

  const dispatchContext = buildDispatchContext(req.body);
  const run = {
    id: uid('run_'),
    task_id: prev.task_id,
    agent_id: requestedAgentId,
    status: 'queued',
    model: req.body.model || prev.model || DEFAULT_MODEL,
    started_at: iso(),
    ended_at: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_estimate: 0,
    error: null,
    failure_summary: null,
    source: 'retry',
    dispatch_context,
    worker_message: '',
    claim_deadline_at: iso(nowMs() + WORKER_CLAIM_TTL_MS),
    claimed_at: null,
    worker_id: null,
    running_at: null,
    heartbeat_at: null,
    result: null,
    cancel_requested_at: null,
    cancel_acknowledged_at: null,
    retried_from: prev.id
  };
  run.worker_message = buildWorkerMessage(run);

  db.runs.unshift(run);
  writeDb(db);
  addEvent(db, run.id, 'status', { status: 'queued', retried_from: prev.id });
  addEvent(db, run.id, 'message', { text: 'Retry requested', previous_run_id: prev.id });

  res.status(202).json({ run: compactRun(run, getEventsForRun(db, run.id)), retried_from: prev.id });
});

app.get('/api/runs/:run_id', requireApiAuth, (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const events = getEventsForRun(db, run.id);
  res.json({ run: compactRun(run, events), events });
});

app.get('/api/runs/:run_id/events', requireApiAuth, (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const allEvents = getEventsForRun(db, run.id);
  const since = req.query.since ? String(req.query.since) : null;
  const limitRaw = Number.parseInt(String(req.query.limit || '500'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 500;

  let events = allEvents;
  if (since) {
    const idx = allEvents.findIndex(evt => evt.id === since);
    events = idx >= 0 ? allEvents.slice(idx + 1) : allEvents;
  }

  res.json({
    run: compactRun(run, allEvents),
    events: events.slice(-limit),
    total_events: allEvents.length,
    limit,
    since
  });
});

app.get('/api/tasks/:id/runs', requireApiAuth, (req, res) => {
  const db = readDb();
  const runs = db.runs
    .filter(r => r.task_id === req.params.id)
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
    .map(run => compactRun(run, getEventsForRun(db, run.id)));
  res.json({ runs });
});

app.get('/api/runs/:run_id/stream', requireApiAuth, (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const lastId = req.header('Last-Event-ID') || req.query.lastEventId;
  const events = getEventsForRun(db, run.id);
  let replay = events;
  if (lastId) {
    const idx = events.findIndex(e => e.id === lastId);
    replay = idx >= 0 ? events.slice(idx + 1) : events;
  }
  replay.forEach(evt => sendSse(res, 'run_event', evt, evt.id));
  sendSse(res, 'run_snapshot', { run: compactRun(run, events) }, `snap_${Date.now()}`);

  const set = sseRunClients.get(run.id) || new Set();
  set.add(res);
  sseRunClients.set(run.id, set);

  const ping = setInterval(() => sendSse(res, 'ping', { t: Date.now() }, `ping_${Date.now()}`), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    const curr = sseRunClients.get(run.id);
    if (!curr) return;
    curr.delete(res);
  });
});

app.get('/api/activity/stream', requireApiAuth, (req, res) => {
  const db = readDb();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const lastId = req.header('Last-Event-ID') || req.query.lastEventId;
  const events = db.events.slice().sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  let replay = events.slice(-40);
  if (lastId) {
    const idx = events.findIndex(e => e.id === lastId);
    replay = idx >= 0 ? events.slice(idx + 1) : replay;
  }
  replay.forEach(evt => sendSse(res, 'activity', sanitizeEventForActivity(evt), evt.id));

  sseActivityClients.add(res);
  const ping = setInterval(() => sendSse(res, 'ping', { t: Date.now() }, `ping_${Date.now()}`), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    sseActivityClients.delete(res);
  });
});

app.post('/api/worker/claim', requireWorkerAuth, (req, res) => {
  const db = readDb();
  const workerId = String(req.body?.worker_id || req.get('x-worker-id') || '').trim();
  if (!workerId) return res.status(400).json({ error: 'worker_id is required' });

  const now = nowMs();
  const run = chooseClaimableRun(db, now);
  if (!run) {
    upsertWorker(db, workerId, {
      last_heartbeat_at: iso(now),
      last_seen_at: iso(now),
      last_claim_at: null,
      current_run_id: null,
      host: req.body?.host || null,
      pid: req.body?.pid || null,
      healthy: typeof req.body?.healthy === 'boolean' ? req.body.healthy : true,
      health_reason: req.body?.health_reason || null
    });
    return res.status(204).end();
  }

  updateRun(db, run.id, {
    status: 'claimed',
    claimed_at: iso(now),
    worker_id: workerId,
    heartbeat_at: iso(now),
    claim_deadline_at: null
  });
  upsertWorker(db, workerId, {
    last_heartbeat_at: iso(now),
    last_seen_at: iso(now),
    last_claim_at: iso(now),
    current_run_id: run.id,
    host: req.body?.host || null,
    pid: req.body?.pid || null
  });
  addEvent(db, run.id, 'status', { status: 'claimed', worker_id: workerId }, 'info');
  addEvent(db, run.id, 'message', { text: 'Run claimed by worker', worker_id: workerId });

  const refreshed = getRun(db, run.id);
  const workerMessage = refreshed.worker_message || buildWorkerMessage(refreshed);
  const normalizedAgent = normalizeOpenClawAgentId(refreshed.agent_id) || normalizeOpenClawAgentId(OPENCLAW_DEFAULT_AGENT);
  res.json({
    run: compactRun(refreshed, getEventsForRun(db, run.id)),
    worker_message: workerMessage,
    openclaw_args: ['agent', '--json', '--session-id', refreshed.id, '--message', workerMessage, ...(normalizedAgent ? ['--agent', normalizedAgent] : [])],
    claim_ttl_ms: WORKER_CLAIM_TTL_MS,
    heartbeat_interval_ms: WORKER_HEARTBEAT_INTERVAL_MS
  });
});

app.post('/api/worker/runs/:run_id/events', requireWorkerAuth, (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const workerId = String(req.body?.worker_id || req.get('x-worker-id') || run.worker_id || '').trim();
  if (workerId && run.worker_id && workerId !== run.worker_id) {
    return res.status(409).json({ error: 'Run is owned by another worker' });
  }
  if (workerId && !run.worker_id) updateRun(db, run.id, { worker_id: workerId });

  const events = Array.isArray(req.body?.events)
    ? req.body.events
    : req.body?.event
      ? [req.body.event]
      : [{ type: req.body?.type, payload: req.body?.payload, level: req.body?.level }];

  const accepted = [];
  try {
    for (const evt of events) {
      if (!evt || !evt.type) continue;
      accepted.push(applyWorkerEvent(db, getRun(db, run.id), { ...evt, worker_id: workerId || run.worker_id || null }));
    }
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Worker event rejected',
      code: err.code || 'worker_event_rejected',
      run_status: err.run_status || null
    });
  }

  updateRun(db, run.id, { heartbeat_at: iso() });
  res.json({ ok: true, accepted: accepted.filter(Boolean).length });
});

app.post('/api/worker/runs/:run_id/complete', requireWorkerAuth, (req, res) => {
  const db = readDb();
  const run = getRun(db, req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const workerId = String(req.body?.worker_id || req.get('x-worker-id') || run.worker_id || '').trim();
  if (workerId && run.worker_id && workerId !== run.worker_id) {
    return res.status(409).json({ error: 'Run is owned by another worker' });
  }
  if (workerId && !run.worker_id) updateRun(db, run.id, { worker_id: workerId });

  const status = String(req.body?.status || 'success').trim();
  if (!['success', 'failed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status must be success, failed, or cancelled' });
  }

  const finalStatus = run.status === 'cancelled' ? 'cancelled' : status;
  const result = req.body?.result ?? null;
  const error = req.body?.error ?? null;
  const summary = req.body?.summary ?? null;
  const metrics = req.body?.metrics ?? null;

  if (metrics && typeof metrics === 'object') {
    updateRun(db, run.id, {
      input_tokens: typeof metrics.input_tokens === 'number' ? metrics.input_tokens : run.input_tokens,
      output_tokens: typeof metrics.output_tokens === 'number' ? metrics.output_tokens : run.output_tokens,
      cost_estimate: typeof metrics.cost_estimate === 'number' ? metrics.cost_estimate : run.cost_estimate
    });
  }

  if (result !== null) updateRun(db, run.id, { result });
  if (finalStatus === 'failed' || error) updateRun(db, run.id, { error: error || run.error || null, failure_summary: summary || error || run.failure_summary || null });

  try {
    finalizeRunOnce(db, run.id, finalStatus, {
      error: finalStatus === 'failed' ? (error || summary || 'Worker reported failure') : null,
      result,
      worker_id: workerId || run.worker_id || null,
      heartbeat_at: iso(),
      failure_summary: summary || error || null
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Run completion rejected',
      code: err.code || 'run_completion_rejected',
      run_status: err.run_status || null
    });
  }

  addEvent(db, run.id, 'status', { status: finalStatus, worker_id: workerId || run.worker_id || null }, finalStatus === 'success' ? 'info' : 'warn');
  if (result !== null) {
    addEvent(db, run.id, 'tool_result', { ok: finalStatus === 'success', result }, finalStatus === 'success' ? 'info' : 'warn');
  }
  if (error) {
    addEvent(db, run.id, 'error', { message: error }, 'error');
  }

  const worker = workerId ? getWorker(db, workerId) : null;
  if (worker) {
    db.workers[workerId] = {
      ...worker,
      current_run_id: worker.current_run_id === run.id ? null : worker.current_run_id,
      last_heartbeat_at: iso(),
      updated_at: iso()
    };
    writeDb(db);
  }

  res.json({ ok: true, run_id: run.id, status: finalStatus });
});

app.post('/api/worker/heartbeat', requireWorkerAuth, (req, res) => {
  const db = readDb();
  const workerId = String(req.body?.worker_id || req.get('x-worker-id') || '').trim();
  if (!workerId) return res.status(400).json({ error: 'worker_id is required' });

  const heartbeatAt = iso();
  const currentRunId = req.body?.current_run_id || null;
  const host = req.body?.host || null;
  const pid = req.body?.pid || null;
  const worker = upsertWorker(db, workerId, {
    last_heartbeat_at: heartbeatAt,
    last_seen_at: heartbeatAt,
    current_run_id: currentRunId,
    host,
    pid,
    healthy: typeof req.body?.healthy === 'boolean' ? req.body.healthy : true,
    health_reason: req.body?.health_reason || null
  });

  const cancelled_run_ids = listCancelledRunsForWorker(db, workerId);
  res.json({
    ok: true,
    worker,
    cancelled_run_ids,
    heartbeat_interval_ms: WORKER_HEARTBEAT_INTERVAL_MS,
    heartbeat_ttl_ms: WORKER_HEARTBEAT_TTL_MS
  });
});

app.get('/api/worker/status', requireWorkerAuth, (req, res) => {
  const db = readDb();
  const workers = Object.values(db.workers).sort((a, b) => (b.last_heartbeat_at || '').localeCompare(a.last_heartbeat_at || ''));
  res.json({ workers });
});

app.listen(PORT, () => {
  console.log(`mission-control backend running at http://localhost:${PORT}`);
});
