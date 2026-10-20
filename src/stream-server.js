'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Active stream registry ────────────────────────────────────────────────────
// Each entry: { fileSize, bytePositions, chunkDir, contentType, readyChunks: Set }
const _registry = new Map();
let _server = null;
let _port   = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the chunk index whose byte range contains `offset`. */
function _chunkAt(bytePositions, offset) {
  let idx = 0;
  for (let i = 1; i < bytePositions.length; i++) {
    if (bytePositions[i] <= offset) idx = i; else break;
  }
  return idx;
}

/**
 * Polls until chunk `ci` is marked ready, then resolves.
 * Rejects if the stream disappears from the registry or a 4-hour hard
 * deadline is exceeded (covers any conceivable download, even on slow links).
 */
function _waitForChunk(streamId, ci) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 4 * 60 * 60 * 1_000;
    (function poll() {
      const s = _registry.get(streamId);
      if (!s)                    return reject(new Error('Stream removed'));
      if (s.readyChunks.has(ci)) return resolve();
      if (Date.now() > deadline) return reject(new Error('Chunk wait timeout'));
      setTimeout(poll, 150);
    })();
  });
}

// ── Request handler ───────────────────────────────────────────────────────────

async function _handleRequest(req, res) {
  const streamId = decodeURIComponent(req.url.replace(/^\/+/, '').split('?')[0]);
  const entry    = _registry.get(streamId);

  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Stream not found');
    return;
  }

  entry.activeConnections++;
  res.on('close', () => {
    entry.activeConnections--;
    if (entry.pendingRemoval && entry.activeConnections === 0) {
      _registry.delete(streamId);
      if (entry.onDrained) entry.onDrained();
    }
  });

  const { fileSize, bytePositions, chunkDir, contentType } = entry;
  const totalChunks = bytePositions.length;

  // ── Parse Range header ────────────────────────────────────────────────────
  const rangeHdr = req.headers['range'];
  let rangeStart = 0;
  let rangeEnd   = fileSize - 1;
  if (rangeHdr) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
    if (m) {
      rangeStart = parseInt(m[1], 10);
      if (m[2]) rangeEnd = parseInt(m[2], 10);
    }
  }
  rangeEnd = Math.min(rangeEnd, fileSize - 1);

  res.writeHead(rangeHdr ? 206 : 200, {
    'Content-Type':   contentType,
    'Content-Length': String(rangeEnd - rangeStart + 1),
    'Content-Range':  `bytes ${rangeStart}-${rangeEnd}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Cache-Control':  'no-store',
  });

  if (req.method === 'HEAD') { res.end(); return; }

  // ── Pipe bytes from per-chunk dec files ───────────────────────────────────
  let cursor = rangeStart;
  while (cursor <= rangeEnd) {
    if (res.destroyed) return;

    const ci       = _chunkAt(bytePositions, cursor);
    const cBase    = bytePositions[ci];
    const cEnd     = (ci + 1 < totalChunks ? bytePositions[ci + 1] : fileSize) - 1;
    const decPath  = path.join(chunkDir, `chunk_${ci}.dec`);
    const readFrom = cursor - cBase;
    const readTo   = Math.min(cEnd, rangeEnd) - cBase;

    // Block until this chunk has been fully decrypted to disk.
    try { await _waitForChunk(streamId, ci); }
    catch { if (!res.destroyed) res.destroy(); return; }

    if (res.destroyed) return;

    await new Promise(resolve => {
      const rs = fs.createReadStream(decPath, { start: readFrom, end: readTo });
      res.on('close', () => { rs.destroy(); resolve(); });
      rs.on('error', () => { try { res.destroy(); } catch {} resolve(); });
      rs.on('end', resolve);
      rs.pipe(res, { end: false });
    });

    cursor = cBase + readTo + 1;
  }

  try { res.end(); } catch {}
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

function _ensureServer() {
  if (_server) return Promise.resolve(_port);
  return new Promise((resolve, reject) => {
    _server = http.createServer((req, res) => {
      _handleRequest(req, res).catch(() => { try { res.destroy(); } catch {} });
    });
    _server.maxConnections = 64; // players open several parallel connections
    _server.listen(0, '127.0.0.1', () => { _port = _server.address().port; resolve(_port); });
    _server.on('error', reject);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers a stream and returns its localhost URL.
 * Starts the HTTP server on the first call (OS assigns a free port).
 */
async function registerStream({ streamId, fileSize, bytePositions, chunkDir, contentType }) {
  const port = await _ensureServer();
  _registry.set(streamId, {
    fileSize, bytePositions, chunkDir,
    contentType: contentType || 'application/octet-stream',
    readyChunks: new Set(),
                activeConnections: 0,
                pendingRemoval: false,
                onDrained: null,
  });
  return `http://127.0.0.1:${port}/${encodeURIComponent(streamId)}`;
}

/** Marks chunk `ci` as fully written to disk and available for serving. */
function markChunkReady(streamId, ci) {
  const s = _registry.get(streamId);
  if (s) s.readyChunks.add(ci);
}

/**
 * Marks a stream for removal. If no connections are active the registry
 * entry is deleted immediately and onDrained is called. Otherwise removal
 * is deferred until the last active connection closes.
 */
function unregisterStream(streamId, onDrained) {
  const s = _registry.get(streamId);
  if (!s) { if (onDrained) onDrained(); return; }
  if (s.activeConnections === 0) {
    _registry.delete(streamId);
    if (onDrained) onDrained();
  } else {
    s.pendingRemoval = true;
    s.onDrained = onDrained || null;
  }
}

module.exports = { registerStream, markChunkReady, unregisterStream };
