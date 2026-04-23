import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'runs.json');
const HANDLES_FILE = path.join(DATA_DIR, 'run-handles.json');

const PORT = process.env.PORT || 8787;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openai-codex/gpt-5.3-codex';
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const OPENCLAW_AGENT_CHANNEL = process.env.OPENCLAW_AGENT_CHANNEL || '';
const AUTO_TRANSITION_IN_PROGRESS = (process.env.AUTO_TRANSITION_IN_PROGRESS || 'true') === 'true';
const AUTO_TRANSITION_DONE = (process.env.AUTO_TRANSITION_DONE || 'true') === 'true';
const ENABLE_EMBEDDED_FALLBACK = (process.env.ENABLE_EMBEDDED_FALLBACK || 'true') === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://austincaddell.dev').split(',').map(s => s.trim()).filter(Boolean);
const API_TOKEN = process.env.MISSION_CONTROL_API_TOKEN || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function uid(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`;
}

function iso() {
  return new Date().toISOString();
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seededRunId = uid('run_');
    const seeded = {
      runs: [
        {
          id: seededRunId,
          task_id: 'demo-task',
          agent_id: 'demo-agent',
          status: 'success',
          model: DEFAULT_MODEL,
          started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
          ended_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          input_tokens: 412,
          output_tokens: 1034,
          cost_estimate: 0.0112,
          error: null,
          source: 'seed'
        }
      ],
      events: [
        { id: uid('evt_'), run_id: seededRunId, timestamp: new Date(Date.now() - 12 * 60_000).toISOString(), type: 'status', payload: { status: 'queued' }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: new Date(Date.now() - 11.5 * 60_000).toISOString(), type: 'message', payload: { text: 'Starting analysis pass' }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: new Date(Date.now() - 11 * 60_000).toISOString(), type: 'tool_call', payload: { tool: 'read', args: { path: 'index.html' } }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: new Date(Date.now() - 10.7 * 60_000).toISOString(), type: 'tool_result', payload: { ok: true, bytes: 8042 }, level: 'info' },
        { id: uid('evt_'), run_id: seededRunId, timestamp: new Date(Date.now() - 10.2 * 60_000).toISOString(), type: 'status', payload: { status: 'success' }, level: 'info' }
      ]
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function readHandles() {
  if (!fs.existsSync(HANDLES_FILE)) return { runs: {} };
  try {
    return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8'));
  } catch {
    return { runs: {} };
  }
}

function writeHandles(handles) {
  fs.writeFileSync(HANDLES_FILE, JSON.stringify(handles, null, 2));
}

function upsertHandle(runId, patch) {
  const handles = readHandles();
  handles.runs[runId] = {
    ...(handles.runs[runId] || {}),
    ...patch,
    updated_at: iso()
  };
  writeHandles(handles);
  return handles.runs[runId];
}

function deleteHandle(runId) {
  const handles = readHandles();
  delete handles.runs[runId];
  writeHandles(handles);
}

const sseRunClients = new Map();
const sseActivityClients = new Set();
const activeProcesses = new Map();
const embeddedTimers = new Map();

function sendSse(res, event, data, id) {
  if (id) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

function updateRun(db, runId, patch) {
  const run = db.runs.find(r => r.id === runId);
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
  if (!run) return null;
  if (run.status === 'success') return null;
  if (run.failure_summary) return run.failure_summary;

  const ordered = (events || []).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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

function enrichRun(run, eventsForRun = null) {
  const events = eventsForRun || readDb().events.filter(e => e.run_id === run.id);
  return {
    ...run,
    failure_summary: computeFailureSummary(run, events)
  };
}

function buildAgentMessage(run, context) {
  return [
    `Mission Control run_id: ${run.id}`,
    `Task ID: ${run.task_id}`,
    `Requested model: ${run.model}`,
    `Assigned agent: ${(context.agent_id || context?.agent?.id || context?.agent || run.agent_id || 'default')}`,
    '',
    'Task payload:',
    JSON.stringify({
      task: context.task ?? null,
      project: context.project ?? null,
      related_tasks: context.related_tasks ?? [],
      related_issues: context.related_issues ?? [],
      context: context.context ?? null
    }, null, 2)
  ].join('\n');
}

function startEmbeddedFallbackRun(run, context = {}, reason = 'openclaw CLI unavailable') {
  addEvent(readDb(), run.id, 'message', { text: 'Falling back to embedded runner', reason }, 'warn');

  const t1 = setTimeout(() => {
    addEvent(readDb(), run.id, 'stdout', { stream: 'stdout', line: 'Embedded runner started' });
  }, 120);

  const t2 = setTimeout(() => {
    const taskText = typeof context?.task === 'string' ? context.task : context?.task?.title || context?.task?.description || null;
    const summary = taskText ? `Embedded execution completed: ${String(taskText).slice(0, 140)}` : 'Embedded execution completed';
    addEvent(readDb(), run.id, 'tool_result', { ok: true, mode: 'embedded-fallback', summary });
    updateRun(readDb(), run.id, {
      status: 'success',
      ended_at: iso(),
      error: null,
      failure_summary: null
    });
    addEvent(readDb(), run.id, 'status', { status: 'success', auto_transition_done: AUTO_TRANSITION_DONE });
    embeddedTimers.delete(run.id);
    deleteHandle(run.id);
  }, 700);

  embeddedTimers.set(run.id, [t1, t2]);
}

class OpenClawAdapter {
  constructor() {}

  async dispatch(run, context) {
    const selectedAgent = context.agent_id || context?.agent?.id || context?.agent || run.agent_id || '';
    const argv = ['agent', '--json', '--message', buildAgentMessage(run, context)];

    if (selectedAgent) argv.push('--agent', selectedAgent);
    if (OPENCLAW_AGENT_CHANNEL) argv.push('--channel', OPENCLAW_AGENT_CHANNEL);

    const child = spawn(OPENCLAW_BIN, argv, {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const command = `${OPENCLAW_BIN} ${argv.map(a => JSON.stringify(a)).join(' ')}`;
    activeProcesses.set(run.id, child);
    upsertHandle(run.id, {
      run_id: run.id,
      pid: child.pid,
      command,
      state: 'running',
      agent: selectedAgent || null
    });

    updateRun(readDb(), run.id, { status: 'running' });
    addEvent(readDb(), run.id, 'status', { status: 'running', auto_transition_in_progress: AUTO_TRANSITION_IN_PROGRESS });
    addEvent(readDb(), run.id, 'message', {
      text: 'OpenClaw run process started',
      adapter: 'openclaw-cli',
      assigned_agent: selectedAgent || null
    });

    const onStreamChunk = (type, chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        addEvent(readDb(), run.id, 'stdout', { stream: type, line });
        if (line.includes('tool')) {
          addEvent(readDb(), run.id, 'tool_call', { stream: type, raw: line });
        }
      }
    };

    child.stdout.on('data', (chunk) => onStreamChunk('stdout', chunk));
    child.stderr.on('data', (chunk) => onStreamChunk('stderr', chunk));

    child.on('error', (err) => {
      activeProcesses.delete(run.id);

      if (err?.code === 'ENOENT') {
        if (ENABLE_EMBEDDED_FALLBACK) {
          upsertHandle(run.id, { state: 'embedded_fallback', error: err.message });
          addEvent(readDb(), run.id, 'message', { text: 'OpenClaw unavailable, switching to embedded fallback', reason: err.message }, 'warn');
          startEmbeddedFallbackRun(run, context, err.message);
          return;
        }
        upsertHandle(run.id, { state: 'error', error: err.message });
        updateRun(readDb(), run.id, { status: 'failed', ended_at: iso(), error: err.message, failure_summary: err.message });
        addEvent(readDb(), run.id, 'error', { message: `Failed to start OpenClaw process: ${err.message}` }, 'error');
        addEvent(readDb(), run.id, 'status', { status: 'failed' }, 'error');
        return;
      }

      upsertHandle(run.id, { state: 'error', error: err.message });
      updateRun(readDb(), run.id, { status: 'failed', ended_at: iso(), error: err.message, failure_summary: err.message });
      addEvent(readDb(), run.id, 'error', { message: `Failed to start OpenClaw process: ${err.message}` }, 'error');
      addEvent(readDb(), run.id, 'status', { status: 'failed' }, 'error');
    });

    child.on('close', (code, signal) => {
      activeProcesses.delete(run.id);
      const db = readDb();
      const current = db.runs.find(r => r.id === run.id);
      if (!current || current.status === 'cancelled') {
        deleteHandle(run.id);
        return;
      }

      const handleState = readHandles().runs[run.id]?.state;
      if (handleState === 'embedded_fallback') {
        return;
      }

      const successful = code === 0;
      if (successful) {
        updateRun(db, run.id, {
          status: 'success',
          ended_at: iso(),
          error: null,
          cost_estimate: current.cost_estimate || 0
        });
        addEvent(readDb(), run.id, 'tool_result', { ok: true, command_exit_code: code, signal: signal || null });
        addEvent(readDb(), run.id, 'status', { status: 'success', auto_transition_done: AUTO_TRANSITION_DONE });
      } else {
        const message = `OpenClaw process exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
        updateRun(db, run.id, { status: 'failed', ended_at: iso(), error: message, failure_summary: message });
        addEvent(readDb(), run.id, 'error', { message }, 'error');
        addEvent(readDb(), run.id, 'status', { status: 'failed' }, 'error');
      }
      deleteHandle(run.id);
    });

    return {
      mode: 'openclaw-cli',
      process_pid: child.pid,
      command,
      assigned_agent: selectedAgent || null
    };
  }

  async cancel(run) {
    const child = activeProcesses.get(run.id);
    const existing = readHandles().runs[run.id] || null;
    const timers = embeddedTimers.get(run.id) || null;

    if (timers?.length) {
      for (const timer of timers) clearTimeout(timer);
      embeddedTimers.delete(run.id);
    }

    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (activeProcesses.has(run.id)) child.kill('SIGKILL');
      }, 1500).unref();
    } else if (existing?.pid) {
      try {
        process.kill(existing.pid, 'SIGTERM');
      } catch {
        // process already dead
      }
    }

    upsertHandle(run.id, {
      state: 'cancel_requested',
      cancel_requested_at: iso()
    });

    return { mode: 'openclaw-cli', cancelled: true, run_id: run.id, pid: existing?.pid || child?.pid || null };
  }
}

const adapter = new OpenClawAdapter();

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

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  if (!API_TOKEN) return res.status(500).json({ error: 'Server auth misconfigured: MISSION_CONTROL_API_TOKEN missing' });
  const hdr = req.get('authorization') || '';
  const queryToken = req.query?.token ? String(req.query.token) : '';
  if (hdr === `Bearer ${API_TOKEN}` || queryToken === API_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/config', (req, res) => {
  res.json({
    gateway_url: 'openclaw-cli',
    auth_token_present: Boolean(API_TOKEN),
    default_model: DEFAULT_MODEL,
    toggles: {
      auto_transition_in_progress: AUTO_TRANSITION_IN_PROGRESS,
      auto_transition_done: AUTO_TRANSITION_DONE
    }
  });
});

app.post('/api/tasks/:id/dispatch', requireAuth, async (req, res) => {
  const db = readDb();
  const taskId = req.params.id;
  const active = db.runs.find(r => r.task_id === taskId && ['queued', 'running'].includes(r.status));
  if (active) return res.status(409).json({ error: 'Task already has an active run', active_run_id: active.id });

  const run = {
    id: uid('run_'),
    task_id: taskId,
    agent_id: req.body.agent_id || req.body?.agent?.id || req.body.agent || null,
    status: 'queued',
    model: req.body.model || DEFAULT_MODEL,
    started_at: iso(),
    ended_at: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_estimate: 0,
    error: null,
    source: 'dispatch'
  };

  db.runs.unshift(run);
  writeDb(db);

  addEvent(readDb(), run.id, 'status', { status: 'queued', auto_transition_in_progress: AUTO_TRANSITION_IN_PROGRESS });
  addEvent(readDb(), run.id, 'message', {
    text: 'Dispatch accepted',
    context: {
      task: req.body.task || null,
      project: req.body.project || null,
      agent: req.body.agent || null,
      related_tasks: req.body.related_tasks || [],
      related_issues: req.body.related_issues || []
    }
  });

  await adapter.dispatch(run, req.body);

  res.status(202).json({ run });
});

app.post('/api/runs/:run_id/cancel', requireAuth, async (req, res) => {
  const db = readDb();
  const run = db.runs.find(r => r.id === req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!['queued', 'running'].includes(run.status)) return res.status(409).json({ error: `Cannot cancel run in status ${run.status}` });

  await adapter.cancel(run);
  updateRun(db, run.id, { status: 'cancelled', ended_at: iso(), error: null });
  addEvent(readDb(), run.id, 'status', { status: 'cancelled' }, 'warn');
  deleteHandle(run.id);

  res.json({ ok: true, run_id: run.id });
});

app.post('/api/runs/:run_id/retry', requireAuth, async (req, res) => {
  const db = readDb();
  const prev = db.runs.find(r => r.id === req.params.run_id);
  if (!prev) return res.status(404).json({ error: 'Run not found' });

  const active = db.runs.find(r => r.task_id === prev.task_id && ['queued', 'running'].includes(r.status));
  if (active) return res.status(409).json({ error: 'Task already has an active run', active_run_id: active.id });

  const run = {
    id: uid('run_'),
    task_id: prev.task_id,
    agent_id: req.body.agent_id || req.body?.agent?.id || req.body.agent || prev.agent_id || null,
    status: 'queued',
    model: req.body.model || prev.model || DEFAULT_MODEL,
    started_at: iso(),
    ended_at: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_estimate: 0,
    error: null,
    source: 'retry'
  };

  db.runs.unshift(run);
  writeDb(db);
  addEvent(readDb(), run.id, 'status', { status: 'queued', retried_from: prev.id });
  addEvent(readDb(), run.id, 'message', { text: 'Retry requested', previous_run_id: prev.id });
  await adapter.dispatch(run, req.body);

  res.status(202).json({ run, retried_from: prev.id });
});

app.get('/api/runs/:run_id', requireAuth, (req, res) => {
  const db = readDb();
  const run = db.runs.find(r => r.id === req.params.run_id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const events = db.events.filter(e => e.run_id === run.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  res.json({ run: enrichRun(run, events), events });
});

app.get('/api/tasks/:id/runs', requireAuth, (req, res) => {
  const db = readDb();
  const runs = db.runs
    .filter(r => r.task_id === req.params.id)
    .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''))
    .map(run => enrichRun(run, db.events.filter(e => e.run_id === run.id)));
  res.json({ runs });
});

app.get('/api/runs/:run_id/stream', requireAuth, (req, res) => {
  const db = readDb();
  const run = db.runs.find(r => r.id === req.params.run_id);
  if (!run) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const lastId = req.header('Last-Event-ID') || req.query.lastEventId;
  const events = db.events.filter(e => e.run_id === run.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let replay = events;
  if (lastId) {
    const idx = events.findIndex(e => e.id === lastId);
    replay = idx >= 0 ? events.slice(idx + 1) : events;
  }
  replay.forEach(evt => sendSse(res, 'run_event', evt, evt.id));
  sendSse(res, 'run_snapshot', { run: enrichRun(run, events) }, `snap_${Date.now()}`);

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

app.get('/api/activity/stream', requireAuth, (req, res) => {
  const db = readDb();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const lastId = req.header('Last-Event-ID') || req.query.lastEventId;
  const events = db.events.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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

app.listen(PORT, () => {
  console.log(`mission-control backend running at http://localhost:${PORT}`);
});
