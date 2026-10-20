'use strict';

const network = require('./network-operations');

const { spawnNetwork: spawn } = require('./network-operations');
const path      = require('path');

// Maximum bytes buffered from any subprocess stdout/stderr.
// MEGAcmd forwards verbose internal logs through its pipes — without a cap
// these grow without bound and cause RangeError: Invalid string length.
const MAX_PROC_OUT = 10 * 1024 * 1024; // 10 MB

// Spawn `cmd` with `args` and resolve with stdout, or reject with stderr.
// Never blocks the event loop — the main process stays responsive throughout.
function runCommand(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...spawnOpts } = opts;
    if (input !== undefined) spawnOpts.stdio = ['pipe', 'pipe', 'pipe'];
    const proc = spawn(cmd, args, spawnOpts);
    let out = '', err = '';
    proc.stdout?.on('data', d => { if (out.length < MAX_PROC_OUT) out += d.toString(); });
    proc.stderr?.on('data', d => { if (err.length < MAX_PROC_OUT) err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} exited with code ${code}`));
    });
    if (input !== undefined) {
      proc.stdin.on('error', () => {}); // EPIPE is reported by process failure/close.
      proc.stdin.end(input);
    }
  });
}

// Like runCommand but fires onProgress(pct) as 7z writes percentage lines.
function runCommandWithProgress(cmd, args = [], onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = '', err = '';
    const parsePct = chunk => {
      chunk.split(/[\r\n]/).forEach(part => {
        const m = part.match(/(\d+)%/);
        if (m) onProgress(parseInt(m[1], 10));
      });
    };
    proc.stdout?.on('data', d => { const s = d.toString(); if (out.length < MAX_PROC_OUT) out += s; parsePct(s); });
    proc.stderr?.on('data', d => { if (err.length < MAX_PROC_OUT) err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} exited with code ${code}`));
    });
  });
}

// Hard-timeout wrapper — kills the process and rejects if it hasn't exited
// within timeoutMs. Prevents mega-exec from hanging when mega-cmd-server
// keeps the pipe open streaming logs without ever exiting.
function runCommandWithTimeout(cmd, args, opts, timeoutMs, onProc) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    if (typeof onProc === 'function') onProc(proc);
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { proc.kill(); } catch { /* ignore */ }
      reject(new Error(`${path.basename(cmd)} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stdout?.on('data', d => { if (out.length < MAX_PROC_OUT) out += d.toString(); });
    proc.stderr?.on('data', d => { if (err.length < MAX_PROC_OUT) err += d.toString(); });
    proc.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    proc.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

// Resolves with the first regex match found in stdout+stderr, then kills the
// process immediately. Resolves '' if the process exits without a match or
// the timeout fires.
function runCommandResolveOnMatch(cmd, args, opts, pattern, timeoutMs = 60000) {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, opts);
    let buf = '', done = false;
    const finish = val => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(''), timeoutMs);
    const check = chunk => { buf += chunk; const m = buf.match(pattern); if (m) finish(m[0]); };
    proc.stdout?.on('data', d => check(d.toString()));
    proc.stderr?.on('data', d => check(d.toString()));
    proc.on('error', () => finish(''));
    proc.on('close', () => finish(''));
  });
}

// Retry wrapper — every attempt goes through runCommandWithTimeout so a hung
// process can never block the queue indefinitely.
// timeoutMs applies per attempt; total worst-case = retries × (timeoutMs + delayMs).
//
// Jitter of up to jitterMs is added to each inter-attempt delay so that
// concurrent retry storms (e.g. multiple accounts hitting MEGAcmd at once)
// naturally spread out over time instead of colliding on a fixed schedule.
async function execRetry(
  cmd, args = [], opts = {}, retries = 3, delayMs = 4000,
  timeoutMs = 120000, onProc, jitterMs = 1000
) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await runCommandWithTimeout(cmd, args, opts, timeoutMs, onProc);
    } catch (e) {
      network.interruption(e);
      lastErr = e;
      if (attempt < retries) {
        const wait = delayMs * attempt + Math.random() * jitterMs;
        await network.delay(wait);
      }
    }
  }
  throw lastErr;
}

module.exports = {
  MAX_PROC_OUT,
  runCommand,
  runCommandWithProgress,
  runCommandWithTimeout,
  runCommandResolveOnMatch,
  execRetry,
};
