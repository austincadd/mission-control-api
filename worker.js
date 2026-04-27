#!/usr/bin/env node
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import readline from 'readline';

const BASE_URL = (process.env.MISSION_CONTROL_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.MISSION_CONTROL_WORKER_TOKEN || process.env.MISSION_CONTROL_API_TOKEN || process.env.OPENCLAW_TOKEN || '';
const WORKER_ID = process.env.WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const OPENCLAW_CHANNEL = process.env.OPENCLAW_AGENT_CHANNEL || '';
const OPENCLAW_DEFAULT_AGENT = process.env.OPENCLAW_DEFAULT_AGENT || 'guy';
const CLAIM_SLEEP_MS = Number(process.env.WORKER_CLAIM_SLEEP_MS || 2000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15_000);

let currentRun = null;
let currentProc = null;
let currentCancelled = false;
let shuttingDown = false;
let heartbeatTimer = null;
let stdoutTail = [];
let stderrTail = [];
let workerReady = false;
let workerUnhealthyReason = null;

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

function describeAgentCommand(command) {
  return `${command.binary} ${command.args.map(a => JSON.stringify(a)).join(' ')}`;
}

const STARTUP_PROBE_TIMEOUT_MS = Number(process.env.WORKER_STARTUP_PROBE_TIMEOUT_MS || 15_000);
const HEALTH_PROBE_NAME = 'openclaw+hermes';

function parseJsonOutput(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'empty output' };
  return { ok: true, value: JSON.parse(raw) };
}

async function probeOpenClaw() {
  const startedAt = Date.now();
  const result = spawnSync(OPENCLAW_BIN, ['config', 'validate', '--json'], {
    encoding: 'utf8',
    env: process.env,
    timeout: STARTUP_PROBE_TIMEOUT_MS
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  if (result.error) {
    return { ok: false, reason: `openclaw config validate --json error: ${result.error.message}`, details: { durationMs, stdout, stderr } };
  }

  let parsedResult;
  try {
    parsedResult = parseJsonOutput(stdout || stderr || '');
  } catch (err) {
    return {
      ok: false,
      reason: `openclaw config validate --json returned invalid JSON: ${err.message}${stdout ? ` stdout=${stdout}` : ''}${stderr ? ` stderr=${stderr}` : ''}`,
      details: { durationMs, stdout, stderr }
    };
  }

  if (parsedResult.ok) {
    const parsed = parsedResult.value;
    const isValid = parsed?.ok === true || parsed?.valid === true;
    if (isValid) {
      return {
        ok: true,
        reason: null,
        details: {
          probe: 'openclaw config validate --json',
          durationMs,
          configPath: parsed.configPath || parsed.path || null,
          checks: parsed.checks || null,
          refsChecked: typeof parsed.refsChecked === 'number' ? parsed.refsChecked : null,
          skippedExecRefs: typeof parsed.skippedExecRefs === 'number' ? parsed.skippedExecRefs : null
        }
      };
    }

    const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    const configError = errors
      .map(error => String(error?.message || error?.ref || '').trim())
      .filter(Boolean)
      .join('; ') || String(parsed?.error || parsed?.message || '').trim();
    return {
      ok: false,
      reason: `openclaw config validate failed${configError ? `: ${configError}` : ''}`,
      details: { durationMs, stdout, stderr, configPath: parsed?.configPath || parsed?.path || null, errors }
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: `openclaw config validate --json exited ${result.status}${stderr ? ` stderr=${stderr}` : ''}${stdout ? ` stdout=${stdout}` : ''}`,
      details: { durationMs, stdout, stderr }
    };
  }

  return {
    ok: false,
    reason: `openclaw config validate --json returned invalid JSON${stdout ? ` stdout=${stdout}` : ''}${stderr ? ` stderr=${stderr}` : ''}`,
    details: { durationMs, stdout, stderr }
  };
}

async function probeHermes() {
  const startedAt = Date.now();
  const result = spawnSync(HERMES_BIN, ['--version'], {
    encoding: 'utf8',
    env: process.env,
    timeout: STARTUP_PROBE_TIMEOUT_MS
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();

  if (result.error) {
    return { ok: false, reason: `hermes --version error: ${result.error.message}`, details: { durationMs, stdout, stderr } };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `hermes --version exited ${result.status}${stderr ? ` stderr=${stderr}` : ''}${stdout ? ` stdout=${stdout}` : ''}`, details: { durationMs, stdout, stderr } };
  }
  if (!stdout && !stderr) {
    return { ok: false, reason: 'hermes --version returned no output', details: { durationMs, stdout, stderr } };
  }
  return {
    ok: true,
    reason: null,
    details: {
      probe: 'hermes --version',
      durationMs,
      version: stdout || stderr || null
    }
  };
}

function normalizeOpenClawAgentId(agentId) {
  const value = String(agentId || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'guy' || value === 'main') return 'main';
  if (value === 'hermy') return 'hermy';
  return null;
}

function buildAgentCommand(agentId, message, sessionId) {
  const normalizedAgentId = String(agentId || '').trim().toLowerCase();
  if (normalizedAgentId === 'hermy') {
    return {
      binary: HERMES_BIN,
      args: ['chat', '-Q', '-t', 'messaging', '-q', message]
    };
  }

  const openClawAgentId = normalizeOpenClawAgentId(normalizedAgentId) || normalizeOpenClawAgentId(OPENCLAW_DEFAULT_AGENT);
  const args = ['agent', '--json', '--session-id', sessionId, '--message', message];
  if (openClawAgentId) args.push('--agent', openClawAgentId);
  if (OPENCLAW_CHANNEL) args.push('--channel', OPENCLAW_CHANNEL);
  return { binary: OPENCLAW_BIN, args };
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
        pid: process.pid,
        healthy: workerReady,
        health_reason: workerReady ? null : workerUnhealthyReason,
        health_probe: HEALTH_PROBE_NAME
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
  if (!workerReady) return null;
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
  const command = job.agent_binary && Array.isArray(job.agent_args)
    ? { binary: job.agent_binary, args: job.agent_args }
    : buildAgentCommand(currentRun.agent_id, workerMessage, currentRun.id);
  const commandPreview = describeAgentCommand(command);
  console.log(`[worker] claimed ${currentRun.id}: ${commandPreview}`);

  await postEvent(currentRun.id, {
    type: 'status',
    payload: { status: 'running', worker_id: WORKER_ID }
  });

  let settled = false;
  const child = spawn(command.binary, command.args, {
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
  const [openclawProbe, hermesProbe] = await Promise.all([probeOpenClaw(), probeHermes()]);
  workerReady = Boolean(openclawProbe.ok && hermesProbe.ok);
  workerUnhealthyReason = !openclawProbe.ok ? openclawProbe.reason : !hermesProbe.ok ? hermesProbe.reason : null;
  if (workerReady) {
    console.log(`[worker] harness probes ok: openclaw=${openclawProbe.details?.configPath || 'unknown'} hermes=${hermesProbe.details?.version || 'ok'} duration=${openclawProbe.details?.durationMs ?? 'n/a'}ms/${hermesProbe.details?.durationMs ?? 'n/a'}ms`);
  } else {
    console.error(`[worker] unhealthy: ${workerUnhealthyReason}`);
  }

  await heartbeat();
  heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

  while (!shuttingDown) {
    if (!workerReady) {
      await sleep(CLAIM_SLEEP_MS);
      continue;
    }
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
