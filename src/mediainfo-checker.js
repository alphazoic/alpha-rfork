'use strict';

const network = require('./network-operations');

const fs            = require('fs');
const { spawn }      = require('child_process');
const { getBinPath } = require('../binPath');
const { resolveFileForStreaming, openDecryptedStream } = require('./downloader');

// How long the CDN→mediainfo pipe may sit with no new bytes flowing before
// we conclude mediainfo has read everything it needs and tear down the CDN
// connection (which is otherwise blocked forever writing into a full pipe
// buffer that nothing is draining anymore).
const IDLE_MS = 2000;

// Once this many decrypted bytes have been forwarded to mediainfo we close
// its stdin and let it flush the report from what it has.  Container format
// headers live in the first few kilobytes to megabytes; 5 MB is a generous
// margin that covers MKV, MP4 fast-start, AVI, FLV, etc. without downloading
// the whole file.
const ENOUGH_BYTES = 5 * 1024 * 1024;

// Absolute safety net — if nothing has flowed at all in this long, something
// is wrong (bad link, dead network, missing binary) and we give up rather
// than hang the UI indefinitely.
const HARD_TIMEOUT_MS = 90_000;

// mediainfo isn't bundled for Linux (see upload-engine's getMediaInfo()) —
// fall back to a system-installed copy on PATH when the bundled one is
// missing, same convention used there.
function resolveMediainfoCmd() {
  const bundled = getBinPath('mediainfo');
  if (fs.existsSync(bundled)) return bundled;
  if (process.platform !== 'win32') return 'mediainfo';
  return bundled; // Windows always expects the bundled .exe — let it fail with a clear ENOENT below if missing.
}

/**
 * Streams a MEGA file straight from the CDN through our own AES-128-CTR
 * decryptor into `mediainfo -`, and resolves with the plain-text mediainfo
 * report. Nothing touches disk and no external downloader binary is used —
 * this works for plain file links and folder-derived single-file links
 * alike, since both resolve through the same internal downloader code path.
 *
 * The CDN connection doesn't stop on its own once mediainfo has what it
 * needs, so we watch for a stall (no new bytes for IDLE_MS) or hitting
 * ENOUGH_BYTES and then close mediainfo's stdin ourselves, letting it flush
 * its report — mirroring what happens when a person manually presses Ctrl+C
 * on the equivalent shell pipeline.
 *
 * @param   {string} url  A MEGA file link (https://mega.nz/file/ID#KEY… or
 *                         a folder sub-file link, …/folder/ID#KEY/file/HANDLE)
 * @returns {Promise<string>} the raw mediainfo report text
 */
async function getMediaInfoFromUrl(url) {
  const { downloadUrl, fileKey, fileIv } = await resolveFileForStreaming(url);

  return new Promise((resolve, reject) => {
    const mediainfoCmd = resolveMediainfoCmd();
    const mediainfo    = spawn(mediainfoCmd, ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const { stream: decryptedStream, abort } = openDecryptedStream(downloadUrl, fileKey, fileIv);

    let settled             = false;
    let totalBytes          = 0;
    let lastDataAt          = Date.now();
    let sourceErr           = '';
    let mediainfoStderr     = '';
    const mediainfoChunks   = [];
    let mediainfoStdinEnded = false;

    function killMediainfo() {
      if (!mediainfo || mediainfo.killed) return;
      try { mediainfo.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { if (!mediainfo.killed) mediainfo.kill('SIGKILL'); } catch { /* already gone */ } }, 1000);
    }

    // Send EOF to mediainfo's stdin and tear down the CDN stream.  Called
    // once we have accumulated ENOUGH_BYTES, the download stalls, or the
    // stream finishes naturally (small file).  Idempotent — safe to call
    // multiple times.
    function endMediainfoStdin() {
      if (mediainfoStdinEnded) return;
      mediainfoStdinEnded = true;
      abort();
      try { mediainfo.stdin.end(); } catch { /* already closed */ }
    }

    function finish(err, report) {
      if (settled) return;
      settled = true;
      clearInterval(idleTimer);
      clearTimeout(hardTimer);
      abort();
      killMediainfo();
      if (err) reject(err);
      else resolve(report);
    }

    // Manually forward chunks so we can cut the feed after ENOUGH_BYTES.
    // Using .pipe() would forward indefinitely; mediainfo reads stdin until
    // EOF before writing any output, so we must send EOF ourselves once it
    // has enough data to parse the format headers.
    decryptedStream.on('data', chunk => {
      totalBytes += chunk.length;
      lastDataAt  = Date.now();
      if (!mediainfoStdinEnded) {
        try { mediainfo.stdin.write(chunk); } catch { /* stdin closed early */ }
        if (totalBytes >= ENOUGH_BYTES) {
          endMediainfoStdin(); // enough header data — signal EOF to mediainfo
        }
      }
    });

    // If the stream finishes naturally before ENOUGH_BYTES (small file),
    // forward EOF to mediainfo so it can flush its report.
    decryptedStream.on('end', () => endMediainfoStdin());
    decryptedStream.on('error', err => {
      sourceErr = err.message;
      endMediainfoStdin();
    });

    mediainfo.stdout.on('data', chunk => mediainfoChunks.push(chunk));
    mediainfo.stderr.on('data', chunk => { mediainfoStderr += chunk.toString(); });
    mediainfo.on('error', err => finish(new Error(`Could not start mediainfo: ${err.message}`)));

    // mediainfo closing — whether because we forced EOF via the stall
    // detector below, or because it exited on its own (e.g. bad input) — is
    // our completion signal.
    mediainfo.on('close', () => {
      const report = Buffer.concat(mediainfoChunks).toString('utf8');
      if (report.trim()) {
        finish(null, report);
      } else {
        const errText = sourceErr.trim() || mediainfoStderr.trim() ||
        'mediainfo produced no output for this file — the link may be invalid, expired, or point to an unsupported file.';
      finish(new Error(errText));
      }
    });

    // ── Stall detector ──────────────────────────────────────────────────────
    const idleTimer = setInterval(() => {
      if (settled || mediainfoStdinEnded) return;
      if (totalBytes > 0 && (Date.now() - lastDataAt) >= IDLE_MS) {
        endMediainfoStdin(); // data stalled — tell mediainfo to flush what it has
      }
    }, 250);

    const hardTimer = setTimeout(() => {
      finish(new Error('Timed out waiting for mediainfo — the link may be invalid or unreachable.'));
    }, HARD_TIMEOUT_MS);
  });
}

module.exports = { getMediaInfoFromUrl: network.wrap('mediainfo', getMediaInfoFromUrl) };
