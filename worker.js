#!/usr/bin/env node
import os from 'os';
import { spawn } from 'child_process';
import readline from 'readline';

const BASE_URL = (process.env.MISSION_CONTROL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.MISSION_CONTROL_WORKER_TOKEN || process.env.MISSION_CONTROL_API_TOKEN || process.env.OPENCLAW_TOKEN || '';
const WORKER_ID = process.env.WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const OPENCLAW_CHANNEL = process.env.OPENCLAW_AGENT_CHANNEL || '';
const CLAIM_SLEEP_MS = Number(process.env.WORKER_CLAIM_SLEEP_MS || 2000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15_000);

let currentRun = null;
let currentProc = null;
let currentCancelled = false;
let shuttingDown = false;
let heartbeatTimer = null;
let stdoutTail = [];
let stderrTail = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function headers(extra = {}) {
  const base = { 'Content-Type': 'application/json', ...extra };
  if (TOKEN) base.Authorization = `Bearer ${TOKEN}`;
  base['X-Worker-Id'] = WORKER_ID;
  return base;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: headers(options.headers || {})
  });
  return response;
}

function tailPush(arr, line, max = 200) {
  arr.push(line);
  while (arr.length > max) arr.shift();
}

function buildOpenClawArgs(run, workerMessage) {
  const args = ['agent', '--json', '--message', workerMessage];
  if (run.agent_id) args.push('--agent', run.agent_id);
  if (OPENCLAW_CHANNEL) args.push('--channel', OPENCLAW_CHANNEL);
  return args;
}

async function postEvent(runId, event) {
  if (!runId || shuttingDown) return;
  const response = await api(`/api/worker/runs/${runId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      worker_id: WORKER_ID,
      event
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[worker] event post failed for ${runId}: ${response.status} ${text}`);
  }
}

async function completeRun(runId, status, payload = {}) {
  if (!runId || shuttingDown) return;
  const response = await api(`/api/worker/runs/${runId}/complete`, {
    method: 'POST',
    body: JSON.stringify({
      worker_id: WORKER_ID,
      status,
      ...payload
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(`[worker] complete failed for ${runId}: ${response.status} ${text}`);
  }
}

async function heartbeat() {
  if (shuttingDown) return;
  try {
    const response = await api('/api/worker/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        worker_id: WORKER_ID,
        current_run_id: currentRun?.id || null,
        host: os.hostname(),
        pid: process.pid
      })
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const cancelled = new Set(Array.isArray(data.cancelled_run_ids) ? data.cancelled_run_ids : []);
    if (currentRun?.id && cancelled.has(currentRun.id) && currentProc && !currentCancelled) {
      currentCancelled = true;
      console.log(`[worker] server requested cancel for ${currentRun.id}`);
      currentProc.kill('SIGTERM');
      setTimeout(() => {
        if (currentProc) currentProc.kill('SIGKILL');
      }, 1500).unref();
    }
  } catch (err) {
    console.warn(`[worker] heartbeat error: ${err.message}`);
  }
}

async function claimOne() {
  const response = await api('/api/worker/claim', {
    method: 'POST',
    body: JSON.stringify({
      worker_id: WORKER_ID,
      host: os.hostname(),
      pid: process.pid
    })
  });

  if (response.status === 204) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`claim failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function runClaimed(job) {
  currentRun = job.run;
  currentCancelled = false;
  stdoutTail = [];
  stderrTail = [];

  const workerMessage = job.worker_message || currentRun.worker_message;
  const args = job.openclaw_args || buildOpenClawArgs(currentRun, workerMessage);
  const commandPreview = `${OPENCLAW_BIN} ${args.map(a => JSON.stringify(a)).join(' ')}`;
  console.log(`[worker] claimed ${currentRun.id}: ${commandPreview}`);

  await postEvent(currentRun.id, {
    type: 'status',
    payload: { status: 'running', worker_id: WORKER_ID }
  });

  let settled = false;
  const child = spawn(OPENCLAW_BIN, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  currentProc = child;

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

  stdout.on('line', line => {
    tailPush(stdoutTail, line);
    void postEvent(currentRun.id, {
      type: 'stdout',
      payload: { stream: 'stdout', line }
    });
    if (line.includes('tool')) {
      void postEvent(currentRun.id, {
        type: 'tool_call',
        payload: { stream: 'stdout', raw: line }
      });
    }
  });

  stderr.on('line', line => {
    tailPush(stderrTail, line);
    void postEvent(currentRun.id, {
      type: 'stdout',
      payload: { stream: 'stderr', line }
    });
    if (line.includes('tool')) {
      void postEvent(currentRun.id, {
        type: 'tool_call',
        payload: { stream: 'stderr', raw: line }
      });
    }
  });

  child.on('error', err => {
    if (settled) return;
    settled = true;
    void postEvent(currentRun.id, {
      type: 'error',
      level: 'error',
      payload: { message: `Failed to start OpenClaw process: ${err.message}` }
    });
    void completeRun(currentRun.id, 'failed', {
      error: err.message,
      summary: err.message,
      result: {
        start_error: true,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail
      }
    }).finally(() => {
      currentProc = null;
      currentRun = null;
    });
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;

    const isCancelled = currentCancelled || signal === 'SIGTERM';
    const status = isCancelled ? 'cancelled' : code === 0 ? 'success' : 'failed';
    const error = status === 'failed'
      ? `OpenClaw process exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`
      : null;

    if (status === 'success') {
      void postEvent(currentRun.id, {
        type: 'tool_result',
        payload: { ok: true, command_exit_code: code, signal: signal || null }
      });
    }
    if (status === 'failed' && error) {
      void postEvent(currentRun.id, {
        type: 'error',
        level: 'error',
        payload: { message: error }
      });
    }

    void completeRun(currentRun.id, status, {
      error,
      summary: error,
      result: {
        exit_code: code,
        signal: signal || null,
        stdout_tail: stdoutTail,
        stderr_tail: stderrTail,
        cancelled: isCancelled
      }
    }).finally(() => {
      currentProc = null;
      currentRun = null;
      currentCancelled = false;
    });
  });
}

async function main() {
  console.log(`[worker] starting ${WORKER_ID} -> ${BASE_URL}`);
  await heartbeat();
  heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

  while (!shuttingDown) {
    if (currentRun) {
      await sleep(1000);
      continue;
    }

    try {
      const job = await claimOne();
      if (!job) {
        await sleep(CLAIM_SLEEP_MS);
        continue;
      }
      await runClaimed(job);
    } catch (err) {
      console.warn(`[worker] claim loop error: ${err.message}`);
      await sleep(CLAIM_SLEEP_MS);
    }
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, shutting down`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  if (currentProc) {
    currentCancelled = true;
    currentProc.kill('SIGTERM');
    setTimeout(() => {
      if (currentProc) currentProc.kill('SIGKILL');
    }, 1500).unref();
  }

  await sleep(250);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(err => {
  console.error('[worker] fatal error:', err);
  process.exit(1);
});
