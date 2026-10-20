'use strict';

const { createRforkOutput } = require('./rfork-output');
const path = require('node:path');
const { normalizeRforkSettings, rforkArgs } = require('./rfork-settings');
const { uploadUncertain } = require('./upload-journal');

function uploadWithRfork({ binary, source, destination, bytes, env, spawn, journal, record,
  onSpawn, onStats, cancelled, settings, onDiagnostics = () => {}, stallMs }) {
  const s = normalizeRforkSettings(settings);
  const resume = Boolean(record.checkpoint);
  const requestMiB = s.bundling ? s.bundleSizeMiB : 1;
  const rateWindow = Math.max(s.pacingMs / 1000, s.tpsLimit ? 1 / s.tpsLimit : 0,
    s.bandwidthMiB ? requestMiB / s.bandwidthMiB : 0);
  const watchdogMs = stallMs ?? (s.stallSeconds ? Math.max(s.stallSeconds, 2 * rateWindow + 2 * s.statsSeconds + s.idleTimeoutSeconds) * 1000 : 0);
  return new Promise((resolve, reject) => {
    let child, closed = false, spawnError, stopped = false, killTimer;
    let highWater = 0, lastProgress = Date.now(), resultText = '', resultOversized = false;
    const output = createRforkOutput(stats => {
      if (!Number.isSafeInteger(stats.bytes) || stats.bytes < 0 || stats.bytes > bytes) return;
      if (stats.bytes > highWater) { highWater = stats.bytes; lastProgress = Date.now(); }
      onStats({ bytes: highWater, totalBytes: bytes, speed: Number.isFinite(stats.speed) && stats.speed >= 0 ? stats.speed : 0 });
    }, onDiagnostics);
    function stop() {
      if (stopped || closed) return;
      stopped = true;
      try { child.kill('SIGTERM'); } catch { /* Escalate but await confirmed closure. */ }
      killTimer = setTimeout(() => { if (!closed) { try { child.kill('SIGKILL'); } catch { /* The network lease stays held. */ } } }, 1000);
    }
    let watcher;
    try {
      const args = resume
        ? ['backend', 'upload-resume', ':mega:' + path.posix.dirname(destination), source, '--json',
          '-o', 'name=' + path.posix.basename(destination), '-o', 'checkpoint=' + record.checkpoint,
          '-o', 'checkpoint-interval=' + s.checkpointIntervalSeconds + 's']
        : ['copyto', source, ':mega:' + destination, '--ignore-times'];
      child = spawn(binary, [...args, ...rforkArgs(s, { resume })], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      onSpawn(child);
    } catch (error) { if (resume) { reject(uploadUncertain(record)); } else { error.rforkPreCommit = true; journal.clear(record.id); reject(error); } return; }
    child.stderr.on('data', data => output.feed(data));
    if (resume) child.stdout.on('data', data => {
      if (resultOversized) return;
      resultText += data.toString();
      if (Buffer.byteLength(resultText) > 65536) { resultText = ''; resultOversized = true; }
    });
    child.on('error', error => { spawnError = error; });
    watcher = setInterval(() => { if (cancelled() || (!resume && watchdogMs > 0 && highWater > 0 && highWater < bytes && Date.now() - lastProgress > watchdogMs)) stop(); }, 250);
    child.once('close', (code, signal) => {
      closed = true; clearInterval(watcher); clearTimeout(killTimer); output.flush();
      try {
        let result;
        if (resume && !resultOversized) {
          try {
            const parsed = JSON.parse(resultText);
            if (['committed', 'already-committed'].includes(parsed.status) && typeof parsed.node === 'string' && parsed.node && (!record.node || record.node === parsed.node) &&
                ['restoredAcknowledgedBytes', 'pendingSourceBytes', 'sourceBytesRead'].every(k => Number.isSafeInteger(parsed[k]) && parsed[k] >= 0 && parsed[k] <= bytes) &&
                parsed.restoredAcknowledgedBytes + parsed.pendingSourceBytes === bytes &&
                (parsed.status === 'committed' ? parsed.sourceBytesRead === bytes : parsed.sourceBytesRead === 0 && parsed.pendingSourceBytes === 0)) result = parsed;
          } catch { /* Missing/malformed commit proof retains the checkpoint. */ }
        }
        if (code === 0 && !spawnError && !output.uncertain && !stopped && (!resume || result)) {
          journal.update(record.id, 'committed', result ? { node: result.node } : {});
          resolve(result); return;
        }
        if (resume) {
          journal.update(record.id, 'uncertain');
          const error = uploadUncertain(record);
          if (cancelled()) { error.cancelled = true; error.vpnInterrupted = false; }
          reject(error); return;
        }
        if (!output.uncertain && ((spawnError && !child.pid) || (!signal && !stopped && output.preCommit) || (code === 2 && highWater === 0))) {
          journal.clear(record.id);
          const error = new Error(spawnError ? 'rfork could not start' : 'rfork failed before uploading (login, destination or session setup).');
          error.transientNetwork = output.network;
          error.rforkPreCommit = true; reject(error); return;
        }
        if (!output.uncertain && !signal && !stopped && output.quota) {
          journal.clear(record.id);
          const error = new Error('MEGA reported storage exhaustion.'); error.overQuota = true; reject(error); return;
        }
        journal.update(record.id, 'uncertain');
        const error = uploadUncertain(record);
        // Skip may continue with other destinations, but this destination stays held.
        if (cancelled()) { error.cancelled = true; error.vpnInterrupted = false; }
        reject(error);
      } catch { reject(uploadUncertain(record)); }
    });
  });
}

module.exports = { uploadWithRfork };
