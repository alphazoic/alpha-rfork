// 'use strict';

const network = require('./network-operations');
const { toolDisplayName } = require('./tool-names');
const { createUploadJournal, uploadUncertain, recordUploadCompletion } = require('./upload-journal');
const { uploadWithRfork } = require('./rfork-upload');
const { normalizeRforkSettings, summarizeRforkSettings } = require('./rfork-settings');
const { rforkEnvironment } = require('./rfork-environment');

const { createUploadVpnSession } = require('./upload-vpn-session');
let uploadVpn = null, uploadSession = null;
function installUploadVpn(service) { uploadVpn = service; }
function spawn(...args) {
  const proc = network.spawnNetwork(...args);
  if (['put', 'copy', 'copyto'].includes(args[1]?.[0])) uploadSession?.observe(proc);
  return proc;
}
function uploadQuotaProbe(proc) {
  let text = '', overQuota = false;
  const read = data => {
    text = (text + data.toString()).slice(-8192);
    if (isOverQuotaError(text)) overQuota = true;
  };
  proc.stdout?.on('data', read); proc.stderr?.on('data', read);
  return () => {
    if (!overQuota) return null;
    const error = new Error('MEGA reported storage exhaustion.'); error.overQuota = true; return error;
  };
}
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

const { loadConfig, getDataDir, getFileCsv, getAccountCsv, getMediainfoLog }  = require('./config');
const { walkDir, parseCSVLine, formatFileSize, formatSpeed, isOverQuotaError } = require('./utils');
const { runCommand, runCommandWithProgress, runCommandWithTimeout, execRetry } = require('./proc-utils');
const { megaCmdBin, megaEnv, megaSpawnOpts,
  ensureMegaCmdServer, megaSwitch, getMegacmdFolderLink }               = require('./megacmd');
  const { obscurePass }                                                        = require('./rclone');
  const { updateAccountRow, touchAccountRow,
    markAccountOverQuota }                                                      = require('./account-manager');
    const { getBinPath }                                                          = require('../binPath');
    const { computeSmartUploadOrder }                                             = require('./smartOrdering');
    const { registerMegaAccount }                                                 = require('./account-creator');
    const { queryActualUsageKb }                                                  = require('./account-usage');

// ── Constants ─────────────────────────────────────────────────────────────────
const TEMP_DIR            = path.join(os.homedir(), 'mega_temp');

// How long (ms) a file upload may report zero progress before being treated as
// a silent stall.  MEGA silently stops accepting data when an account is full
// rather than sending an error, so stall detection is the only reliable signal.
const STALL_TIMEOUT_MS    = 90 * 1000; // 90 seconds

// If a megacmd upload exits in under this many ms for a file larger than
// SUSPICIOUSLY_FAST_MIN_SIZE, and no progress was ever reported, we treat it as
// a "ghost upload" — the process exited 0 without actually transferring data.
const SUSPICIOUSLY_FAST_MIN_SIZE = 1024 * 1024; // 1 MB

// ── Upload state (module-level so cancel IPC can reach live processes) ─────────
let _upCancelFlag   = false;  // set true when user cancels the active file
let _upKillFlag     = false;  // set true by killQueue — aborts account creation too
let _upCurrentProc  = null;   // reference to the live upload child process
let _upSkipSet      = new Set();
let _upPendingQueue = [];
let _upAddedCount   = 0;      // files injected mid-run via addFilesToQueue; absorbed into totalCount before each up:status
let _stalledTools   = new Map(); // file path → Set of tool names that stalled on this file
let _uploadRunning  = false;

let _upCurrentSetupProc = null; // tracks any running setup subprocess so killQueue() can terminate it immediately

// Smart-ordering state — set once per upload run, read by addFilesToQueue for mid-session re-planning
let _smartOrderingEnabled  = false; // whether smart ordering was requested for this run
let _smartOrderingCapBytes = 0;     // accountThresholdKb * 1024 — the per-account ceiling in bytes
let _currentUsageKb        = 0;     // mirrors usageKb so addFilesToQueue can re-plan correctly mid-run

function _trackProc(proc) {
  _upCurrentSetupProc = proc;
  // If killQueue() already fired before this process was registered (e.g. execRetry
  // spawned a retry after the previous process was killed), terminate it immediately
  // so it cannot run to completion and produce output the engine will act on.
  if (_upKillFlag && proc && !proc.killed) {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

// Delay that resolves normally but rejects immediately when _upKillFlag is set.
// Used inside pollForConfirmLink loops so they can be interrupted mid-wait.
function cancellableDelay(ms) {
  return new Promise((resolve, reject) => {
    const step = 250;
    let elapsed = 0;
    const tick = () => {
      if (_upKillFlag) { reject(new Error('Killed')); return; }
      elapsed += step;
      if (elapsed >= ms) { resolve(); return; }
      setTimeout(tick, Math.min(step, ms - elapsed));
    };
    setTimeout(tick, Math.min(step, ms));
  });
}

// Returns true when the error looks like a transient network / SSL problem rather
// than a logical MEGA error (bad password, suspended account, etc.).
function isTransientNetworkError(err) {
  if (err.rforkPreCommit && err.transientNetwork) return true;
  const msg = (err.message || '').toLowerCase();
  return /ssl|curl error|http post failed|econnreset|etimedout|enotfound|econnrefused|socket hang|network/i.test(msg);
}

// Calls fn() and, when it throws a transient network error, waits cooldownMs
// then retries — up to maxRetries times.  CancelledErrors and kill-flags pass through immediately.
async function withNetworkRetry(fn, send, label, maxRetries = 3, cooldownMs = 60000) {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      network.interruption(err);
      if (err.cancelled || _upKillFlag) throw err;
      if (attempt <= maxRetries && isTransientNetworkError(err)) {
        const waitSec = Math.round(cooldownMs / 1000);
        send('up:log', `[network] ${label} hit a connection error — waiting ${waitSec}s before retry ${attempt}/${maxRetries}… (${(err.message || '').trim().slice(0, 150)})`);
        await cancellableDelay(cooldownMs);
        if (_upKillFlag) throw err;
        continue;
      }
      throw err;
    }
  }
}

// ── MediaInfo helper ──────────────────────────────────────────────────────────
// Tries the bundled binary first, then falls back to a system-installed mediainfo
// so that Linux (which ships no bundled copy in bin/linux/) works when mediainfo
// is available on the system PATH.
let _mediainfoWarned = false;

async function getMediaInfo(filePath, send) {
  const bundledPath = getBinPath('mediainfo');
  const candidates  = process.platform !== 'win32'
    ? [bundledPath, 'mediainfo']
    : [bundledPath];

  for (const cmd of candidates) {
    try {
      return await runCommand(cmd, [filePath]);
    } catch (err) {
      network.interruption(err);
      const notFound = err.code === 'ENOENT' || /ENOENT|not found|no such file/i.test(err.message || '');
      if (!notFound) {
        send('up:log', `[mediainfo] Error running ${path.basename(cmd)}: ${err.message}`);
        return null;
      }
    }
  }

  if (!_mediainfoWarned) {
    _mediainfoWarned = true;
    send('up:log',
         '[mediainfo] Binary not found — skipping. ' +
         'Install mediainfo via your system package manager ' +
         '(e.g. apt install mediainfo on Linux, brew install mediainfo on Mac) ' +
         'or place the binary in the appropriate bin/ subfolder.'
    );
  }
  return null;
}

// ── Main upload entry point ───────────────────────────────────────────────────
// walkDir is passed in from main.js (which already has it for initCSVFiles).
async function startUpload({ queue, resumeAccount, manualEmail, manualPassword, folderName, createToolOrder, uploadToolOrder, smartOrderingEnabled }, send) {
  const uploadFolder = (folderName || 'folder').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'folder';

  if (_uploadRunning) {
    send('up:log', 'An upload is already in progress. Please wait for it to finish before starting another.');
    send('up:complete', null);
    return;
  }
  _upKillFlag    = false;
  _uploadRunning = true;
  _upAddedCount  = 0;

  let currentFolderLink = '';
  const tempParts       = new Set();

  class CancelledError extends Error {
    constructor() { super('Upload cancelled by user'); this.cancelled = true; }
  }

  try {
    _upSkipSet.clear();

    if (!getDataDir()) {
      send('up:log', 'Error: No data folder configured. Go to Settings and set a Data Folder before uploading.');
      send('up:complete', null);
      return;
    }
    const journal = createUploadJournal(getDataDir());
    journal.assertClear();
    let rforkRecord = null;

    // Kill-aware subprocess wrappers — register each spawned process with _trackProc so
    // killQueue() can terminate it immediately instead of waiting for the current await to finish.
    //
    // execT races execRetry against a 250 ms kill-flag poller.  Without this, the
    // inter-retry back-off sleep inside execRetry has no awareness of _upKillFlag and
    // blocks Kill Queue for the full delay duration (observed: ~13 s).
    // rwtT uses a pre-flight check only — runCommandWithTimeout is a single-shot spawn
    // so it resolves as soon as proc.on('close') fires after _trackProc kills it.
    const execT = (cmd, args, opts) => {
      if (_upKillFlag) return Promise.reject(new CancelledError());
      return new Promise((resolve, reject) => {
        let done = false;
        const killPoll = setInterval(() => {
          if (_upKillFlag && !done) {
            done = true;
            clearInterval(killPoll);
            reject(new CancelledError());
          }
        }, 250);
        execRetry(cmd, args, opts, undefined, undefined, undefined, _trackProc)
        .then(v  => { if (!done) { done = true; clearInterval(killPoll); if (_upKillFlag) reject(new CancelledError()); else resolve(v); } })
        .catch(e => { if (!done) { done = true; clearInterval(killPoll); reject(e); } });
      });
    };
    const rwtT  = async (cmd, args, opts, ms) => {
      if (_upKillFlag) throw new CancelledError();
      return runCommandWithTimeout(cmd, args, opts, ms, _trackProc);
    };

    const cfg = loadConfig();
    const rforkSettings = normalizeRforkSettings(cfg.rforkUpload);
    const splitThresholdKb   = (parseFloat(cfg.splitThresholdGb)   || 19.5) * 1024 * 1024;
    const accountThresholdKb = (parseFloat(cfg.accountThresholdGb) || 19.5) * 1024 * 1024;
    const activeTempDir = (cfg.tempDir || '').trim() || TEMP_DIR;
    if (!fs.existsSync(activeTempDir)) fs.mkdirSync(activeTempDir, { recursive: true });
    // Capture for this run — reuse the exact same constant so byte semantics match the real check
    _smartOrderingEnabled  = !!(smartOrderingEnabled);
    _smartOrderingCapBytes = accountThresholdKb * 1024; // KB → bytes, same unit as fs.statSync().size

    send('up:log', 'Analyzing Queue...');

    let processedQueue = [];
    // partGroupTotalKb / partGroupChecked intentionally removed.
    // Each archive part is treated as an independent file so the normal per-file
    // account-threshold check fires for every part, letting the queue roll to a
    // new account naturally as usageKb accumulates.  The old "check once, fit all
    // parts on one account" approach failed whenever the total archive size
    // exceeded one account's capacity.

    for (const item of queue) {
      const stat = fs.statSync(item);
      if (stat.isFile()) {
        processedQueue.push(item); // large files are archived lazily when the queue reaches them
      } else if (stat.isDirectory()) {
        const files = walkDir(item);
        send('up:log', `Scanned folder: ${path.basename(item)} — ${files.length} file(s) found (all subdirectories included).`);
        processedQueue.push(...files);
      }
    }

    _upPendingQueue = [...processedQueue];

    let currentEmail = '', currentPass = '', usageKb = 0;

    // ── createAccount ─────────────────────────────────────────────────────────
    async function createAccount() {
      if (_upKillFlag) throw new CancelledError();
      if (currentEmail) updateAccountRow(currentEmail, usageKb);
      usageKb = 0;
      _currentUsageKb = 0; // keep mid-session planner in sync whenever we roll to a fresh account

      // Registration is now handled by the shared helper in account-creator.js.
      // It generates the password, uses the selected mail source, confirms signup,
      // and appends the new row to account_log.csv before returning.
      const { email, password, registeredWith } = await registerMegaAccount({
        createToolOrder,
        send,
        shouldAbort:      () => _upKillFlag,
                                                                            trackProc:        _trackProc,
                                                                            execT,
                                                                            rwtT,
                                                                            cancellableDelay,
      });
      currentEmail = email;
      currentPass  = password;

      // Post-registration: create folder and get folder link (upload-specific)
      if (_upKillFlag) throw new CancelledError();
      usageKb = 0;
      currentFolderLink = '';

      if (registeredWith === 'megatools') {
        // MEGA can take a few seconds to fully propagate a newly verified account.
        // Hitting mkdir immediately after verification often gets EEXPIRED from the
        // 'us' session endpoint. Pause first, then retry up to 3 times.
        await cancellableDelay(3000);
        if (_upKillFlag) throw new CancelledError();
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await rwtT(getBinPath('megatools'), ['mkdir', '-u', currentEmail, '-p', currentPass, `/Root/${uploadFolder}`], { stdio: 'pipe' }, 30000);
            break;
          } catch (mkdirErr) {
            network.interruption(mkdirErr);
            if (_upKillFlag) throw new CancelledError();
            if (attempt < 3) {
              send('up:log', `[folder setup] megatools mkdir attempt ${attempt}/3 failed (${mkdirErr.message}) — retrying… [megatools]`);
              await cancellableDelay(4000);
            } else {
              send('up:log', `[folder setup] megatools mkdir failed after 3 attempts: ${mkdirErr.message} — will retry folder link after upload. [megatools]`);
            }
          }
        }
        if (_upKillFlag) throw new CancelledError();
        currentFolderLink = '';
      } else {
        try { await rwtT(megaCmdBin(), ['mkdir', '-p', `/${uploadFolder}`], megaSpawnOpts(), 30000); } catch { /* fine */ }
        if (_upKillFlag) throw new CancelledError();
        currentFolderLink = await getMegacmdFolderLink(`/${uploadFolder}`, send, _trackProc);
      }

      send('up:account', { email: currentEmail, password: currentPass, usageKb });
      if (registeredWith !== 'megatools') send('up:folderLink', { link: currentFolderLink, tool: registeredWith });
    }

    // ── setupExistingAccount — folder mkdir + link for manual/resume paths ────
    async function setupExistingAccount(email, pass) {
      // Respect the user's forced/ordered tool selection (browser can't do folder setup)
      const order = (uploadToolOrder || []).filter(t => t !== 'browser');
      const effectiveOrder = order.length ? order : ['megatools', 'megacmd', 'rclone'];

      for (const tool of effectiveOrder) {
        if (_upKillFlag) throw new CancelledError();
        try {
          if (tool === 'megatools') {
            // megatools cannot generate valid folder links (the decryption key is never
            // included in its output), so we never attempt link extraction here.
            // Just verify account access and ensure the target folder exists.
            let folderLs = await execT(getBinPath('megatools'), ['ls', '-u', email, '-p', pass, '/Root/']);
            const folderExists = folderLs.split('\n').some(line => line.trim() === uploadFolder || line.trim().endsWith(`/${uploadFolder}`));
            if (!folderExists) {
              try {
                await rwtT(getBinPath('megatools'), ['mkdir', '-u', email, '-p', pass, `/Root/${uploadFolder}`], { stdio: 'pipe' }, 30000);
              } catch (mkdirErr) {
                network.interruption(mkdirErr);
                send('up:log', `[folder setup] megatools mkdir: ${mkdirErr.message} [megatools]`);
              }
            }
            currentFolderLink = '';
            return tool;

          } else if (tool === 'megacmd') {
            await ensureMegaCmdServer(_trackProc);
            await megaSwitch(email, pass, _trackProc);
            // megaSwitch does logout+login internally. MEGAcmd doesn't finish settling
            // the new session before returning, so issuing mkdir immediately can hang.
            // A short pause lets the server reach a stable state first.
            await cancellableDelay(1500);
            try { await rwtT(megaCmdBin(), ['mkdir', '-p', `/${uploadFolder}`], megaSpawnOpts(), 30000); } catch { /* fine */ }
            currentFolderLink = await getMegacmdFolderLink(`/${uploadFolder}`, send, _trackProc);
            return tool;

          } else if (tool === 'rclone') {
            const obscured = await obscurePass(pass);
            await rwtT(getBinPath('rclone'), ['mkdir', `:mega:${uploadFolder}`, '--mega-use-https=true'], { env: rforkEnvironment(email, obscured), stdio: 'pipe' }, 30000);
            currentFolderLink = '';
            return tool;
          }
        } catch (e) {
          network.interruption(e);
          if (_upKillFlag) throw new CancelledError();
          // If MEGA's storage-exceeded banner appears during setup, the account is
          // definitively full.  Mark it immediately and surface the error so the
          // caller (resume / manual paths) can rotate to a fresh account rather
          // than proceeding to upload — which would silently stall anyway.
          if (isOverQuotaError(e.message || '')) {
            send('up:log', `[folder setup] ${toolDisplayName(tool)} reports account is Over Quota — marking CSV and switching accounts… [${toolDisplayName(tool)}]`);
            markAccountOverQuota(currentEmail);
            const overQuotaErr = new Error(`Account ${currentEmail} is Over Quota`);
            overQuotaErr.overQuota = true;
            throw overQuotaErr;
          }
          const next = effectiveOrder[effectiveOrder.indexOf(tool) + 1];
          send('up:log', `[folder setup] ${toolDisplayName(tool)} failed (${e.message})${next ? `, trying ${toolDisplayName(next)}…` : ''} [${toolDisplayName(tool)}]`);
        }
      }
      return null;
    }

    // ── Per-file upload helpers ───────────────────────────────────────────────
    // Each returns the share link string ('' if link-fetch failed).
    // Throws CancelledError if user cancelled; throws Error on failure (triggers fallback).

    async function uploadFileWithMetatools(file, fName) {
      const fileSize = fs.statSync(file).size;
      const uploadStartTime = Date.now();
      let _everReportedProgress = false;
      return new Promise((resolve, reject) => {
        const workers    = Math.min(100, Math.max(1, parseInt(cfg.uploadWorkers,  10) || 3));
        const chunkSize  = parseInt(cfg.uploadChunkSize,  10) || 8388608;
        const bufferSize = parseInt(cfg.uploadBufferSize, 10) || 524288;
        const proc = spawn(getBinPath('megatools'), [
          'put', '--path', `/Root/${uploadFolder}/${fName}`,
          '-u', currentEmail, '-p', currentPass,
          '--workers',     String(workers),
          '--chunk-size',  String(chunkSize),
          '--buffer-size', String(bufferSize),
          ...(cfg.boostEnabled === false ? ['--disable-boost'] : []),
          file,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        _upCurrentProc = proc;

        const quotaError = uploadQuotaProbe(proc);
        proc.once('error', reject);

        let lastPct     = -1;
        let lastPctTime = Date.now();

        const handleMetatoolsData = data => {
          const output   = data.toString();
          const pctMatch = output.match(/(\d+\.\d+)%/);
          const spdMatch = output.match(/\(([\d.]+\s?[KMGT]?i?B\/s)\)/);
          if (pctMatch) {
            const newPct = parseFloat(pctMatch[1]);
            if (newPct !== lastPct) { lastPct = newPct; lastPctTime = Date.now(); }
            _everReportedProgress = true;
            send('up:progress', { filePct: newPct, speed: spdMatch ? spdMatch[1] : '...' });
          }
        };
        proc.stdout.on('data', handleMetatoolsData);
        proc.stderr.on('data', handleMetatoolsData);

        // Stall watchdog — fires if pct has not changed for STALL_TIMEOUT_MS.
        // MEGA silently caps accounts without returning an error code, so a frozen
        // percentage is the only reliable signal that the upload is going nowhere.
        const stallWatcher = setInterval(() => {
          if (uploadSession?.enabled) return; // A stall is not proof of storage exhaustion.
          if (_upCancelFlag) return;
          if (lastPct >= 0 && Date.now() - lastPctTime > STALL_TIMEOUT_MS) {
            send('up:log', `[stall] ${fName}: upload frozen at ${lastPct.toFixed(1)}% for >${Math.round(STALL_TIMEOUT_MS / 1000)}s — account may be full. Killing process. [megatools]`);
            clearInterval(stallWatcher);
            try { proc.kill(); } catch { /* ignore */ }
            const stallErr = new Error(`Upload stalled at ${lastPct.toFixed(1)}% — MEGA account likely full`);
            stallErr.stalled = true;
            reject(stallErr);
          }
        }, 15000);

        proc.on('close', code => {
          clearInterval(stallWatcher);
          _upCurrentProc = null;
          if (_upCancelFlag) { reject(new CancelledError()); return; }
          if (quotaError()) { reject(quotaError()); return; }
          const elapsed = Date.now() - uploadStartTime;
          if (code === 0 && fileSize > SUSPICIOUSLY_FAST_MIN_SIZE && !(_everReportedProgress || uploadSession?.observed)) {
            if (uploadSession?.enabled) { reject(new Error('Tool exited without verifiable progress; check the remote file.')); return; }
            send('up:log', `[stall] ${fName}: megatools exited in ${(elapsed / 1000).toFixed(1)}s with no progress for a ${formatFileSize(fileSize)} file — treating as ghost upload. [megatools]`);
            const stallErr = new Error('Ghost upload — megatools exited without transferring data');
            stallErr.stalled = true;
            reject(stallErr);
            return;
          }
          if (code === 0) resolve();
          else if (code === 2) {
            if (uploadSession?.enabled) { reject(new Error('Remote name already exists; verify its content before retrying.')); return; }
            send('up:log', `Note: ${fName} already exists on MEGA — fetching existing link. [megatools]`);
            resolve({ alreadyExisted: true });
          } else {
            reject(new Error(`megatools put exited with code ${code}`));
          }
        });
      }).then(async (resolveVal) => {
        if (_upKillFlag) return { link: '', alreadyExisted: resolveVal?.alreadyExisted };
        try {
          const lsOut    = await execRetry(getBinPath('megatools'), ['ls', '-e', '-u', currentEmail, '-p', currentPass, `/Root/${uploadFolder}/${fName}`]);
          const linkMatch = lsOut.match(/https:\/\/mega\.nz\/[^\s]*/);
          return { link: linkMatch ? linkMatch[0] : '', alreadyExisted: resolveVal?.alreadyExisted };
        } catch { return { link: '', alreadyExisted: resolveVal?.alreadyExisted }; }
      });
    }

    async function uploadFileWithMegacmd(file, fName) {
      const fileSize = fs.statSync(file).size;
      const uploadStartTime = Date.now();
      let _everReportedProgress = false;

      return new Promise((resolve, reject) => {
        const proc = spawn(megaCmdBin(), ['put', '-c', file, `/${uploadFolder}/`], { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        _upCurrentProc = proc;

        const quotaError = uploadQuotaProbe(proc);
        proc.once('error', reject);

        let _overQuotaRejected = false;
        const handleProgressData = data => {
          const output = data.toString();
          // Detect MEGA's storage-exceeded banner mid-upload — don't wait for the stall watchdog.
          if (!_overQuotaRejected && isOverQuotaError(output)) {
            _overQuotaRejected = true;
            send('up:log', `[quota] ${fName}: MEGA storage-exceeded banner detected — marking account and rotating immediately. [megacmd]`);
            try { proc.kill(); } catch { /* ignore */ }
            return;
          }
          for (const chunk of output.split(/[\r\n]/)) {
            const pctMatch = chunk.match(/(\d+(?:\.\d+)?)%/);
            const spdMatch = chunk.match(/([\d.]+\s*[KMGT]?i?B\/s)/i);
            if (pctMatch) {
              _everReportedProgress = true;
              send('up:progress', { filePct: parseFloat(pctMatch[1]), speed: spdMatch ? spdMatch[1] : '...' });
            }
          }
        };
        proc.stdout.on('data', handleProgressData);
        proc.stderr.on('data', handleProgressData);

        // Manually calculate speed via polling the transfers command
        let _lastKnownSpeed = '...';
        let _lastPollBytes  = null;
        let _lastPollTime   = null;
        let _lastProgressTime = Date.now(); // tracks last time doneBytes actually moved
        let _lastDoneBytes    = null;

        let _pollActive = false;
        let uploadClosed = false;
        const pollInterval = setInterval(async () => {
          if (_upCancelFlag || _pollActive) return;
          _pollActive = true;
          try {
            const now   = Date.now();
            const tOut  = await runCommandWithTimeout(megaCmdBin(), ['transfers'], megaSpawnOpts(), 5000);
            if (uploadClosed) return;
            const clean = tOut.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
            const m     = clean.match(/(\d+(?:\.\d+)?)%\s+of\s+([\d.]+)\s*(B|KB|MB|GB|TB)/i);
            if (!m) { _pollActive = false; return; }

            const pct       = parseFloat(m[1]);
            uploadSession?.percent(pct);
            const totalSize = parseFloat(m[2]);
            const unit      = m[3].toUpperCase();
            const multipliers = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
            const totalBytes  = totalSize * (multipliers[unit] ?? 1);
            const doneBytes   = (pct / 100) * totalBytes;

            // Track whether bytes are actually advancing (stall detection)
            if (_lastDoneBytes !== null && doneBytes > _lastDoneBytes) {
              _lastProgressTime = now;
            }
            _lastDoneBytes = doneBytes;
            _everReportedProgress = true;

            // Stall watchdog — if doneBytes hasn't moved in STALL_TIMEOUT_MS, abort.
            if (!uploadSession?.enabled && _lastDoneBytes !== null && now - _lastProgressTime > STALL_TIMEOUT_MS) {
              send('up:log', `[stall] ${fName}: upload frozen at ${pct.toFixed(1)}% for >${Math.round(STALL_TIMEOUT_MS / 1000)}s — account may be full. Killing process. [megacmd]`);
              clearInterval(pollInterval);
              try { proc.kill(); } catch { /* ignore */ }
              _pollActive = false;
              return;
            }

            if (_lastPollBytes !== null && _lastPollTime !== null) {
              const deltaBytes = doneBytes - _lastPollBytes;
              const deltaSec   = (now - _lastPollTime) / 1000;
              if (deltaSec > 0 && deltaBytes >= 0) {
                // Always update speed — shows 0 B/s when frozen instead of the
                // last real speed, which was misleading (stuck at 7.50 MB/s etc.)
                _lastKnownSpeed = formatSpeed(deltaBytes / deltaSec);
              }
            }
            _lastPollBytes = doneBytes;
            _lastPollTime  = now;
            send('up:progress', { filePct: pct, speed: _lastKnownSpeed });
          } catch { /* non-fatal */ }
          _pollActive = false;
        }, 2000);

        proc.on('close', code => {
          uploadClosed = true;
          clearInterval(pollInterval);
          _upCurrentProc = null;
          if (_upCancelFlag) { reject(new CancelledError()); return; }
          if (quotaError()) { reject(quotaError()); return; }
          // If the stall watchdog killed the process, _lastProgressTime will be
          // far in the past.  Emit a stall error so the caller can rotate accounts.
          if (!uploadSession?.enabled && _lastDoneBytes !== null && Date.now() - _lastProgressTime > STALL_TIMEOUT_MS) {
            const stallErr = new Error(`Upload stalled — MEGA account likely full`);
            stallErr.stalled = true;
            reject(stallErr);
            return;
          }
          // Ghost-upload detection: if the process exited quickly for a large file
          // and never reported any progress, the upload was silently swallowed
          // (e.g. MEGA rate-limited the account post-upload).  Treat as a stall.
          const elapsed = Date.now() - uploadStartTime;
          if (code === 0 && fileSize > SUSPICIOUSLY_FAST_MIN_SIZE && !(_everReportedProgress || uploadSession?.observed)) {
            if (uploadSession?.enabled) { reject(new Error('Tool exited without verifiable progress; check the remote file.')); return; }
            send('up:log', `[stall] ${fName}: megacmd exited in ${(elapsed / 1000).toFixed(1)}s with no progress for a ${formatFileSize(fileSize)} file — treating as ghost upload. [megacmd]`);
            const stallErr = new Error(`Ghost upload — megacmd exited without transferring data`);
            stallErr.stalled = true;
            reject(stallErr);
            return;
          }
          if (code === 0) resolve();
          else reject(new Error(`mega-put exited with code ${code}`));
        });
      }).then(async () => {
        if (_upKillFlag) return '';
        await cancellableDelay(2000);
        if (_upKillFlag) return '';
        try {
          const output = await rwtT(megaCmdBin(), ['export', '-f', '-a', `/${uploadFolder}/${fName}`],
            { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] }, 60000);
          return output.match(/https:\/\/mega\.nz\/[^\s]*/)?.[0] || '';
        } catch (error) {
          network.interruption(error);
          send('up:log', '[export] Share link unavailable; the completed upload is retained. [megacmd]');
          return '';
        }
      });
    }

    async function uploadFileWithRclone(file, fName) {
      let obscured;
      try { obscured = await obscurePass(currentPass); }
      catch (error) { error.rforkPreCommit = true; throw error; }
      const destination = `${uploadFolder}/${fName}`;
      const fileSize = fs.statSync(file).size;
      send('up:log', '[rfork] ' + summarizeRforkSettings(rforkSettings));
      rforkRecord = journal.begin({ account: currentEmail, destination, source: file, bytes: fileSize,
        ...(rforkSettings.resume ? { checkpoint: require('./rfork-checkpoints').newCheckpoint(rforkSettings), folderLink: currentFolderLink } : {}) });
      try {
        await uploadWithRfork({ binary: getBinPath('rclone'), source: file, destination, bytes: fileSize,
          env: rforkEnvironment(currentEmail, obscured), spawn, journal, record: rforkRecord, settings: rforkSettings,
          onDiagnostics(value) { send('up:log', '[rfork diagnostics] ' + JSON.stringify(value)); },
          onSpawn(proc) { _upCurrentProc = proc; }, cancelled: () => _upCancelFlag || _upKillFlag,
          onStats(stats) { send('up:progress', { filePct: fileSize ? Math.min(stats.bytes / fileSize * 100, 100) : 0, speed: formatSpeed(stats.speed) }); },
        });
      } catch (error) {
        if (error.rforkPreCommit || error.overQuota) rforkRecord = null;
        throw error;
      } finally { _upCurrentProc = null; }
      if (_upCancelFlag) throw new CancelledError();
      if (_upKillFlag) return '';
      try {
        const link = await execT(getBinPath('rclone'), ['link', ':mega:' + destination, '--mega-use-https=true'],
          { env: rforkEnvironment(currentEmail, obscured), stdio: 'pipe' });
        return link.match(/https:\/\/mega\.(?:co\.nz|nz)\/[^\s]+/)?.[0] || '';
      } catch (error) {
        // The file is committed. Export failure must never restart its upload.
        if (_upKillFlag) return '';
        network.interruption(error);
        send('up:log', '[export] Share link unavailable; the completed upload is retained. [rfork]');
        return '';
      }
    }

    // Rewrites CSV rows written during this session that have a blank folder-link
    // column (col 3) once the link becomes available after uploads complete.
    function backFillCsv(folderLink) {
      try {
        const csvPath = getFileCsv();
        if (!fs.existsSync(csvPath)) return;
        const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
        const updated = lines.map(line => {
          if (!line.trim()) return line;
          const cols = parseCSVLine(line);
          // col[3] = folderLink, col[4] = email, col[7] = folderName
          if (cols.length >= 8 && cols[3] === '' && cols[4] === currentEmail && cols[7] === uploadFolder) {
            cols[3] = folderLink;
            return cols.join(',');
          }
          return line;
        });
        fs.writeFileSync(csvPath, updated.join('\n'), 'utf8');
      } catch { /* non-fatal */ }
    }

    async function retryFolderLink() {
      if (currentFolderLink) return;
      if (_upKillFlag) return;
      send('up:log', '[folder link] Link was not retrieved during setup — retrying after uploads…');

      const order = (uploadToolOrder || []).filter(t => t !== 'browser');
      const effectiveOrder = order.length ? order : ['megatools', 'megacmd', 'rclone'];

      for (const tool of effectiveOrder) {
        try {
          if (tool === 'megatools') {
            continue; // megatools folder links are broken — skip entirely
          } else if (tool === 'megacmd') {
            await ensureMegaCmdServer(_trackProc);
            await megaSwitch(currentEmail, currentPass, _trackProc);
            const link = await getMegacmdFolderLink(`/${uploadFolder}`, send, _trackProc);
            if (link) {
              currentFolderLink = link;
              send('up:log', `[folder link] Retrieved via megacmd: ${currentFolderLink}`);
              send('up:folderLink', { link: currentFolderLink, tool: 'megacmd' });
              backFillCsv(currentFolderLink);
              return;
            }
          } else if (tool === 'rclone') {
            continue; // rclone cannot generate MEGA folder links
          }
        } catch { /* try next */ }
      }

      send('up:log', '[folder link] Could not retrieve folder link after retry — all tools failed.');
    }

    // ── Account strategy ──────────────────────────────────────────────────────
    if (manualEmail && manualPassword) {
      currentEmail = manualEmail;
      currentPass  = manualPassword;
      usageKb = 0;
      send('up:log', `Using manual account: ${currentEmail}`);
      let setupToolManual;
      try {
        setupToolManual = await setupExistingAccount(currentEmail, currentPass);
      } catch (setupErr) {
        network.interruption(setupErr);
        if (setupErr.overQuota && !_upKillFlag) {
          send('up:log', `[quota] Manual account ${currentEmail} is Over Quota — creating a fresh account instead…`);
          await withNetworkRetry(() => createAccount(), send, 'Account creation (manual-account over-quota)');
        } else { throw setupErr; }
      }
      if (setupToolManual) {
        send('up:log', `[storage check] Querying actual account storage via ${toolDisplayName(setupToolManual)}…`);
        const liveKb = await queryActualUsageKb(currentEmail, currentPass, setupToolManual, _trackProc);
        if (liveKb !== null) {
          usageKb = liveKb;
          touchAccountRow(currentEmail, setupToolManual);
          send('up:log', `[storage check] Account is using ${formatFileSize(usageKb * 1024)} — will create a new account if the next file would exceed ${cfg.accountThresholdGb || 19.5} GB.`);
        } else {
          send('up:log', `[storage check] Could not retrieve live storage — starting from 0 KB (conservative: any file exceeding ${cfg.accountThresholdGb || 19.5} GB alone will trigger a new account).`);
        }
      }
      send('up:account', { email: currentEmail, password: currentPass, usageKb });
      if (setupToolManual !== 'megatools') send('up:folderLink', { link: currentFolderLink, tool: setupToolManual });

    } else if (resumeAccount) {
      if (!fs.existsSync(getAccountCsv())) throw new Error('No account log found. Run a fresh upload first.');
      const rows = fs.readFileSync(getAccountCsv(), 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean).slice(1);
      if (rows.length === 0) throw new Error('account_log.csv has no account entries in the configured data folder. Run a fresh upload first.');
      const cols = parseCSVLine(rows[rows.length - 1]);
      currentEmail = cols[0].trim();
      currentPass  = cols[1].trim();
      usageKb = parseFloat(cols[2]) * 1024 * 1024 || 0;  // CSV fallback — overridden below if live query succeeds
      send('up:log', `Resuming account: ${currentEmail}`);
      let setupToolResume;
      try {
        setupToolResume = await setupExistingAccount(currentEmail, currentPass);
      } catch (setupErr) {
        network.interruption(setupErr);
        if (setupErr.overQuota && !_upKillFlag) {
          send('up:log', `[quota] Resumed account ${currentEmail} is Over Quota — creating a fresh account instead…`);
          await withNetworkRetry(() => createAccount(), send, 'Account creation (resume-account over-quota)');
        } else { throw setupErr; }
      }
      if (setupToolResume) {
        send('up:log', `[storage check] Querying actual account storage via ${toolDisplayName(setupToolResume)}…`);
        const liveKb = await queryActualUsageKb(currentEmail, currentPass, setupToolResume, _trackProc);
        if (liveKb !== null) {
          usageKb = liveKb;
          touchAccountRow(currentEmail, setupToolResume);
          send('up:log', `[storage check] Account is using ${formatFileSize(usageKb * 1024)} — will create a new account if the next file would exceed ${cfg.accountThresholdGb || 19.5} GB.`);
        } else {
          send('up:log', `[storage check] Could not retrieve live storage — using CSV value: ${formatFileSize(usageKb * 1024)}.`);
        }
      }
      send('up:account', { email: currentEmail, password: currentPass, usageKb });
      if (setupToolResume !== 'megatools') send('up:folderLink', { link: currentFolderLink, tool: setupToolResume });

    } else {
      await withNetworkRetry(() => createAccount(), send, 'Account creation');
    }

    // ── Smart ordering — offline BFD pass over the full pending queue ─────────
    // Runs once, before any upload starts, on the complete not-yet-started set.
    // The existing upload loop below consumes the reordered queue with zero
    // awareness that reordering happened — its logic is entirely unchanged.
    if (_smartOrderingEnabled && _upPendingQueue.length > 1) {
      _currentUsageKb = usageKb; // sync preloaded total for the currently-active account
      const soFiles = _upPendingQueue.map((p, i) => {
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* non-fatal — drive-wake handles inaccessible files */ }
        return { id: p, originalIndex: i, size };
      });
      const soResult = computeSmartUploadOrder(soFiles, _smartOrderingCapBytes, _currentUsageKb * 1024);
      _upPendingQueue = soResult.orderedFiles.map(f => f.id);
      send('up:log', `[smart ordering] Queue reordered — estimated ${soResult.bins.length} account(s) needed.`);
      if (soResult.oversizedFiles.length > 0) {
        const names = soResult.oversizedFiles.map(f => path.basename(f.id)).join(', ');
        send('up:log', `[smart ordering] ⚠ ${soResult.oversizedFiles.length} file(s) exceed the per-account limit on their own and will be handled individually: ${names}`);
      }
    } else {
      _currentUsageKb = usageKb; // still sync even when smart ordering is off
    }

    // ── Main upload loop ──────────────────────────────────────────────────────
    let totalCount     = _upPendingQueue.length;
    let processedCount = 0;
    const networkRetries = new Map(); // tracks transient-network retry attempts per file path
    const failedFiles    = [];        // files that failed all tools — retried once after queue drains
    let consecutiveAccountFailures = 0; // increments on every all-tool failure; resets on success or account switch; triggers rotation at 2

    // Tracks which upload tools have stalled for each file path.  When a stall
    // is detected on tool X, we record it here.  On retry, stalled tools are
    // moved to the end of the upload order so the next-priority tool is tried
    // first (e.g. megacmd stalls → megatools tried next, then rclone).
    _stalledTools = new Map();
    const splitGroups = new Map(); // origFilePath → { origName, parts, miText, collected }
    const partToOrig  = new Map(); // partPath     → origFilePath

    let _retryRound = 0;
    do {
      if (_retryRound > 0) {
        const waitMin = _retryRound; // cycle N waits N minutes (1+2+…+30 = 465 min total)
        send('up:log', `── Retry cycle ${_retryRound}/30: waiting ${waitMin} min before requeueing ${failedFiles.length} failed file(s) ──`);
        const waitMs = waitMin * 60 * 1000;
        const stepMs = 15 * 1000; // log a countdown tick every 15 s
        let waited   = 0;
        while (waited < waitMs && !_upKillFlag) {
          await new Promise(r => setTimeout(r, Math.min(stepMs, waitMs - waited)));
          waited += stepMs;
          if (!_upKillFlag && waited < waitMs) {
            const remaining = Math.ceil((waitMs - waited) / 60000);
            send('up:log', `[retry] ${remaining} min remaining before cycle ${_retryRound}/30…`);
          }
        }
        if (_upKillFlag) { failedFiles.length = 0; break; }
        _upPendingQueue = [...failedFiles];
        failedFiles.length = 0;
        processedCount = 0;
        totalCount     = _upPendingQueue.length;
        _upAddedCount  = 0;
      }
      _retryRound++;

      while (_upPendingQueue.length > 0) {
      if (_upKillFlag) break;
      const file  = _upPendingQueue.shift();
      const fName = path.basename(file);
      // ── Drive-wake retry ────────────────────────────────────────────────────
      // External drives can go to sleep between files.  Poll until the file is
      // accessible again (up to ~50 s), then fall through to the normal failure
      // path if it never comes back.
      let fSize;
      {
        const driveMaxAttempts = 10;
        const driveRetryMs     = 5000; // 10 × 5 s = 50 s max wait
        let driveErr;
        for (let a = 1; a <= driveMaxAttempts; a++) {
          try {
            fSize    = fs.statSync(file).size;
            driveErr = null;
            break;
          } catch (err) {
            network.interruption(err);
            driveErr = err;
            // Only treat ENOENT / EIO as a possible sleeping-drive condition.
            // Any other error (permissions, etc.) is surfaced immediately.
            if (err.code !== 'ENOENT' && err.code !== 'EIO') break;
            if (a === 1) {
              send('up:log', `[drive] ${fName} is unreachable (${err.code}) — external drive may be waking up, waiting…`);
            } else {
              send('up:log', `[drive] Still waiting for ${fName}… (attempt ${a}/${driveMaxAttempts})`);
            }
            if (a < driveMaxAttempts && !_upKillFlag) {
              await new Promise(r => setTimeout(r, driveRetryMs));
            }
          }
        }
        if (driveErr) {
          const msg = `Cannot access ${fName} after ${driveMaxAttempts} attempts: ${driveErr.message}`;
          send('up:log', msg);
          send('up:fileError', { file: fName, idx: processedCount, error: msg });
          failedFiles.push(file);
          continue; // skip to next file in the queue; this one re-enters via the retry-cycle backoff
        }
      }
      processedCount++;

      if (_upSkipSet.has(file) || _upSkipSet.has(fName)) {
        _upSkipSet.delete(file);
        _upSkipSet.delete(fName);
        send('up:fileSkipped', { file: fName });
        continue;
      }

      // ── Lazy archiving ────────────────────────────────────────────────────────
      // Files above the split threshold are archived here, on-demand, rather than
      // all upfront before the queue starts. If the file also won't fit on the
      // current account, account creation runs in parallel with the 7z process —
      // both are fully independent (CPU/disk vs. network) so neither waits on the
      // other. The original file is then replaced in the queue by its parts and
      // the loop continues; parts are processed by the normal upload path below.
      // ── Lazy archiving ───────────────────────────────────────────────────────
      // A file qualifies for archiving if it exceeds the split threshold AND is
      // not itself already a temp part produced by an earlier archive pass.
      if (!tempParts.has(file) && fSize / 1024 > splitThresholdKb) {
        send('up:log', `Archiving large file: ${fName}...`);
        send('up:archiveProgress', { file: fName, pct: 0 });

        // Capture mediainfo on the full original file before splitting.
        // Archive chunks are not valid standalone media files, so this must happen now.
        const origMi      = await getMediaInfo(file, send);
        const origMiClean = origMi ? origMi.split(file).join(fName) : null;

        const archiveDir = fs.mkdtempSync(path.join(activeTempDir, 'm3-parts-'));
        await runCommandWithProgress(
          getBinPath('7za'),
                                     ['a', `-v${cfg.splitSizeGb || 5}g`, '-bsp1', '-mx0', path.join(archiveDir, fName + '.7z'), file],
                                     pct => send('up:archiveProgress', { file: fName, pct })
        );

        send('up:archiveDone', { file: fName });
        const parts     = fs.readdirSync(archiveDir).filter(f => f.startsWith(fName + '.7z')).sort();
        const partPaths = parts.map(p => path.join(archiveDir, p));
        partPaths.forEach(fullPath => tempParts.add(fullPath));

        // Register the group so parts can be auto-grouped once all upload successfully.
        splitGroups.set(file, { origName: fName, parts: partPaths, miText: origMiClean, collected: new Map() });
        partPaths.forEach(p => partToOrig.set(p, file));

        // Prepend parts so they are uploaded immediately, in order.
        // Each part goes through the normal per-file account threshold check
        // below, so parts naturally roll across accounts as usageKb grows.
        _upPendingQueue.unshift(...partPaths);
        processedCount--;                       // this file was expanded, not uploaded
        totalCount += partPaths.length - 1;     // 1 original entry → N parts
        continue;
      }

      // ── Per-file account threshold check (covers both regular files and parts) ──
      if (usageKb + (fSize / 1024) > accountThresholdKb) {
        await withNetworkRetry(() => createAccount(), send, 'Account creation');
        consecutiveAccountFailures = 0;
      }

      if (_upAddedCount > 0) { totalCount += _upAddedCount; _upAddedCount = 0; }
      send('up:status', { file: fName, idx: processedCount, total: totalCount });

      _upCancelFlag  = false;
      let wasCancelled = false;
      let wasRequeued  = false;
      let link         = '';

      // 'browser' is a user-controlled manual fallback — it cannot be driven
      // programmatically and must never enter the automated upload loop.
      let uploadOrder = (uploadToolOrder && uploadToolOrder.length
      ? uploadToolOrder
      : cfg.toolOrderUpload && cfg.toolOrderUpload.length
      ? cfg.toolOrderUpload
      : ['megatools', 'megacmd', 'rclone']
      ).filter(t => t !== 'browser');

      // Demote tools that previously stalled on this file — move them to the
      // end of the order so the next-priority tool is attempted first.
      const fileStalledSet = _stalledTools.get(file);
      if (fileStalledSet && fileStalledSet.size > 0) {
        const demoted   = uploadOrder.filter(t => fileStalledSet.has(t));
        const preferred = uploadOrder.filter(t => !fileStalledSet.has(t));
        if (preferred.length > 0) {
          uploadOrder = [...preferred, ...demoted];
          send('up:log', `[tool order] Demoting previously-stalled tool(s) [${demoted.map(toolDisplayName).join(', ')}] — trying ${toolDisplayName(preferred[0])} first for ${fName}`);
        }
      }
      const uploadErrs = {};
      let uploadSucceeded = false;
      let alreadyExistedOnMega = false;

      for (const tool of uploadOrder) {
        try {
          const held = journal.read().find(item => item.account === currentEmail && item.destination === `${uploadFolder}/${fName}`);
          if (held) throw uploadUncertain(held);
          uploadSession?.begin(tool, fSize);
          send('up:log', `↑ [${processedCount}/${totalCount}] Uploading: ${fName} [${toolDisplayName(tool)}]`);
          if (tool === 'megatools')     { const _mtResult = await uploadFileWithMetatools(file, fName); link = _mtResult.link; if (_mtResult.alreadyExisted) { send('up:log', `[usage] ${fName} already existed on MEGA — not counting toward usage.`); uploadSucceeded = true; alreadyExistedOnMega = true; break; } }
          else if (tool === 'megacmd')  { await ensureMegaCmdServer(); await megaSwitch(currentEmail, currentPass); link = await uploadFileWithMegacmd(file, fName); }
          else if (tool === 'rclone')   link = await uploadFileWithRclone(file, fName);
          network.checkpoint();
          uploadSucceeded = true;
          break;
        } catch (err) {
          network.interruption(err);
          if (err.cancelled) { uploadSession?.discard(); wasCancelled = true; if (err.uploadUncertain) send('up:log', err.message); send('up:fileSkipped', { file: fName }); break; }
          if (err.overQuota) { uploadSession?.discard(); markAccountOverQuota(currentEmail); }
          if (uploadSession?.enabled && !err.overQuota && !err.rforkPreCommit) {
            // Retrying another tool/account could duplicate an upload committed
            // just before the failure. Current-file reconciliation is manual.
            const uncertain = new Error('Upload completion is uncertain. Queue stopped; check the current file on the same MEGA account before retrying.');
            uncertain.code = 'UPLOAD_UNCERTAIN';
            uncertain.vpnInterrupted = true;
            throw uncertain;
          }
          // Stall detected — MEGA is silently rejecting data (account probably full).
          // Record the stalled tool so it gets demoted on retry, rotate to a new
          // account, and requeue the file.
          if ((err.stalled || err.overQuota) && !_upKillFlag) {
            const reason = err.overQuota ? 'quota' : 'stall';
            // Track which tool stalled for this file so it's demoted on retry
            if (!_stalledTools.has(file)) _stalledTools.set(file, new Set());
            _stalledTools.get(file).add(tool);
            send('up:log', `[${reason}] Rotating to a new account for ${fName} (${reason} on ${toolDisplayName(tool)})…`);
            try {
              await withNetworkRetry(() => createAccount(), send, `Account creation (${reason}-triggered rotation)`);
              consecutiveAccountFailures = 0;
            } catch (acctErr) {
              network.interruption(acctErr);
              // Never swallow a kill/cancel — propagate it immediately so the
              // outer loop exits cleanly instead of requeueing and continuing.
              if (acctErr.cancelled || _upKillFlag) throw acctErr.cancelled ? acctErr : new CancelledError();
              send('up:log', `[${reason}] Could not create replacement account: ${(acctErr.message || '').slice(0, 120)} — requeueing for next retry cycle.`);
            }
            _upPendingQueue.unshift(file);
            processedCount--;
            wasRequeued = true;
            break;
          }
          uploadErrs[tool] = err;
          const nextIdx = uploadOrder.indexOf(tool) + 1;
          if (nextIdx < uploadOrder.length) send('up:log', `[upload] ${toolDisplayName(tool)} failed (${err.message}), trying ${toolDisplayName(uploadOrder[nextIdx])}… [${toolDisplayName(tool)}]`);
        } finally { uploadSession?.end(); }
      }

      // All tools threw — genuine upload failure
      const allToolsFailed = !wasCancelled && !wasRequeued && !uploadSucceeded;
      if (allToolsFailed) {
        const allNetworkErrors = uploadOrder.every(t => uploadErrs[t] && isTransientNetworkError(uploadErrs[t]));
        const netRetryCount = networkRetries.get(file) || 0;
        if (allNetworkErrors && !_upKillFlag && netRetryCount < 3) {
          networkRetries.set(file, netRetryCount + 1);
          const waitSec = 60;
          send('up:log', `[network] All upload tools failed with connection errors for ${fName} (attempt ${netRetryCount + 1}/3) — pausing ${waitSec}s then requeueing…`);
          await cancellableDelay(waitSec * 1000);
          if (!_upKillFlag) {
            _upPendingQueue.unshift(file);
            processedCount--;
            continue;
          }
        }
        consecutiveAccountFailures++;
        if (consecutiveAccountFailures >= 2 && !_upKillFlag) {
          send('up:log', `[account] ${consecutiveAccountFailures} consecutive all-tool failures — abandoning current account and switching to a new one…`);
          let accountSwitched = false;
          try {
            await withNetworkRetry(() => createAccount(), send, 'Account creation (consecutive-failure switch)');
            consecutiveAccountFailures = 0;
            accountSwitched = true;
          } catch (switchErr) {
            network.interruption(switchErr);
            send('up:log', `[account] Could not create replacement account (${(switchErr.message || '').slice(0, 120)}) — file queued for the next retry cycle instead.`);
          }
          if (accountSwitched) {
            _upPendingQueue.unshift(file);
            processedCount--;
            continue;
          }
        }
        const msg = `All upload methods failed for ${fName}: ` +
        uploadOrder.map(t => `${toolDisplayName(t)}: ${uploadErrs[t]?.message || 'not attempted'}`).join(' | ');
        send('up:log', msg);
        send('up:fileError', { file: fName, idx: processedCount, error: msg });
        failedFiles.push(file);
      }

      if (wasCancelled || wasRequeued) continue;

      if (!allToolsFailed) consecutiveAccountFailures = 0;

      // Upload succeeded (link may be blank if the share-link fetch failed after a good upload)
      if (!allToolsFailed) {
        const sizeStr = formatFileSize(fSize);
        const now     = new Date().toLocaleString('sv').replace('T', ' ');
        if (!link) send('up:log', `[warning] ${fName} uploaded but share link could not be retrieved — CSV row written with blank link.`);
        const csvField = v => { const s = String(v ?? ''); return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const completionRow = [fName, sizeStr, link, currentFolderLink, currentEmail, currentPass, now, uploadFolder].map(csvField).join(',');
        if (rforkRecord?.source === file) { recordUploadCompletion(journal, rforkRecord, getFileCsv(), completionRow); rforkRecord = null; }
        else fs.appendFileSync(getFileCsv(), completionRow + '\n');
        send('up:link', { name: fName, link, size: sizeStr, email: currentEmail, password: currentPass, folderLink: currentFolderLink, folderName: uploadFolder, fileSizeKb: fSize / 1024 });

        const origFile = partToOrig.get(file);
        if (origFile && splitGroups.has(origFile)) {
          // Split part — write the pre-captured mediainfo and track this part's link.
          const group = splitGroups.get(origFile);
          group.collected.set(file, { name: fName, link, size: sizeStr });
          if (group.miText) {
            const miEntry = JSON.stringify({ fileName: fName, fileLink: link, uploadedAt: now, mediainfo: group.miText });
            try { fs.appendFileSync(getMediainfoLog(), miEntry + '\n', 'utf8'); } catch { /* non-fatal */ }
          }
          // Once every part has a successful link, fire the auto-group event.
          if (group.collected.size === group.parts.length) {
            const groupParts = group.parts.map(p => group.collected.get(p)).filter(Boolean);
            send('up:group', { origName: group.origName, parts: groupParts });
            splitGroups.delete(origFile);
            group.parts.forEach(p => partToOrig.delete(p));
          }
        } else {
          // Regular (non-split) file — run mediainfo normally.
          const mi = await getMediaInfo(file, send);
          if (mi) {
            const miClean = mi.split(file).join(fName);
            const miEntry = JSON.stringify({ fileName: fName, fileLink: link, uploadedAt: now, mediainfo: miClean });
            try { fs.appendFileSync(getMediainfoLog(), miEntry + '\n', 'utf8'); } catch { /* non-fatal */ }
          }
        }

        if (!alreadyExistedOnMega) { usageKb += fSize / 1024; _currentUsageKb = usageKb; }
      }

      if (!allToolsFailed && tempParts.has(file)) {
        try { fs.unlinkSync(file); } catch { /* non-fatal */ }
        tempParts.delete(file);
      }
      if (!allToolsFailed && _upPendingQueue.length) await uploadSession?.boundary();
      }
    } while (failedFiles.length > 0 && !_upKillFlag && _retryRound <= 30); // outer retry-pass loop (max 30 retry cycles)

    if (_upKillFlag) throw new CancelledError();
    await retryFolderLink();
    updateAccountRow(currentEmail, usageKb);
    send('up:complete', { email: currentEmail });
    send('up:log', 'Process Complete!');

  } catch (err) {
    network.interruption(err);
    if (!err.cancelled) send('up:log', `Error: ${err.message || err}`);
    send('up:complete', null);
  } finally {
    // Unfinished parts may be the only local copy of an interrupted upload.
    // Confirmed successes are deleted individually above after their CSV write.
    tempParts.clear();
    _upKillFlag    = false;
    _uploadRunning = false;
  }
}

// Adds new file/folder paths to the pending queue while an upload is in progress.
// walkDir is the same reference passed to startUpload from main.js.
// Returns the number of file entries actually appended (folders are expanded).
// Returns 0 if no upload is running.
function addFilesToQueue(paths) {
  if (!_uploadRunning || !paths || !paths.length) return 0;
  let added = 0;
  for (const item of paths) {
    let isDir = false;
    try { isDir = fs.statSync(item).isDirectory(); } catch { /* treat as file; drive-wake logic in the main loop will handle it */ }
    if (!isDir) {
      _upPendingQueue.push(item);
      _upAddedCount++;
      added++;
    } else if (walkDir) {
      const files = walkDir(item);
      _upPendingQueue.push(...files);
      _upAddedCount += files.length;
      added += files.length;
    }
  }
  // Re-apply BFD over the full pending queue (old not-yet-started + newly added files).
  // _currentUsageKb reflects the active account's current usage so bin[0] is sized correctly.
  if (_smartOrderingEnabled && added > 0 && _upPendingQueue.length > 1) {
    const soFiles = _upPendingQueue.map((p, i) => {
      let size = 0;
      try { size = fs.statSync(p).size; } catch { /* non-fatal */ }
      return { id: p, originalIndex: i, size };
    });
    const soResult = computeSmartUploadOrder(soFiles, _smartOrderingCapBytes, _currentUsageKb * 1024);
    _upPendingQueue = soResult.orderedFiles.map(f => f.id);
  }
  return added;
}

// ── Queue control (called directly from IPC handlers in main.js) ──────────────
function cancelCurrentFile() {
  if (!_uploadRunning) network.cancel('upload');
  if (_upCurrentProc && !_upCurrentProc.killed) {
    _upCancelFlag = true;
    _upCurrentProc.kill();
  }
}

function killQueue() {
  network.cancel('upload');
  _upKillFlag     = true;
  _upPendingQueue = [];
  _upSkipSet.clear();
  if (_upCurrentSetupProc && !_upCurrentSetupProc.killed) {
    try { _upCurrentSetupProc.kill(); } catch { /* ignore */ }
    _upCurrentSetupProc = null;
  }
  cancelCurrentFile();
}

function skipFile(name) {
  // Resolve the basename to a full path so duplicate-named files in different
  // folders are not both skipped. Fall back to storing the name as-is if the
  // file hasn't entered the pending queue yet (shouldn't normally happen).
  const fullPath = _upPendingQueue.find(p => path.basename(p) === name);
  _upSkipSet.add(fullPath || name);
}

function reorderQueue(order) {
  if (!order || !order.length) return;
  const nameToPath = {};
  for (const p of _upPendingQueue) nameToPath[path.basename(p)] = p;
  const reordered = order.map(name => nameToPath[name]).filter(Boolean);
  const inOrder   = new Set(order);
  const leftover  = _upPendingQueue.filter(p => !inOrder.has(path.basename(p)));
  _upPendingQueue = [...reordered, ...leftover];
}

async function startUploadWithVpn(args, send) {
  if (_uploadRunning || network.hasTask('upload')) return;
  const plan = uploadVpn?.beginUpload();
  uploadSession = createUploadVpnSession({ plan, network, send });
  try {
    await network.run('upload', () => startUpload(args, send), {
      requireVpn: Boolean(plan?.policy.enabled && plan.policy.uploadRecoveryEnabled),
    });
  } catch (error) {
    send('up:log', error.message);
    if (['VPN_LOST', 'VPN_RECOVERY', 'VPN_STATUS_UNAVAILABLE', 'LEASE_INVALID'].includes(error.code)) {
      send('up:log', 'Upload interrupted. Check the current remote file before retrying; no account rotation or automatic file restart was performed.');
    }
    send('up:complete', null);
  } finally { uploadSession.close(); uploadSession = null; }
}
async function resumeSavedUpload({ id, password: suppliedPassword }, send) {
  if (_uploadRunning || network.hasTask('upload')) return { ok: false, error: 'Wait for the active upload to stop.' };
  _uploadRunning = true; _upKillFlag = false; _upCancelFlag = false;
  let plan;
  try {
    plan = uploadVpn?.beginUpload();
    return await network.run('upload', async () => {
      const journal = createUploadJournal(getDataDir());
      const record = journal.read().find(item => item.id === id);
      if (!record?.checkpoint) throw new Error('Select a retained rfork checkpoint.');
      const stat = fs.statSync(record.source);
      if (!stat.isFile() || stat.size !== record.bytes) throw new Error('The original source is missing or its size changed; checkpoint retained.');
      const settings = normalizeRforkSettings(loadConfig().rforkUpload);
      if (!settings.https) throw new Error('Enable HTTPS before resuming this transfer.');
      let password = typeof suppliedPassword === 'string' ? suppliedPassword : '';
      if (!password && fs.existsSync(getAccountCsv())) {
        for (const line of fs.readFileSync(getAccountCsv(), 'utf8').split(/\r?\n/).slice(1)) {
          const row = parseCSVLine(line);
          if (row[0]?.trim() === record.account) { password = row[1] || ''; break; }
        }
      }
      if (!password) throw new Error('Enter the password for the original account shown in recovery.');
      const env = rforkEnvironment(record.account, await obscurePass(password));
      send('up:log', '[rfork recovery] Verifying the original source and checkpoint. ' + summarizeRforkSettings({ ...settings, resume: true }));
      const result = await uploadWithRfork({ binary: getBinPath('rclone'), source: record.source,
        destination: record.destination, bytes: record.bytes, env, spawn, journal, record, settings,
        cancelled: () => _upKillFlag || _upCancelFlag, onSpawn(proc) { _upCurrentProc = proc; },
        onStats(stats) { send('up:recoveryProgress', { id, bytes: stats.bytes, totalBytes: record.bytes, speed: formatSpeed(stats.speed) }); },
        onDiagnostics(value) { send('up:log', '[rfork diagnostics] ' + JSON.stringify(value)); },
      });
      _upCurrentProc = null;
      network.checkpoint();
      let link = '';
      try { link = (await runCommand(getBinPath('rclone'), ['link', ':mega:' + record.destination, '--mega-use-https=true'], { env })).trim(); }
      catch (error) { network.interruption(error); send('up:log', '[export] Share link unavailable; the completed upload is retained. [rfork]'); }
      const csvField = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
      const folder = path.posix.dirname(record.destination);
      const row = [path.basename(record.source), formatFileSize(record.bytes), link, record.folderLink || '', record.account,
        password, new Date().toLocaleString('sv').replace('T', ' '), folder].map(csvField).join(',');
      recordUploadCompletion(journal, record, getFileCsv(), row);
      send('up:log', '[rfork recovery] Upload verified and recorded. Restored ' + result.restoredAcknowledgedBytes + ' bytes; pending payload ' + result.pendingSourceBytes + ' bytes.');
      return { ok: true, restoredAcknowledgedBytes: result.restoredAcknowledgedBytes, pendingSourceBytes: result.pendingSourceBytes };
    }, { requireVpn: Boolean(plan?.policy.enabled && plan.policy.uploadRecoveryEnabled) });
  } catch (error) {
    return { ok: false, error: error.message || 'Recovery stopped; checkpoint retained.' };
  } finally { plan?.close(); _upCurrentProc = null; _upKillFlag = false; _upCancelFlag = false; _uploadRunning = false; }
}
module.exports = { resumeSavedUpload, startUpload: startUploadWithVpn, installUploadVpn, cancelCurrentFile, killQueue, skipFile, reorderQueue, addFilesToQueue };
