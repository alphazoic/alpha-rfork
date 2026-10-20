'use strict';

const { createTransferWatchdog } = require('./transfer-watchdog');
const { createRforkOutput } = require('./rfork-output');

// The tools expose rounded percentages (MEGA tools) or numeric JSON byte
// counters (rclone). Never infer zero speed from missing/unrecognised output.
function createUploadProgress(tool, size, onBytes) {
  const buffers = new Map();
  let highWater = 0;
  function bytes(value) {
    if (!Number.isFinite(value) || value < 0 || value > size) return;
    const current = Math.floor(value), delta = Math.max(0, current - highWater);
    highWater = Math.max(highWater, current); onBytes(delta);
  }
  function percent(value) { if (value >= 0 && value <= 100) bytes(size * value / 100); }
  if (tool === 'rclone') {
    const output = createRforkOutput(stats => { if (Number.isSafeInteger(stats.bytes)) bytes(stats.bytes); });
    return { percent, feed(data, channel = 'stderr') { if (channel === 'stderr') output.feed(data); }, flush: () => output.flush() };
  }
  function line(value) {
    value = value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) percent(Number(match[1]));
  }
  return {
    percent,
    feed(data, channel = 'stdout') {
      const parts = ((buffers.get(channel) || '') + data.toString()).split(/[\r\n]/);
      const tail = parts.pop();
      for (const part of parts) line(part);
      // Percentage records often overwrite a terminal line without a newline.
      // rclone JSON is parsed only after a complete line (or on close).
      if (tool !== 'rclone') line(tail);
      buffers.set(channel, tail.slice(-65536));
    },
    flush() { for (const value of buffers.values()) line(value); buffers.clear(); },
  };
}

function createUploadVpnSession({ plan, network, send, tickMs = 1000, now = Date.now }) {
  const policy = plan?.policy || {};
  const enabled = Boolean(policy.enabled && policy.uploadRecoveryEnabled);
  let attempt = null, pending = false, closed = false, observed = false;
  let pendingGeneration;
  const notify = (state, message) => send('up:vpnState', { state, message });
  function end() {
    if (!attempt) return;
    attempt.progress.flush(); clearInterval(attempt.timer); attempt.watchdog.stop(); attempt = null;
  }
  function begin(tool, size) {
    end();
    observed = false;
    if (!enabled) return;
    let started = false;
    const watchdog = createTransferWatchdog({ thresholdBps: policy.uploadThresholdBps,
      durationMs: policy.uploadDurationMs, warmupMs: policy.warmupMs, averagingMs: policy.averagingMs, now,
      onAlarm() {
        pending = true;
        pendingGeneration = plan?.state().connectionGeneration;
        notify('deferred', 'Upload is slow or stalled. VPN change waits for this file to finish. Stop the queue if it cannot finish; check the remote file before retrying.');
      } });
    const progress = createUploadProgress(tool, size, delta => {
      observed = true;
      if (!started) { watchdog.start(); started = true; }
      watchdog.add(delta);
    });
    attempt = { progress, watchdog, timer: setInterval(() => watchdog.tick(), tickMs) };
  }
  return {
    enabled, begin, end,
    get observed() { return observed; },
    discard() { pending = false; end(); },
    observe(proc) {
      const current = attempt;
      if (!current) return;
      proc.stdout?.on('data', data => { if (attempt === current) current.progress.feed(data, 'stdout'); });
      proc.stderr?.on('data', data => { if (attempt === current) current.progress.feed(data, 'stderr'); });
      proc.once('close', () => { if (attempt === current) end(); });
    },
    percent(value) { attempt?.progress.percent(value); },
    async boundary() {
      end();
      if (!enabled || closed) return;
      // Yield even without an alarm: a simultaneous download/manual switch may
      // already be queued behind this upload's account-session lease.
      await network.yieldRoute(async signal => {
        if (!pending) return;
        notify('waiting', 'File saved. Waiting for the shared VPN connection; the account and pending queue are retained.');
        try { await plan.recover(signal, 'speed', snapshot => {
          if (snapshot.connectionProgress?.message) notify(snapshot.state === 'attention' ? 'attention' : 'waiting', snapshot.connectionProgress.message);
        }, pendingGeneration); }
        catch (error) {
          if (signal?.aborted) throw signal.reason;
          notify('attention', 'VPN recovery needs attention. Connect a VPN manually or stop the queue.');
          await plan.waitForRoute(signal);
        }
        pending = false;
      });
      notify('resuming', 'VPN route ready. Continuing the pending upload queue on the same account.');
    },
    close() { closed = true; end(); plan?.close(); },
  };
}
module.exports = { createUploadProgress, createUploadVpnSession };
