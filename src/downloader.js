'use strict';

const network = require('./network-operations');

const fs    = require('fs');
const fsp   = require('fs/promises');
const path  = require('path');
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { downloadTransfer } = require('./download-transfer');
const { createDownloadSession } = require('./download-session');
const { openDownloadStaging, downloadStagingIdentity, assertDownloadDestination, downloadDestinationKey } = require('./download-staging');
let vpnService = null, _session = null;
function installDownloadVpn(service) { vpnService = service; }

const { parseUrl }              = require('./parser');
const { startMediainfoPoller }  = require('./mediainfo-poller');
const { registerStream, markChunkReady, unregisterStream } = require('./stream-server');
const {
  b64c,
  deriveFileKey,
  deriveFileKeyFromHex,
  decryptECB,
  decryptAttr,
  computeChunkIv,
  decryptChunkStream,
  createDecipher,
  verifyFileMac,
  IncrementalMac,
} = require('./megaCrypto');

const DEFAULT_CHUNK_SIZE   = 2147483648; // 2 GB
const STREAM_CHUNK_SIZE    = 104857600;  // 100 MB — used in Stream Mode
const DEFAULT_MAX_THREADS  = 4;
const API_BASE             = 'https://g.api.mega.co.nz/cs';

const CONNECT_TIMEOUT = 15_000;   // ms to establish TCP + receive first response byte
const API_TIMEOUT     = 20_000;   // ms of socket inactivity during an API round-trip

// ── Retry schedule ─────────────────────────────────────────────────────────────
//
// Per-file quick retries — applied when a single downloadSingleFile() call throws.
// Delays are the base sleep *before* each retry attempt (attempt 1, 2, 3).
const FILE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000];

// Failed-queue escalating round schedule.  After all three defined rounds the
// last entry is reused for every subsequent round until the 8-hour wall expires.
const RETRY_ROUND_WAIT_MS  = [60_000, 120_000, 180_000]; // 1 min, 2 min, 3 min
const RETRY_INTER_FILE_MS  = [1_000,  2_000,   3_000];   // gap between each file in the retry pass

// Jitter caps — a uniform random value in [0, cap) is added to each delay.
const JITTER_QUICK_MS  = 1_000;   // applied to per-file quick-retry delays
const JITTER_ROUND_MS  = 10_000;  // applied to the round-level wait
const JITTER_FILE_MS   = 500;     // applied to the inter-file gap

const MAX_RETRY_DURATION_MS = 8 * 60 * 60 * 1_000; // 8 hours from first retry attempt

// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return network.hasContext() ? network.delay(ms) : _session ? _session.sleep(ms) : network.delay(ms); }

/**
 * mkdir -p that tolerates Windows drive roots (e.g. D:\) and other
 * directories that already exist. Node's recursive mkdir can throw EPERM
 * on a drive root even though the directory is already there.
 */
async function ensureDir(dirPath) {
  try {
    await fsp.mkdir(dirPath, { recursive: true });
  } catch (e) {
    network.interruption(e);
    if (e.code === 'EPERM' || e.code === 'EEXIST' || e.code === 'EISDIR') {
      try {
        const st = await fsp.stat(dirPath);
        if (st.isDirectory()) return;
      } catch { /* fall through and rethrow the original error */ }
    }
    throw e;
  }
}

/** Uniform jitter: returns a random number in [0, maxMs). */
function jitter(maxMs) { return Math.random() * maxMs; }

/**
 * Like sleep(), but resolves early when _abortFlag is set.
 * Polls every 500 ms so a user-abort during a long retry-round wait feels
 * instantaneous rather than blocked for up to 3 minutes.
 */
function abortableSleep(ms) { return sleep(ms); }

// ── Abort support ─────────────────────────────────────────────────────────────
let _abortFlag = false;
let _skipFlag  = false;
let _downloadRunning = false;

function abortDownload() {
  _abortFlag = true;
  _session?.cancel();
  network.cancel('download');
}

function skipCurrentDownload() {
  const { VpnControllerError } = require('./vpn-controller');
  const reason = new VpnControllerError('CANCELED'); reason.skipped = true;
  _session?.cancel(true); network.cancel('download', reason);
  _skipFlag = true;
}

// Throws if the user pressed Stop or Skip. Call at every safe checkpoint.
function throwIfInterrupted() {
  if (network.hasContext()) network.checkpoint();
  _session?.check();
  if (_abortFlag) throw new Error('Aborted by user');
  if (_skipFlag)  throw new Error('Skipped by user');
}

// Appends a Cloudflare/trailing-slash hint when the error is an HTTP 500.
function http500Hint(msg) {
  return /HTTP 500/i.test(msg)
    ? `${msg} — Cloudflare issue. Did you remove trailing / in link?`
    : msg;
}

class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  acquire() {
    return new Promise(resolve => {
      if (this.count < this.max) { this.count++; resolve(); }
      else this.queue.push(resolve);
    });
  }
  release() {
    this.count--;
    if (this.queue.length) { this.count++; this.queue.shift()(); }
  }
}

/**
 * Safely extract the encrypted key for a node from MEGA's `k` field.
 *
 * MEGA may pack multiple key-share entries into a single `k` string,
 * separated by `/`, each in the form `shareHandle:base64EncryptedKey`.
 * A naïve split(':')[1] on such a string returns the first key concatenated
 * with all subsequent entries — producing a blob whose length is not a
 * multiple of 16 bytes and causing AES to throw DATA_NOT_MULTIPLE_OF_BLOCK_LENGTH.
 *
 * Strategy: prefer the entry whose handle matches `shareId` (the public
 * folder handle from the link), then fall back to the first entry.
 */
function extractNodeKey(kField, shareId, rootH) {
  if (!kField) return '';
  if (!kField.includes(':')) return kField;
  const entries = kField.split('/');
  const match   = entries.find(e => e.startsWith((rootH ?? shareId) + ':'))
  || entries.find(e => e.startsWith(shareId + ':'));
  const chosen  = match || entries.find(e => e.includes(':')) || entries[0];
  return chosen.split(':')[1] || '';
}

function apiPost(bodyStr, url) {
  if (!network.hasContext() && _session) return _session.run(() => requestApiPost(bodyStr, url));
  return requestApiPost(bodyStr, url);
}
function requestApiPost(bodyStr, url) {
  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(bodyStr);
    const opts = {
      method: 'POST',
      timeout: CONNECT_TIMEOUT,
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  buf.length,
        'Accept-Encoding': 'gzip, deflate',
      },
    };
    const req = network.requestNetwork(https, 'request', url, opts, res => {
      // Detect a stalled response body (socket goes quiet mid-read)
      res.setTimeout(API_TIMEOUT, () =>
        res.destroy(new Error(`API response stalled after ${API_TIMEOUT / 1000}s`))
      );
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      const stream = (enc === 'gzip' || enc === 'deflate')
      ? res.pipe(enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate())
      : res;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
      stream.on('error', reject);
      res.on('error', reject);
    });
    // Socket never connected within CONNECT_TIMEOUT
    req.on('timeout', () =>
      req.destroy(new Error(`API request timed out after ${CONNECT_TIMEOUT / 1000}s`))
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function checkApiResponse(data) {
  const val = Array.isArray(data) ? data[0] : data;
  if (typeof val === 'number' && val <= 0) {
    throw new Error(`MEGA API error ${val}. See https://github.com/meganz/sdk/blob/master/include/mega/types.h#L189`);
  }
}

/**
 * megatools can only stream from a plain `/file/HANDLE#KEY` link — it errors
 * with "Can't stream from a directory!" on the folder-derived
 * `/folder/ID#KEY/file/HANDLE` form, even though that form is perfectly
 * valid for our own downloader/importer (which talks to the API directly).
 *
 * This re-derives the equivalent plain file link by fetching the folder's
 * node listing, locating the target file's node, decrypting its node key
 * with the folder key, and re-encoding that key in the standard file-link
 * base64url format.
 *
 * No-op (returns the url unchanged) for plain file links or folder links
 * that don't target a specific file.
 */
async function resolveFolderFileLink(url) {
  const { linkType, id, key, fileInFolder } = parseUrl(url);
  if (linkType !== 'folder' || !fileInFolder) return url;

  // IMPORTANT: Node's 'base64' decoder does NOT treat '-'/'_' as '+'/'/' —
  // it silently *drops* them, corrupting any key that contains those
  // characters (which MEGA's base64url keys frequently do). Must use b64c()
  // to normalize to standard base64 first.
  const fKeyHex  = Buffer.from(b64c(key), 'base64').toString('hex');
  const apiUrl   = `${API_BASE}?n=${id}`;
  const postBody = JSON.stringify([{ a: 'f', c: 1, ca: 1, r: 1 }]);

  const res = await apiPost(postBody, apiUrl);
  checkApiResponse(res);
  const items = (Array.isArray(res) ? res[0] : res).f || [];

  const node = items.find(i => i.h === fileInFolder);
  if (!node) throw new Error('Specified file handle not found in folder.');

  const allHandles      = new Set(items.map(i => i.h));
  const rootFolder      = items.find(i => i.t === 1 && !allHandles.has(i.p)) ?? items.find(i => i.t === 1 && i.h === id);
  const rootH           = rootFolder?.h ?? null;

  const rawKey = extractNodeKey(node.k || '', id, rootH);
  if (!rawKey) throw new Error('Could not extract file key from folder share.');

  const decHex      = decryptECB(rawKey, fKeyHex);
  const fileKeyB64u = Buffer.from(decHex, 'hex').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const resolvedUrl = `https://mega.nz/file/${fileInFolder}#${fileKeyB64u}`;
  console.log(`[resolveFolderFileLink] ${url} → ${resolvedUrl}`);
  return resolvedUrl;
}

async function fetchDownloadUrl(postBody, apiUrl) {
  let lastErr;
  for (let retry = 0; retry < 5; retry++) {
    try {
      const data = await apiPost(postBody, apiUrl);
      checkApiResponse(data);
      const item = Array.isArray(data) ? data[0] : data;
      if (item && item.g) return item.g;
      throw new Error('No download URL (g) in response.');
    } catch (e) {
      network.interruption(e);
      lastErr = e;
      await sleep(1000 * (2 ** retry) + jitter(1000));
    }
  }
  throw new Error(`Failed to get download URL after 5 attempts: ${lastErr.message}`);
}

/**
 * Resolves a single MEGA file — either a plain file link or a
 * folder-derived `/folder/ID#KEY/file/HANDLE` link — to a CDN download URL
 * plus its decryption key/iv. Does not download anything.
 *
 * Throws for a folder link that doesn't point at one specific file, since
 * there's no single byte stream to hand to mediainfo in that case.
 */
async function resolveFileForStreaming(url) {
  const { linkType, id, key, fileInFolder } = parseUrl(url);

  if (linkType === 'file') {
    const { key: fileKey, iv: fileIv } = deriveFileKey(key);
    const postBody     = JSON.stringify([{ a: 'g', p: id, g: 1 }]);
    const downloadUrl  = await fetchDownloadUrl(postBody, API_BASE);
    return { downloadUrl, fileKey, fileIv };
  }

  if (linkType === 'folder' && fileInFolder) {
    const fKeyHex  = Buffer.from(b64c(key), 'base64').toString('hex');
    const apiUrl   = `${API_BASE}?n=${id}`;
    const listBody = JSON.stringify([{ a: 'f', c: 1, ca: 1, r: 1 }]);

    const res = await apiPost(listBody, apiUrl);
    checkApiResponse(res);
    const items = (Array.isArray(res) ? res[0] : res).f || [];

    const node = items.find(i => i.h === fileInFolder);
    if (!node) throw new Error('Specified file handle not found in folder.');

    const allHandles      = new Set(items.map(i => i.h));
    const rootFolder      = items.find(i => i.t === 1 && !allHandles.has(i.p)) ?? items.find(i => i.t === 1 && i.h === id);
    const rootH           = rootFolder?.h ?? null;

    const rawKey = extractNodeKey(node.k || '', id, rootH);
    if (!rawKey) throw new Error('Could not extract file key from folder share.');

    const decHex = decryptECB(rawKey, fKeyHex);
    const { key: fileKey, iv: fileIv } = deriveFileKeyFromHex(decHex);

    const filePostBody = JSON.stringify([{ a: 'g', n: fileInFolder, g: 1 }]);
    const downloadUrl  = await fetchDownloadUrl(filePostBody, apiUrl);
    return { downloadUrl, fileKey, fileIv };
  }

  throw new Error(
    'This link points at a whole folder rather than a single file — ' +
    'open the folder and copy the link for one specific file inside it.'
  );
}

/**
 * Opens an HTTPS GET against a MEGA CDN download URL and returns a readable
 * stream of *decrypted* plaintext bytes, plus an abort() to tear the
 * request down early. Nothing is written to disk — callers (e.g. the
 * mediainfo checker) pipe this directly into another process's stdin and
 * call abort() once they have enough bytes.
 */
function openDecryptedStream(downloadUrl, fileKey, fileIv) {
  const decipher = createDecipher(fileKey, fileIv);
  let req;

  function doGet(currentUrl, redirects = 0) {
    const lib = currentUrl.startsWith('https') ? https : http;
    req = network.requestNetwork(lib, 'get', currentUrl, { timeout: CONNECT_TIMEOUT }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 10) { decipher.emit('error', new Error('Too many redirects.')); return; }
        try { doGet(res.headers.location, redirects + 1); }
        catch (error) { decipher.emit('error', error); }
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        decipher.emit('error', new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('error', err => decipher.emit('error', err));
      res.pipe(decipher);
    });
    req.on('timeout', () =>
    req.destroy(new Error(`Connection timed out after ${CONNECT_TIMEOUT / 1000}s`))
    );
    req.on('error', err => decipher.emit('error', err));
  }
  doGet(downloadUrl);

  function abort() {
    try { req.destroy(); } catch { /* already gone */ }
    try { decipher.destroy(); } catch { /* already gone */ }
  }

  return { stream: decipher, abort };
}

async function downloadSegment(fileName, fileSize, postBody, apiUrl, proxy, encPath, bytePos, length, chunked, progress) {
  for (let retry = 0; retry < 5; retry++) {
    throwIfInterrupted();
    try {
      return await _session.run(async observe => {
        let resumeFrom = 0;
        try {
          const stat = await fsp.stat(encPath);
          if (stat.size === length) { progress(length); return; }
          if (stat.size > 0 && stat.size < length) resumeFrom = stat.size;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const g = await fetchDownloadUrl(postBody, apiUrl);
        const url = `${proxy}/${g}` + (chunked ? `/${bytePos}-${bytePos + length - 1}` : '');
        await downloadTransfer(url, encPath, { network, expectedBytes: length, entitySize: fileSize, rangeBase: bytePos,
          startByte: resumeFrom, onProgress: progress, onStarted: observe.start, onBytes: observe.add,
          monitored: observe.monitored, signal: observe.signal });
      }, { transfer: true, fileName });
    } catch (error) {
      network.interruption(error); throwIfInterrupted();
      if (retry === 4) throw error;
      // An invalid range must never be appended again on the following attempt.
      if (/Content-Range|length mismatch/.test(error.message)) { try { await fsp.unlink(encPath); } catch {} }
      await sleep(1000 * (2 ** retry) + jitter(1000));
    }
  }
}

async function checkFile(filePath, expectedSize) {
  try {
    const stat = await fsp.stat(filePath);
    // Wrong size — likely interrupted right at the rename step. Signal the
    // caller to log a warning and overwrite rather than forcing a manual delete.
    if (stat.size !== expectedSize) return 'overwrite';
    return 'skip';
  } catch (e) {
    network.interruption(e);
    if (e.code !== 'ENOENT') throw e;
  }

  return 'new';
}

function largeFileInit(chunkSize, fileSize, baseIvHex) {
  const byteRanges    = [];
  const bytePositions = [];
  const chunkIvs      = [];
  for (let start = 0; start < fileSize; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, fileSize - 1);
    byteRanges.push(`${start}-${end}`);
    bytePositions.push(start);
    chunkIvs.push(computeChunkIv(baseIvHex, start));
  }
  return { byteRanges, bytePositions, chunkIvs };
}

/**
 * Decrypts one encrypted chunk file to a plaintext destination file.
 * Each chunk gets its own file, so no offset-based or r+ writes are ever
 * needed — the root cause of file-locking failures on Windows and macOS.
 */
/**
 * Decrypts a chunk file and writes the plaintext directly to a specific
 * byte offset within an existing (pre-allocated) target file.
 * Used by Sparse Stream Mode.
 */
async function decryptChunkToOffset(fileKey, chunkIv, encPath, outPath, bytePos) {
  await pipeline(fs.createReadStream(encPath), createDecipher(fileKey, chunkIv),
    fs.createWriteStream(outPath, { flags: 'r+', start: bytePos }), { signal: _session.signal });
  throwIfInterrupted();
}
async function decryptChunkToFile(fileKey, chunkIv, encPath, decPath) {
  await pipeline(fs.createReadStream(encPath), createDecipher(fileKey, chunkIv),
    fs.createWriteStream(decPath), { signal: _session.signal });
  throwIfInterrupted();
}
async function assembleChunks(chunkDecPaths, finalPath) {
  async function* contents() {
    for (const filename of chunkDecPaths) {
      throwIfInterrupted();
      const input = fs.createReadStream(filename);
      try { for await (const buffer of input) { throwIfInterrupted(); yield buffer; } }
      finally { input.destroy(); }
    }
  }
  await pipeline(Readable.from(contents()), fs.createWriteStream(finalPath), { signal: _session.signal });
}

/**
 * Download and decrypt one file.
 * Returns { skipped: bool, duration: ms }
 *
 * onProgress({ fileName, fileSize, receivedBytes, chunk, totalChunks })
 */
async function downloadSingleFile(
  fileName, fileSize, fileKey, fileIv, metaMacHex,
  postBody, apiUrl, outDir, log, onProgress, proxy, onDecryptProgress, chunkSize, streamMode, streamMethod,
  onMediaInfo = null, onStreamUrl = null, onSparsePreview = null
) {
  const startTime   = Date.now();
  const outPath     = path.join(outDir, fileName);
  await assertDownloadDestination(outPath);
  await ensureDir(path.dirname(outPath));
  const stage = await openDownloadStaging(downloadStagingIdentity({ outPath, fileSize, fileKey, fileIv, metaMacHex,
    postBody, apiUrl, chunkSize, mode: streamMode ? streamMethod === 'sparse' ? 'sparse' : 'http' : 'normal' }));
  const binPath = stage.plaintext;
  let published = false, verified = false, cleanupSafe = true;
  try {

    // ── Stream Mode ─────────────────────────────────────────────────────────────
    if (streamMode) {
      if (streamMethod === 'sparse') {
        const attemptId = randomUUID(), previewPath = stage.preview;
        const emit = (state, extra = {}) => onSparsePreview?.({ fileName, attemptId, state, previewPath,
          finalPath: outPath, outputFolder: path.dirname(outPath), ...extra });
        let poller = null, observing = true, failure = null;
        async function stopPoller() {
          observing = false;
          try { await poller?.stop(); }
          catch (error) { cleanupSafe = false; throw error; }
        }
        emit('started');
        try {
          if (await checkFile(outPath, fileSize) === 'skip') {
            try {
              await verifyFileMac(outPath, fileKey, fileIv, metaMacHex, fileSize, null, _session.signal);
              throwIfInterrupted(); published = true; emit('published');
              log(`NOTICE  | ${fileName} already exists and passes integrity verification. Skipping.`);
              return { skipped: true, duration: 0 };
            } catch (error) { throwIfInterrupted(); if (error.code !== 'INTEGRITY_FAILED') throw error; }
          }
          if (stage.pendingPublication) {
            try {
              await verifyFileMac(previewPath, fileKey, fileIv, metaMacHex, fileSize, null, _session.signal);
              verified = true;
              log(`VERIFY  | ${fileName} — retained preview passes integrity verification. Retrying publication.`);
            } catch (error) {
              throwIfInterrupted();
              if (error.code !== 'INTEGRITY_FAILED' && error.code !== 'ENOENT') { cleanupSafe = false; throw error; }
              await stage.reset();
            }
          }
          if (!verified) {
            log(`SPARSE  | Allocating provisional preview for: ${fileName} (${fileSize} bytes)`);
            const fh = await fsp.open(previewPath, 'wx');
            try { await fh.truncate(fileSize); } finally { await fh.close(); }
            poller = onMediaInfo ? startMediainfoPoller(previewPath, durationMs => {
              if (observing && !_session.signal.aborted) onMediaInfo({ durationMs, fileName, attemptId });
            }) : null;
            const { byteRanges, bytePositions, chunkIvs } = largeFileInit(chunkSize, fileSize, fileIv);
            const indices = [];
            let committed = 0;
            const completedChunks = new Set();
            if (byteRanges.length) indices.push(0);
            if (byteRanges.length > 1) indices.push(byteRanges.length - 1);
            for (let i = 1; i < byteRanges.length - 1; i++) indices.push(i);
            log(`STREAM  | Sparse mode, ${byteRanges.length} chunk(s), order: [${indices.join(', ')}]`);
            for (const i of indices) {
              throwIfInterrupted();
              const bytePos = bytePositions[i], encPath = stage.encrypted(bytePos);
              log(`DOWNLOAD| [Chunk ${i + 1}/${byteRanges.length}] Range: ${byteRanges[i]}`);
              await downloadSegment(fileName, fileSize, postBody, apiUrl, proxy, encPath, bytePos,
                Math.min(chunkSize, fileSize - bytePos), true, bytes => onProgress({ fileName, fileSize,
                  receivedBytes: committed + bytes, chunk: i + 1, totalChunks: byteRanges.length, completedChunks: [...completedChunks] }));
              await decryptChunkToOffset(fileKey, chunkIvs[i], encPath, previewPath, bytePos);
              await fsp.unlink(encPath);
              committed += Math.min(chunkSize, fileSize - bytePos); completedChunks.add(i + 1);
              onProgress({ fileName, fileSize, receivedBytes: committed, chunk: i + 1,
                totalChunks: byteRanges.length, completedChunks: [...completedChunks] });
              if (completedChunks.size === Math.min(byteRanges.length, 2)) emit('available');
            }
            await stopPoller();
            log(`VERIFY  | ${fileName} — post-stream integrity check…`);
            const progress = onDecryptProgress ? (bytesVerified, totalBytes) => onDecryptProgress({
              fileName, chunk: 1, totalChunks: 1, bytesDecrypted: bytesVerified, totalBytes }) : null;
            await verifyFileMac(previewPath, fileKey, fileIv, metaMacHex, fileSize, progress, _session.signal);
            verified = true;
            await stage.setPendingPublication(true);
          }
          throwIfInterrupted();
          await fsp.rename(previewPath, outPath);
          published = true; emit('published');
          log(`VERIFY  | ${fileName} — OK`);
          return { skipped: false, duration: Date.now() - startTime };
        } catch (error) { failure = error; throw error; }
        finally {
          if (!published) emit('invalidated', { reason: failure?.code === 'INTEGRITY_FAILED' ? 'integrity' : failure?.cancelled ? 'canceled' : 'failed' });
          await stopPoller();
        }
      } else {
        // HTTP Proxy Mode
        const ext      = path.extname(outPath);
        const playback = await stage.playback();
        const chunkDir = playback.directory;
        const streamId = playback.id;
        const m3uPath = playback.playlist;

        let httpMediainfoPoller = null;
        try {
          const { byteRanges, bytePositions, chunkIvs } = largeFileInit(chunkSize, fileSize, fileIv);

          const contentType = {
            '.mp4': 'video/mp4', '.m4v': 'video/mp4',
            '.mkv': 'video/x-matroska',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.wmv': 'video/x-ms-wmv',
            '.webm': 'video/webm',
          }[ext] || 'application/octet-stream';

          const streamUrl = await registerStream({ streamId, fileSize, bytePositions, chunkDir, contentType });
          const chunkDecPaths = new Array(byteRanges.length).fill(null);
          const queueIndices = [];
          let committed = 0;
          const completedChunks = new Set();
          if (byteRanges.length > 0) queueIndices.push(0);
          if (byteRanges.length > 1) queueIndices.push(byteRanges.length - 1);
          for (let i = 1; i < byteRanges.length - 1; i++) queueIndices.push(i);

          const seedTarget          = Math.min(byteRanges.length, 2);
          let   seedsReady          = 0;

          log(`STREAM  | HTTP Proxy mode, ${byteRanges.length} chunk(s), order: [${queueIndices.join(', ')}]`);

          for (const i of queueIndices) {
            if (_abortFlag) throw new Error('Aborted by user');
            if (_skipFlag)  { throw new Error('Skipped by user'); }

            const bytePos = bytePositions[i];
            const range   = byteRanges[i];
            const chunkIv = chunkIvs[i];
            const encPath = stage.encrypted(bytePos);
            const decPath = path.join(chunkDir, `chunk_${i}.dec`);

            log(`DOWNLOAD| [Chunk ${i + 1}/${byteRanges.length}] Range: ${range}`);
            try {
              await downloadSegment(fileName, fileSize, postBody, apiUrl, proxy, encPath, bytePos,
                Math.min(chunkSize, fileSize - bytePos), true, bytes => {
                  onProgress({ fileName, fileSize, receivedBytes: committed + bytes, chunk: i + 1, totalChunks: byteRanges.length, completedChunks: [...completedChunks] });
                });

              log(`DECRYPT | [Chunk ${i + 1}/${byteRanges.length}] Decrypting to temp file`);
              await decryptChunkToFile(fileKey, chunkIv, encPath, decPath);
              await fsp.unlink(encPath);
              chunkDecPaths[i] = decPath;
              markChunkReady(streamId, i);

              if (i === 0 && onMediaInfo && !httpMediainfoPoller) {
                httpMediainfoPoller = startMediainfoPoller(decPath, onMediaInfo);
              }

              seedsReady++;
              if (seedsReady === seedTarget) {
                await fsp.writeFile(m3uPath, `#EXTM3U\n#EXTINF:-1,${fileName}\n${streamUrl}\n`, 'utf8');
                log(`STREAM  | Ready to watch — playlist: ${m3uPath}`);
                log(`STREAM  | Direct URL: ${streamUrl}`);
                if (onStreamUrl) onStreamUrl({ url: streamUrl, m3uPath, outputFolder: path.dirname(outPath) });
              }

              committed += Math.min(chunkSize, fileSize - bytePos); completedChunks.add(i + 1);
              onProgress({ fileName, fileSize, receivedBytes: committed, chunk: i + 1, totalChunks: byteRanges.length, completedChunks: [...completedChunks] });
              log(`DONE    | [Chunk ${i + 1}/${byteRanges.length}] Available on stream server`);
            } catch (e) {
              network.interruption(e);
              try { await fsp.unlink(encPath); } catch { }
              throw e;
            }
          }

          if (_abortFlag) throw new Error('Aborted by user');

          log(`ASSEMBLE| ${fileName} — joining ${byteRanges.length} chunk(s)…`);
          await assembleChunks(byteRanges.map((_, i) => chunkDecPaths[i]), binPath);

          log(`VERIFY  | ${fileName} — post-stream integrity check…`);
          const verifyProgress = onDecryptProgress
          ? (bytesVerified, total) => onDecryptProgress({
            fileName, chunk: 1, totalChunks: 1,
            bytesDecrypted: bytesVerified, totalBytes: total,
          })
          : null;
          await verifyFileMac(binPath, fileKey, fileIv, metaMacHex, fileSize, verifyProgress, _session.signal);
          verified = true;
          throwIfInterrupted(); await fsp.rename(binPath, outPath);
          published = true;
          log(`VERIFY  | ${fileName} — OK`);

          return { skipped: false, duration: Date.now() - startTime };
        } finally {
          if (httpMediainfoPoller) {
            try { await httpMediainfoPoller.stop(); }
            catch (error) { cleanupSafe = false; log(`NOTICE  | ${error.message}`); }
          }
          unregisterStream(streamId, () => cleanupSafe && playback.release()
            .catch(error => log(`NOTICE  | Playback cache cleanup deferred: ${error.message}`)));
        }
      }
    }
    // ── End Stream Mode ──────────────────────────────────────────────────────────

    let state = await checkFile(outPath, fileSize);
    if (state === 'skip') {
      try {
        await verifyFileMac(outPath, fileKey, fileIv, metaMacHex, fileSize, null, _session.signal);
        log(`NOTICE  | ${fileName} already exists and passes integrity verification. Skipping.`);
        published = true;
        return { skipped: true, duration: 0 };
      } catch (error) {
        throwIfInterrupted();
        if (error.code !== 'INTEGRITY_FAILED') throw error;
        state = 'overwrite';
      }
    }
    if (state === 'overwrite') {
      log(`NOTICE  | ${fileName} — existing output has a size or integrity mismatch. Downloading a verified copy.`);
      await stage.reset();
    }
    if ((await stage.readCheckpoints()).length) state = 'resume';

    // ── Large file ─────────────────────────────────────────────────────────────
    if (fileSize >= chunkSize) {
      const { byteRanges, bytePositions, chunkIvs } =
        largeFileInit(chunkSize, fileSize, fileIv);

      log(`CHUNKS  | ${fileName} (${byteRanges.length} chunks, ${fileSize} bytes)`);

      const completedPositions = new Set();
      if (state === 'resume') {
        log(`NOTICE  | ${fileName} appears incomplete. Attempting resume. [BETA]`);
        try {
          for (const position of await stage.readCheckpoints()) completedPositions.add(position);
        } catch { }
        // Accept only a contiguous checkpoint prefix backed by complete plaintext.
        // A stale control file must not cause missing/truncated chunks to be skipped.
        let storedBytes = 0;
        try { storedBytes = (await fsp.stat(binPath)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const recorded = new Set(completedPositions); completedPositions.clear();
        for (const position of bytePositions) {
          if (!recorded.has(position) || storedBytes < Math.min(position + chunkSize, fileSize)) break;
          completedPositions.add(position);
        }
      }

      // IncrementalMac can only accumulate bytes in order from offset 0.  If we're
      // resuming (some leading chunks were already written and will be skipped), fall
      // back to the file-read verify path instead.
      const isResumed = completedPositions.size > 0;
      const mac       = isResumed ? null : new IncrementalMac(fileKey, fileIv, fileSize);

      for (let i = 0; i < byteRanges.length; i++) {
        if (_abortFlag) throw new Error('Aborted by user');
        if (_skipFlag)  { throw new Error('Skipped by user'); }
        const bytePos  = bytePositions[i];
        const range    = byteRanges[i];
        const chunkIv  = chunkIvs[i];
        const encPath  = stage.encrypted(bytePos);

        if (completedPositions.has(bytePos)) {
          log(`CHUNKS  | [Chunk ${i + 1}/${byteRanges.length}] ${fileName} — already done, skipping.`);
          onProgress({ fileName, fileSize, receivedBytes: bytePos, chunk: i + 1, totalChunks: byteRanges.length });
          continue;
        }

        if (state === 'resume' && completedPositions.size > 0) {
          try {
            const binStat = await fsp.stat(binPath);
            if (binStat.size > bytePos) await fsp.truncate(binPath, bytePos);
          } catch { }
        }

        log(`DOWNLOAD| [Chunk ${i + 1}/${byteRanges.length}] ${fileName}`);
        try {
          await downloadSegment(fileName, fileSize, postBody, apiUrl, proxy, encPath, bytePos,
            Math.min(chunkSize, fileSize - bytePos), true, bytes => {
              onProgress({ fileName, fileSize, receivedBytes: bytePos + bytes, chunk: i + 1, totalChunks: byteRanges.length });
            });

          log(`DECRYPT | [Chunk ${i + 1}/${byteRanges.length}] ${fileName}`);
          const isFirstWrite = completedPositions.size === 0 && i === 0;

          // Stat the encrypted file so we can emit a real percentage
          let encFileSize = 0;
          try { encFileSize = (await fsp.stat(encPath)).size; } catch { }

          const chunkDecryptProgress = onDecryptProgress
            ? (bytesDecrypted) => onDecryptProgress({
                fileName, chunk: i + 1, totalChunks: byteRanges.length,
                bytesDecrypted, totalBytes: encFileSize,
              })
            : null;

          await decryptChunkStream(fileKey, chunkIv, encPath, binPath, !isFirstWrite, chunkDecryptProgress, null, mac, _session.signal);
          throwIfInterrupted();
          await fsp.unlink(encPath);
          completedPositions.add(bytePos);
          await stage.writeCheckpoints(completedPositions);

          // Report full chunk as done
          onProgress({ fileName, fileSize, receivedBytes: Math.min(bytePos + chunkSize, fileSize), chunk: i + 1, totalChunks: byteRanges.length });
          log(`DONE    | [Chunk ${i + 1}/${byteRanges.length}] ${fileName}`);
        } catch (e) {
          network.interruption(e);
          try { await fsp.unlink(encPath); } catch { }
          throw e;
        }
      }

      log(`VERIFY  | ${fileName}`);
      try {
        if (isResumed) {
          // Resumed download: some leading chunks were skipped so the accumulator was
          // not fed those bytes.  Do the full file-read verify, emitting decrypt-progress
          // events so the UI stays alive during the read pass.
          log(`VERIFY  | ${fileName} — re-reading file for MAC check (resumed download)…`);
          const verifyProgress = onDecryptProgress
            ? (bytesVerified, total) => onDecryptProgress({
                fileName, chunk: 1, totalChunks: 1,
                bytesDecrypted: bytesVerified, totalBytes: total,
              })
            : null;
          await verifyFileMac(binPath, fileKey, fileIv, metaMacHex, fileSize, verifyProgress, _session.signal);
        } else {
          // Fresh download: MAC was accumulated during decryption — no second I/O pass.
          mac.verify(metaMacHex);
        }
      } catch (error) {
        if (error.code === 'INTEGRITY_FAILED') {
          await stage.reset();
        }
        throw error;
      }
      throwIfInterrupted(); await fsp.rename(binPath, outPath);
      published = true;
      log(`VERIFY  | ${fileName} — OK`);

    } else {
      // ── Small file ────────────────────────────────────────────────────────────
      log(`DOWNLOAD| ${fileName}`);
      const encPath = stage.encrypted(0);
      try {
        await downloadSegment(fileName, fileSize, postBody, apiUrl, proxy, encPath, 0, fileSize, false, bytes => {
          onProgress({ fileName, fileSize, receivedBytes: bytes, chunk: 1, totalChunks: 1 });
        });
        log(`DECRYPT | ${fileName}`);
        let encFileSize = 0;
        try { encFileSize = (await fsp.stat(encPath)).size; } catch { }
        const smallDecryptProgress = onDecryptProgress
          ? (bytesDecrypted) => onDecryptProgress({
              fileName, chunk: 1, totalChunks: 1,
              bytesDecrypted, totalBytes: encFileSize,
            })
          : null;
        const mac = new IncrementalMac(fileKey, fileIv, fileSize);
        await decryptChunkStream(fileKey, fileIv, encPath, binPath, false, smallDecryptProgress, null, mac, _session.signal);
        throwIfInterrupted();
        onProgress({ fileName, fileSize, receivedBytes: fileSize, chunk: 1, totalChunks: 1 });
        log(`VERIFY  | ${fileName}`);
        mac.verify(metaMacHex);
        throwIfInterrupted(); await fsp.rename(binPath, outPath);
        published = true;
        await fsp.unlink(encPath);
        log(`VERIFY  | ${fileName} — OK`);
      } catch (e) {
        network.interruption(e);
        try { await fsp.unlink(encPath); } catch { }
        throw e;
      }
    }

    return { skipped: false, duration: Date.now() - startTime };
  } finally {
    await stage.close({ published, discard: streamMode && !verified && cleanupSafe })
      .catch(error => log(`NOTICE  | Download cache cleanup deferred: ${error.message}`));
  }
}

function buildFilePaths(folderMap, fileMap) {
  const cache = {};
  function getFolderPath(hash) {
    if (!hash || hash === 'null') return '';
    if (cache[hash] !== undefined) return cache[hash];
    const folder = folderMap[hash];
    if (!folder) { cache[hash] = ''; return ''; }
    const parentPath = getFolderPath(folder.parent);
    cache[hash] = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    return cache[hash];
  }
  return Object.entries(fileMap).map(([hash, file]) => {
    const parentPath = getFolderPath(file.parent);
    const fullPath   = parentPath ? `${parentPath}/${file.name}` : file.name;
    return { hash, fullPath };
  });
}

/**
 * Returns true if the file identified by fileHash is a descendant of
 * targetHandle anywhere in the folder hierarchy.
 */
function isDescendantOf(fileHash, targetHandle, fileMap, folderMap) {
  let current = fileMap[fileHash]?.parent ?? null;
  while (current) {
    if (current === targetHandle) return true;
    current = folderMap[current]?.parent ?? null;
  }
  return false;
}

function prepareFolderFile(node, shareId, rootH, folderKey) {
  const sizeKnown = Number.isSafeInteger(node.s) && node.s >= 0;
  const file = { name: `file-${node.h}`, parent: node.p || null,
    size: sizeKnown ? node.s : 0, sizeKnown };
  const fail = (errorCode, errorMessage) => ({ ...file, errorCode, errorMessage });
  if (node.k != null && typeof node.k !== 'string') return fail('FILE_KEY_FORMAT', 'File key has an invalid format.');
  const rawKey = extractNodeKey(node.k || '', shareId, rootH);
  if (!rawKey) return fail('FILE_KEY_MISSING', 'No decryptable file key is present in the share.');
  // Buffer's base64 decoder silently ignores invalid characters and padding.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(rawKey) ||
      Buffer.from(b64c(rawKey), 'base64').toString('base64').replace(/=+$/, '') !== b64c(rawKey).replace(/=+$/, '')) {
    return fail('FILE_KEY_FORMAT', 'File key has an invalid format.');
  }
  if (Buffer.from(b64c(rawKey), 'base64').length !== 32) return fail('FILE_KEY_LENGTH', 'File key must contain 32 bytes.');
  let decHex, derived;
  try {
    decHex = decryptECB(rawKey, folderKey);
    if (!/^[a-f\d]{64}$/i.test(decHex)) return fail('FILE_KEY_LENGTH', 'Decoded file key must contain 32 bytes.');
    derived = deriveFileKeyFromHex(decHex);
  } catch (error) {
    network.interruption(error);
    return fail('FILE_KEY_DECRYPT', 'File key could not be decrypted.');
  }
  // An unreadable name retains the existing fallback; the MAC still decides
  // whether this correctly shaped key authenticates the downloaded plaintext.
  try { file.name = decryptAttr(node.a, derived.key) || file.name; }
  catch (error) { network.interruption(error); }
  return { ...file, ...derived, metaMac: decHex.toUpperCase().slice(48, 64) };
}

function selectRelativeFolderFiles(fileList, fileMap, folderMap, rootH, relPath) {
  const requested = relPath.split('/').filter(Boolean).map(part => part.toLowerCase());
  return fileList.filter(({ hash }) => {
    const ancestors = [];
    let parent = fileMap[hash].parent;
    const seen = new Set();
    while (parent && parent !== rootH) {
      if (seen.has(parent) || !folderMap[parent]) throw new Error('Cannot resolve requested path: folder ancestry is unavailable.');
      seen.add(parent); ancestors.unshift(folderMap[parent]); parent = folderMap[parent].parent;
    }
    for (let i = 0; i < requested.length; i++) {
      if (!ancestors[i]) return false;
      if (!ancestors[i].nameKnown) throw new Error('Cannot resolve requested path: a folder name could not be decrypted.');
      if (ancestors[i].name.toLowerCase() !== requested[i]) return false;
    }
    return true;
  });
}

// ── Per-file quick retry wrapper ──────────────────────────────────────────────
//
// Calls downloadFn() up to 1 + FILE_RETRY_DELAYS_MS.length times total.
// On each failure it waits FILE_RETRY_DELAYS_MS[attempt] + jitter before the
// next try.  Abort/skip signals are propagated immediately without a retry.
//
// @param {() => Promise<{skipped:bool, duration:number}>} downloadFn
// @param {(msg:string)=>void} log
// @param {string} fileName   — used only for log messages
async function attemptFileWithRetries(downloadFn, log, fileName) {
  let lastErr;
  // attempt 0 = first try; attempts 1..N = retries
  for (let attempt = 0; attempt <= FILE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      throwIfInterrupted();
      return await downloadFn();
    } catch (e) {
      network.interruption(e);
      // Always propagate user-initiated interrupts immediately.
      if (_abortFlag) throw new Error('Aborted by user');
      if (_skipFlag)  throw new Error('Skipped by user');
      if (e.message === 'Aborted by user' || e.message === 'Skipped by user') throw e;
      lastErr = e;
      if (attempt < FILE_RETRY_DELAYS_MS.length) {
        const delay = FILE_RETRY_DELAYS_MS[attempt] + jitter(JITTER_QUICK_MS);
        log(
          `ERROR   | ${fileName}: ${http500Hint(e.message)}. ` +
          `Quick retry ${attempt + 1}/${FILE_RETRY_DELAYS_MS.length} ` +
          `in ${(delay / 1000).toFixed(1)}s…`
        );
        await abortableSleep(delay);
      }
    }
  }
  throw lastErr;
}

// ── Failed-queue retry runner ─────────────────────────────────────────────────
//
// Runs sequential retry rounds on a list of failed folder-file items until
// every file succeeds, the 8-hour wall clock expires, or the user aborts.
//
// Round schedule (RETRY_ROUND_WAIT_MS / RETRY_INTER_FILE_MS):
//   Round 1 — wait 1 min  (+jitter), 1 s  between files
//   Round 2 — wait 2 min  (+jitter), 2 s  between files
//   Round 3 — wait 3 min  (+jitter), 3 s  between files
//   Round 4+ — same as round 3 until MAX_RETRY_DURATION_MS elapses
//
// Each file inside a round gets its own FILE_RETRY_DELAYS_MS quick retries
// (via attemptFileWithRetries) before being considered failed for that round.
//
// @returns {number}  count of files permanently failed after all rounds
async function runFailedQueue(
  failedItems, fileMap, apiUrl, outputDir,
  log, onProgress, onFileComplete, proxy, onDecryptProgress, chunkSz, streamMode, streamMethod, onMediaInfo, onStreamUrl, onSparsePreview
) {
  const retryStart = _session.activeNow();
  let   retryRound = 0;
  let   permanentlyFailed = 0;

  while (failedItems.length > 0 && !_abortFlag && !_skipFlag) {
    const elapsed = _session.activeNow() - retryStart;
    if (elapsed >= MAX_RETRY_DURATION_MS) {
      log(
        `NOTICE  | Retry queue: 8-hour limit reached. ` +
        `${failedItems.length} file(s) could not be recovered.`
      );
      break;
    }

    // Clamp to the last defined schedule entry for all rounds beyond index 2.
    const schedIdx    = Math.min(retryRound, RETRY_ROUND_WAIT_MS.length - 1);
    const rawWait     = RETRY_ROUND_WAIT_MS[schedIdx] + jitter(JITTER_ROUND_MS);
    const timeLeft    = MAX_RETRY_DURATION_MS - elapsed;
    const waitMs      = Math.min(rawWait, timeLeft);
    const interFileMs = RETRY_INTER_FILE_MS[schedIdx];
    retryRound++;

    log(
      `NOTICE  | Retry queue: ${failedItems.length} file(s) pending. ` +
      `Waiting ${(waitMs / 60_000).toFixed(1)}m before round ${retryRound}…`
    );
    await abortableSleep(waitMs);

    if (_abortFlag || _skipFlag || _session.activeNow() - retryStart >= MAX_RETRY_DURATION_MS) break;

    log(`NOTICE  | Retry queue: Round ${retryRound} — attempting ${failedItems.length} file(s).`);

    const stillFailed = [];

    for (let i = 0; i < failedItems.length; i++) {
      if (_abortFlag || _skipFlag) {
        // Preserve all remaining items so they get counted at the end.
        stillFailed.push(...failedItems.slice(i));
        break;
      }

      const { hash, fullPath } = failedItems[i];
      const { key: fk, iv: fiv, metaMac, size } = fileMap[hash];
      const filePostBody = JSON.stringify([{ a: 'g', n: hash, g: 1 }]);

      try {
        const { skipped, duration } = await attemptFileWithRetries(
          () => downloadSingleFile(
            fullPath, size, fk, fiv, metaMac,
            filePostBody, apiUrl, outputDir,
            log, onProgress, proxy, onDecryptProgress, chunkSz, streamMode, streamMethod,
            streamMode ? onMediaInfo : null, streamMode ? onStreamUrl : null, onSparsePreview
          ),
          log, fullPath
        );
        onFileComplete({ nodeHandle: hash, fileName: fullPath, fileSize: size, skipped, success: true, duration });
        log(`RECOVERED | ${fullPath} — succeeded in retry round ${retryRound}.`);
      } catch (e) {
        network.interruption(e);
        if (e.message === 'Aborted by user') {
          // Put this item and all remaining back so they get reported at the end.
          stillFailed.push(...failedItems.slice(i));
          break;
        }
        if (e.message === 'Skipped by user') {
          onFileComplete({ nodeHandle: hash, fileName: fullPath, fileSize: size, skipped: true, success: false, duration: 0 });
        } else {
          log(`ERROR   | ${fullPath}: round ${retryRound} failed — ${e.message}.`);
          stillFailed.push({ hash, fullPath });
        }
      }

      // Brief inter-file pause (omit after the last item in the round).
      if (i < failedItems.length - 1 && !_abortFlag) {
        await abortableSleep(interFileMs + jitter(JITTER_FILE_MS));
      }
    }

    failedItems = stillFailed;
  }

  // Report any files that could not be recovered after all rounds.
  for (const { hash, fullPath } of failedItems) {
    if (!_abortFlag && !_skipFlag) {
      permanentlyFailed++;
      log(`ERROR   | ${fullPath}: permanently failed after ${retryRound} retry round(s).`);
    }
    onFileComplete({
      nodeHandle: hash,
      fileName: fullPath,
      fileSize: fileMap[hash]?.size || 0,
      skipped:  _skipFlag && !_abortFlag,
      success:  false,
      canceled: _abortFlag,
      duration: 0,
    });
  }

  if (failedItems.length === 0 && retryRound > 0) {
    log(`NOTICE  | Retry queue cleared — all files recovered.`);
  }

  return permanentlyFailed;
}

/**
 * Main entry point.
 *
 * callbacks: {
 *   onLog(msg),
 *   onProgress({ fileName, fileSize, receivedBytes, chunk, totalChunks }),
 *   onBatchStart({ totalFiles, totalBytes }),   ← fires before downloads begin
 *   onFileComplete({ fileName, fileSize, skipped, success, duration }),
 *   onDone({ duration, totalFiles, failedFiles }),
 *   onError(err),
 * }
 */
async function startDownload({ url, outputDir, relPath, proxy, maxThreads, chunkSize, streamMode, streamMethod }, callbacks) {
  const { onLog, onProgress, onDone, onError, onDecryptProgress, onMediaInfo, onStreamUrl, onSparsePreview } = callbacks;
  const log       = msg => onLog(msg);
  const wallStart = Date.now();
  let plannedFiles = 1;
  const results = new Map();
  const onBatchStart = result => { plannedFiles = result.totalFiles; callbacks.onBatchStart(result); };
  const onFileComplete = result => {
    const identity = result.nodeHandle || result.fileName;
    if (results.has(identity)) return;
    results.set(identity, result); callbacks.onFileComplete(result);
  };
  const summary = () => ({ totalFiles: plannedFiles, completedFiles: results.size,
    succeededFiles: [...results.values()].filter(result => result.success && !result.canceled).length,
    failedFiles: [...results.values()].filter(result => !result.success && !result.skipped && !result.canceled).length });

  // Fall back to compiled defaults if the caller omits either value.
  // Stream Mode locks concurrency to 1 and uses the user-configured streaming chunk size (in MB),
  // falling back to STREAM_CHUNK_SIZE (100 MB) if the caller didn't supply one.
  const threads         = streamMode ? 1
  : (Number.isInteger(maxThreads) && maxThreads >= 1) ? maxThreads : DEFAULT_MAX_THREADS;
  const chunkSz   = (Number.isInteger(chunkSize) && chunkSize >= 1)
  ? chunkSize
  : (streamMode ? STREAM_CHUNK_SIZE : DEFAULT_CHUNK_SIZE);
  if (streamMode) log(`NOTICE  | Stream Mode enabled — head / tail / body chunk ordering. Chunk size: ${Math.round(chunkSz / 1024 / 1024)} MB, concurrent downloads: 1.`);

  try {
    const { linkType, id, key, fileInFolder, subfolderHandle } = parseUrl(url);

    // ════════════════════════════════════════════════════════════════════════
    // FILE LINK
    // ════════════════════════════════════════════════════════════════════════
    if (linkType === 'file') {
      const { key: fileKey, iv: fileIv, fullHex } = deriveFileKey(key);
      const metaMacHex = fullHex.slice(48, 64);
      const apiUrl   = API_BASE;
      const postBody = JSON.stringify([{ a: 'g', p: id, g: 1 }]);

      log('NOTICE  | Fetching file metadata…');
      let res;
      {
        let lastErr;
        for (let retry = 0; retry < 5; retry++) {
          try {
            res = await apiPost(postBody, apiUrl);
            checkApiResponse(res);
            break;
          } catch (e) {
            network.interruption(e);
            lastErr = e;
            log(`NOTICE  | File metadata fetch failed (attempt ${retry + 1}/5): ${e.message}. Retrying…`);
            await sleep(1000 * (2 ** retry) + jitter(1000));
          }
        }
        if (res === undefined)
          throw new Error(`Failed to fetch file metadata after 5 attempts: ${lastErr.message}`);
      }
      const item     = Array.isArray(res) ? res[0] : res;
      const fileName = decryptAttr(item.at, fileKey);
      const fileSize = item.s;
      if (!fileName) throw new Error('Failed to decrypt file name from metadata.');
      log(`NOTICE  | ${fileName} — ${fileSize} bytes`);

      onBatchStart({ totalFiles: 1, totalBytes: fileSize });

      // Single-file link: apply the quick-retry wrapper then report the result.
      // There is no retry queue for single-file links — the overall queue in
      // the renderer handles requeueing if needed.
      const { skipped, duration } = await attemptFileWithRetries(
        () => downloadSingleFile(
          fileName, fileSize, fileKey, fileIv, metaMacHex,
          postBody, apiUrl, outputDir, log, onProgress, proxy, onDecryptProgress, chunkSz, streamMode, streamMethod,
          streamMode ? onMediaInfo : null, streamMode ? onStreamUrl : null, onSparsePreview
        ),
        log, fileName
      );
      onFileComplete({ fileName, fileSize, skipped, success: true, duration });
      onDone({ duration: Date.now() - wallStart, totalFiles: 1, failedFiles: 0 });

    // ════════════════════════════════════════════════════════════════════════
    // FOLDER LINK
    // ════════════════════════════════════════════════════════════════════════
    } else {
      const fKeyHex  = Buffer.from(key, 'base64').toString('hex');
      const apiUrl   = `${API_BASE}?n=${id}`;
      const postBody = JSON.stringify([{ a: 'f', c: 1, ca: 1, r: 1 }]);

      log('NOTICE  | Fetching folder metadata…');
      let res;
      {
        let lastErr;
        for (let retry = 0; retry < 5; retry++) {
          try {
            res = await apiPost(postBody, apiUrl);
            checkApiResponse(res);
            break;
          } catch (e) {
            network.interruption(e);
            lastErr = e;
            log(`NOTICE  | Folder metadata fetch failed (attempt ${retry + 1}/5): ${e.message}. Retrying…`);
            await sleep(1000 * (2 ** retry) + jitter(1000));
          }
        }
        if (res === undefined) {
          throw new Error(`Failed to fetch folder metadata after 5 attempts: ${lastErr.message}`);
        }
      }
      const items = (Array.isArray(res) ? res[0] : res).f || [];

      const rawFolders = items.filter(i => i.t === 1);
      const rawFiles   = items.filter(i => i.t === 0);
      if (rawFiles.length >= 200) log(`NOTICE  | Large folder (${rawFiles.length} files). Parsing…`);

      // Identify the root folder robustly: the root is the one folder whose `h`
      // does not appear as the `p` (parent) of any other folder. This is immune
      // to changes in the order that MEGA's API returns nodes.
      const allHandles      = new Set(items.map(i => i.h));
      const rootFolder      = rawFolders.find(f => !allHandles.has(f.p)) ?? rawFolders.find(f => f.h === id);
      const rootH           = rootFolder?.h ?? null;

      const folderMap = {};
      rawFolders.forEach(f => {
        const fallback = { name: `folder-${f.h}`, nameKnown: false, parent: f.h === rootH ? null : (f.p || null) };
        try {
          const rawKey = extractNodeKey(f.k || '', id, rootH);
          if (!rawKey) { folderMap[f.h] = fallback; return; }
          const decKeyHex = decryptECB(rawKey, fKeyHex);
          const name = decryptAttr(f.a, decKeyHex);
          folderMap[f.h] = name ? { ...fallback, name, nameKnown: true } : fallback;
        } catch (error) { network.interruption(error); folderMap[f.h] = fallback; }
      });

      const fileMap = {};
      rawFiles.forEach(f => {
        fileMap[f.h] = prepareFolderFile(f, id, rootH, fKeyHex);
      });

      let fileList = buildFilePaths(folderMap, fileMap);

      if (fileInFolder) {
        log('NOTICE  | File detected in folder link. Downloading single file.');
        fileList = fileList.filter(f => f.hash === fileInFolder);
        if (fileList.length === 0) throw new Error('Specified file handle not found in folder.');
      }

      if (subfolderHandle && !fileInFolder) {
        log(`NOTICE  | Subfolder link detected (${subfolderHandle}). Filtering files…`);
        fileList = fileList.filter(f => isDescendantOf(f.hash, subfolderHandle, fileMap, folderMap));
        if (fileList.length === 0) throw new Error(`No files found under subfolder handle: ${subfolderHandle}`);
        log(`NOTICE  | ${fileList.length} file(s) matched under subfolder.`);
      }

      if (relPath && !fileInFolder) {
        const filtered = selectRelativeFolderFiles(fileList, fileMap, folderMap, rootH, relPath);
        if (filtered.length === 0) throw new Error(`No matches found for path: ${relPath}`);
        log(`NOTICE  | Found ${filtered.length} match(es) for "${relPath}"!`);
        fileList = filtered;
      }

      const readyFiles = fileList.filter(({ hash }) => !fileMap[hash].errorCode);
      const totalBytes = fileList.reduce((s, { hash }) => s + (fileMap[hash]?.size || 0), 0);
      onBatchStart({ totalFiles: fileList.length, totalBytes,
        unknownSizeFiles: fileList.filter(({ hash }) => !fileMap[hash].sizeKnown).length });
      log(`NOTICE  | ${fileList.length} files, ${totalBytes} bytes total.`);
      for (const { hash, fullPath } of fileList) {
        const file = fileMap[hash];
        if (!file.errorCode) continue;
        log(`ERROR   | ${fullPath} (${hash}): ${file.errorCode} — ${file.errorMessage}`);
        onFileComplete({ nodeHandle: hash, fileName: fullPath, fileSize: file.size, sizeKnown: file.sizeKnown,
          errorCode: file.errorCode, errorMessage: file.errorMessage,
          success: false, skipped: false, canceled: false, duration: 0 });
      }
      try {
        const destinations = new Set();
        for (const { fullPath } of readyFiles) {
          const destination = downloadDestinationKey(path.join(outputDir, fullPath));
          if (destinations.has(destination)) throw new Error('Multiple folder files map to the same output path: ' + fullPath);
          destinations.add(destination);
        }
      } catch (error) {
        network.interruption(error);
        // Preflight stops the whole folder before writes. Retain its inventory
        // and key failures rather than reducing it to one anonymous job error.
        for (const { hash, fullPath } of readyFiles) onFileComplete({ nodeHandle: hash,
          fileName: fullPath, fileSize: fileMap[hash].size, success: false, skipped: false,
          errorCode: 'FOLDER_OUTPUT_CONFLICT', errorMessage: error.message, duration: 0 });
        throw error;
      }

      // ── Phase 1: parallel initial pass ─────────────────────────────────────
      //
      // Each file gets up to FILE_RETRY_DELAYS_MS.length quick retries before
      // being promoted to the failed queue.  onFileComplete is deliberately
      // deferred for queued failures so the renderer's progress counter stays
      // accurate until the file is either recovered or permanently abandoned.

      let failedItems = []; // items promoted to the retry queue

      const sem = new Semaphore(threads);
      const initialResults = await Promise.allSettled(readyFiles.map(async ({ hash, fullPath }) => {
        await sem.acquire();
        if (_abortFlag || _skipFlag) { sem.release(); return; }
        try {
          const { key: fk, iv: fiv, metaMac, size } = fileMap[hash];
          const filePostBody = JSON.stringify([{ a: 'g', n: hash, g: 1 }]);

          const { skipped, duration } = await attemptFileWithRetries(
            () => downloadSingleFile(
              fullPath, size, fk, fiv, metaMac,
              filePostBody, apiUrl, outputDir,
              log, onProgress, proxy, onDecryptProgress, chunkSz, streamMode, streamMethod,
              streamMode ? onMediaInfo : null, streamMode ? onStreamUrl : null, onSparsePreview
            ),
            log, fullPath
          );
          onFileComplete({ nodeHandle: hash, fileName: fullPath, fileSize: size, skipped, success: true, duration });

        } catch (e) {
          network.interruption(e);
          if (e.message === 'Skipped by user') {
            log(`NOTICE  | ${fullPath}: skipped by user.`);
            onFileComplete({
              nodeHandle: hash, fileName: fullPath, fileSize: fileMap[hash]?.size || 0,
              skipped: true, success: false, duration: 0,
            });
          } else if (e.message === 'Aborted by user') {
            // Aborted files are not retried — report failure immediately so
            // the renderer's file counter stays consistent.
            log(`NOTICE  | ${fullPath}: download aborted.`);
            onFileComplete({
              nodeHandle: hash, fileName: fullPath, fileSize: fileMap[hash]?.size || 0,
              skipped: false, success: false, canceled: true, duration: 0,
            });
          } else {
            // All quick retries exhausted — promote to the retry queue.
            // Do NOT call onFileComplete yet; that happens inside runFailedQueue.
            log(
              `ERROR   | ${fullPath}: all quick retries exhausted — ` +
              `${e.message}. Added to retry queue.`
            );
            failedItems.push({ hash, fullPath });
          }
        } finally {
          sem.release();
        }
      }));

      const interrupted = initialResults.find(result => result.status === 'rejected');
      if (interrupted) throw interrupted.reason;

      // ── Phase 2: failed-queue retry rounds ─────────────────────────────────
      if (failedItems.length > 0 && !_abortFlag && !_skipFlag) {
        log(
          `NOTICE  | Initial pass complete. ` +
          `${failedItems.length} file(s) entering retry queue.`
        );
        await runFailedQueue(
          failedItems, fileMap, apiUrl, outputDir,
          log, onProgress, onFileComplete, proxy, onDecryptProgress, chunkSz, streamMode, streamMethod, onMediaInfo, onStreamUrl, onSparsePreview
        );
      }

      onDone({ duration: Date.now() - wallStart, ...summary(), skipped: _skipFlag && !_abortFlag, canceled: _abortFlag });
    }

  } catch (e) {
    network.interruption(e);
    const wasSkipped  = e.message === 'Skipped by user';
    const wasAborted  = e.message === 'Aborted by user';
    if (wasSkipped) log(`NOTICE  | Skipped by user.`);
    else if (wasAborted) log(`NOTICE  | Download aborted.`);
    else log(`ERROR   | ${e.message}`);
    // Do not call onError — that pauses the queue. Signal completion with a
    // failure count instead so the queue moves on to the next item.
    onDone({ duration: Date.now() - wallStart, ...summary(),
      failedFiles: Math.max(summary().failedFiles, wasSkipped || wasAborted ? 0 : 1), skipped: wasSkipped, canceled: wasAborted });
  }
}

module.exports = {
  installDownloadVpn,
  startDownload: async (args, callbacks) => {
    if (_downloadRunning) return;
    _downloadRunning = true; _abortFlag = false; _skipFlag = false;
    let done, failure, plannedFiles = 1, completedFiles = 0, failedFiles = 0, succeededFiles = 0;
    const wallStart = Date.now();
    const session = _session = createDownloadSession({ network, service: vpnService, streamMode: args.streamMode,
      onState: callbacks.onVpnState, onSpeed: callbacks.onSpeed });
    try {
      await session.run(() => {}); // Gate even metadata parsing and queued startup.
      await startDownload(args, { ...callbacks,
        onBatchStart: result => { plannedFiles = result.totalFiles; callbacks.onBatchStart(result); },
        onFileComplete: result => {
          completedFiles++;
          if (result.success && !result.canceled) succeededFiles++;
          else if (!result.canceled && !result.skipped) failedFiles++;
          callbacks.onFileComplete(result);
        },
        onDone: result => { done = result; }, onError: error => { failure = error; } });
    } catch (error) {
      callbacks.onLog(error.message);
      if (error.cancelled || error.skipped) done = { duration: Date.now() - wallStart, totalFiles: plannedFiles, completedFiles, failedFiles, succeededFiles,
        canceled: !error.skipped, skipped: Boolean(error.skipped) };
      else failure = error;
    } finally {
      await session.close(); _session = null; _downloadRunning = false;
    }
    if (failure) callbacks.onError(failure);
    else if (done) callbacks.onDone(done);
  },
  abortDownload, skipCurrentDownload,
  resolveFolderFileLink: network.wrap('metadata', resolveFolderFileLink),
  resolveFileForStreaming: network.wrap('metadata', resolveFileForStreaming),
  openDecryptedStream,
};
