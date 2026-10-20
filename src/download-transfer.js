'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');

// One request attempt. The caller owns the network lease and retry policy.
async function downloadTransfer(url, destPath, { network, expectedBytes, entitySize = expectedBytes, rangeBase = 0,
  startByte = 0, onProgress = () => {}, onBytes = () => {}, onStarted = () => {},
  monitored = false, signal, connectTimeoutMs = 15000, stallTimeoutMs = 60000 } = {}) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || startByte < 0 || startByte >= expectedBytes && expectedBytes !== 0) throw new Error('Invalid download range.');
  const canceled = () => { if (signal?.aborted) throw signal.reason; };
  canceled(); onStarted();
  let current = new URL(url), redirects = 0;
  while (true) {
    canceled();
    if (!['http:', 'https:'].includes(current.protocol)) throw new Error('Invalid download protocol.');
    let req, res, timer;
    const response = await new Promise((resolve, reject) => {
      req = network.requestNetwork(current.protocol === 'https:' ? https : http, 'get', current,
        { headers: { 'Accept-Encoding': 'identity', ...(startByte ? { Range: `bytes=${startByte}-` } : {}) } }, resolve);
      timer = setTimeout(() => req.destroy(new Error('Download connection timed out.')), connectTimeoutMs);
      req.once('error', reject);
      req.once('close', () => clearTimeout(timer));
    }).finally(() => clearTimeout(timer));
    res = response;
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      req.destroy(); res.destroy();
      if (++redirects > 10) throw new Error('Too many download redirects.');
      const next = new URL(res.headers.location, current);
      if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Insecure download redirect.');
      current = next; continue;
    }
    let received = 0, stall, appending = false;
    try {
      canceled();
      if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new Error('Encoded download body cannot be resumed.');
      if (res.statusCode === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(res.headers['content-range'] || '');
        if (!match) throw new Error('Invalid Content-Range.');
        const [first, last, total] = match.slice(1).map(Number);
        // A Worker may describe its chunk representation or the original file.
        const relative = total === expectedBytes, base = relative ? 0 : rangeBase;
        if (!Number.isSafeInteger(total) || total !== (relative ? expectedBytes : entitySize) || last >= total || last < first ||
            last !== base + expectedBytes - 1 || (first !== base && first !== base + startByte)) throw new Error('Mismatched Content-Range.');
        appending = startByte > 0 && first === base + startByte;
      }
      received = appending ? startByte : 0;
      if (res.headers['content-length'] !== undefined && Number(res.headers['content-length']) !== expectedBytes - received) throw new Error('Download length mismatch.');
      const file = fs.createWriteStream(destPath, { flags: appending ? 'a' : 'w' });
      const resetStall = () => {
        clearTimeout(stall);
        if (!monitored) stall = setTimeout(() => req.destroy(new Error('Download transfer stalled.')), stallTimeoutMs);
      };
      resetStall(); onProgress(received);
      res.on('data', chunk => {
        if (signal?.aborted) { req.destroy(signal.reason); return; }
        received += chunk.length;
        if (received > expectedBytes) { req.destroy(new Error('Download length mismatch.')); return; }
        onBytes(chunk.length); onProgress(received); resetStall();
      });
      await pipeline(res, file, ...(signal ? [{ signal }] : []));
      canceled();
      if (received !== expectedBytes) throw new Error('Incomplete download response.');
      return { receivedBytes: received, resumed: appending };
    } finally {
      clearTimeout(stall); req.destroy(); res.destroy();
    }
  }
}
module.exports = { downloadTransfer };
