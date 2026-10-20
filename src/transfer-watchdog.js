'use strict';

// A numeric byte counter sampled on timer ticks, including ticks with no data.
// Each network attempt gets a fresh instance; idle/local work never samples it.
function createTransferWatchdog({ thresholdBps, durationMs, warmupMs, averagingMs, now = Date.now, onAlarm }) {
  for (const value of [thresholdBps, durationMs, warmupMs, averagingMs]) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError('Invalid speed policy.');
  }
  let started = null, bytes = 0, lowSince = null, fired = false;
  const samples = [];
  function start() { started = now(); bytes = 0; lowSince = null; fired = false; samples.splice(0, samples.length, { t: started, bytes: 0 }); }
  function add(count) { if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid byte count.'); bytes += count; }
  function tick() {
    if (started === null || fired) return null;
    const t = now(); samples.push({ t, bytes });
    const cutoff = t - averagingMs;
    while (samples.length > 2 && samples[1].t <= cutoff) samples.shift();
    const first = samples[0], elapsed = t - first.t;
    if (t - started < warmupMs || elapsed < averagingMs || elapsed <= 0) { lowSince = null; return null; }
    const advanced = bytes - first.bytes, speedBps = advanced * 1000 / elapsed;
    const result = { speedBps, bytesInWindow: advanced, elapsedMs: elapsed, totalBytes: bytes };
    if (speedBps >= thresholdBps && advanced > 0) lowSince = null;
    else if (lowSince === null) lowSince = t;
    if (lowSince !== null && t - lowSince >= durationMs) {
      // Returning false defers a healthy stream; keep sampling for a true stall.
      fired = onAlarm(result) !== false;
    }
    return result;
  }
  function stop() { started = null; samples.length = 0; lowSince = null; }
  return { start, add, tick, stop };
}
module.exports = { createTransferWatchdog };
