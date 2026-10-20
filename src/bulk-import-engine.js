'use strict';

const network = require('./network-operations');

const fs   = require('fs');
const path = require('path');

const { loadConfig, getAccountCsv }                = require('./config');
const { formatFileSize, parseCSVLine,
        isOverQuotaError }                          = require('./utils');
const { runCommandWithTimeout, execRetry }          = require('./proc-utils');
const { ensureMegaCmdServer, megaSwitch, megaCmdBin, megaSpawnOpts,
        getMegacmdFolderLink, getMegacmdFileLink, importMegaLink } = require('./megacmd');
const { fetchFolderTree }                           = require('./folder-browser');
const { appendAccountRow, updateAccountRow,
  markSecurityUpgrade }                       = require('./account-manager');
const { registerMegaAccount }                       = require('./account-creator');      // Task A
const { queryActualUsageKb }                        = require('./account-usage');         // Task B4
const { classifyMegaLink, getMegaPublicFileSize,
  importSingleFileInSession, appendImportRow,
  _findFilesUnderPath }                       = require('./import-engine');         // Task B
  const { computeSmartUploadOrder }                   = require('./smartOrdering');

// ── Bulk Import state (module-level so kill/skip IPC can reach the live run) ──
let _biKillFlag         = false;
let _biCurrentSetupProc = null; // tracks any running setup subprocess so killBulkImportQueue() can terminate it immediately
let _biSkipSet          = new Set();
let _biPendingQueue     = [];
let _biRunning          = false;

// (No _biCurrentProc / cancel-current-item flag — imports are near-instantaneous
// server-side ops with a hard 60s timeout already baked into importMegaLink()/
// getMegacmdFileLink() in megacmd.js; there is no meaningful "cancel mid-transfer"
// the way there is for a multi-minute file upload. Only a queue-level kill is needed.)

function _biTrackProc(proc) {
  _biCurrentSetupProc = proc;
  // If killBulkImportQueue() already fired before this process was registered, terminate
  // it immediately so it cannot run to completion and produce output the engine acts on.
  if (_biKillFlag && proc && !proc.killed) {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

// Delay that resolves normally but rejects immediately when _biKillFlag is set.
function cancellableDelay(ms) {
  return new Promise((resolve, reject) => {
    const step = 250;
    let elapsed = 0;
    const tick = () => {
      if (_biKillFlag) { reject(new Error('Killed')); return; }
      elapsed += step;
      if (elapsed >= ms) { resolve(); return; }
      setTimeout(tick, Math.min(step, ms - elapsed));
    };
    setTimeout(tick, Math.min(step, ms));
  });
}

// ── Main Bulk Import entry point ──────────────────────────────────────────────
async function startBulkImport({ queue, resumeAccount, manualEmail, manualPassword, folderName, createToolOrder, smartOrderingEnabled }, send) {
  if (_biRunning) {
    send('bi:log', 'A bulk import is already in progress. Please wait for it to finish before starting another.');
    send('bi:complete', null);
    return;
  }
  _biKillFlag = false;
  _biRunning  = true;
  _biSkipSet.clear();

  class CancelledError extends Error {
    constructor() { super('Bulk import cancelled by user'); this.cancelled = true; }
  }

  // Kill-aware subprocess wrappers — same convention as upload-engine.js's execT/rwtT.
  const execT = (cmd, args, opts) => {
    if (_biKillFlag) return Promise.reject(new CancelledError());
    return new Promise((resolve, reject) => {
      let done = false;
      const killPoll = setInterval(() => {
        if (_biKillFlag && !done) {
          done = true;
          clearInterval(killPoll);
          reject(new CancelledError());
        }
      }, 250);
      execRetry(cmd, args, opts, undefined, undefined, undefined, _biTrackProc)
        .then(v  => { if (!done) { done = true; clearInterval(killPoll); if (_biKillFlag) reject(new CancelledError()); else resolve(v); } })
        .catch(e => { if (!done) { done = true; clearInterval(killPoll); reject(e); } });
    });
  };
  const rwtT = async (cmd, args, opts, ms) => {
    if (_biKillFlag) throw new CancelledError();
    return runCommandWithTimeout(cmd, args, opts, ms, _biTrackProc);
  };

  try {
    const importFolder   = (folderName || 'folder').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'folder';
    const destFolderPath = '/' + importFolder; // megacmd-style absolute path; always megacmd, no /Root/ prefix needed

    const cfg                = loadConfig();
    const accountThresholdKb = (parseFloat(cfg.accountThresholdGb) || 19.5) * 1024 * 1024;

    let currentEmail = '', currentPass = '', usageKb = 0;
    let erroredInputLinks = 0;

    // ── createBulkImportAccount ─────────────────────────────────────────────
    async function createBulkImportAccount() {
      if (_biKillFlag) throw new CancelledError();
      if (currentEmail) updateAccountRow(currentEmail, usageKb); // flush previous account's tally
      usageKb = 0;

      const { email, password } = await registerMegaAccount({
        createToolOrder: (createToolOrder && createToolOrder.length) ? createToolOrder : ['megatools', 'megacmd'],
        send, shouldAbort: () => _biKillFlag, trackProc: _biTrackProc, execT, rwtT, cancellableDelay,
      }); // Task A's shared function — registration only, no folder/link setup
      currentEmail = email; currentPass = password;

      // Bulk Import ALWAYS does its own megacmd-only folder setup here, regardless of
      // which tool registerMegaAccount used to register the account (megatools-registered
      // accounts log into megacmd fine — same underlying MEGA account).
      await ensureMegaCmdServer(_biTrackProc);
      await megaSwitch(currentEmail, currentPass, _biTrackProc);
      try { await rwtT(megaCmdBin(), ['mkdir', '-p', destFolderPath], megaSpawnOpts(), 30000); } catch { /* fine */ }
      const folderLink = await getMegacmdFolderLink(destFolderPath, send, _biTrackProc);

      send('bi:account', { email: currentEmail, password: currentPass, usageKb });
      send('bi:folderLink', { link: folderLink, tool: 'megacmd' });
    }

    // ── importOneItem ─────────────────────────────────────────────────────────
    async function importOneItem(item) {
      if (item.name) {
        // Folder-link-derived entries already know their name — straightforward path.
        const res = await importSingleFileInSession({
          email: currentEmail, password: currentPass, url: item.url,
          destFolder: destFolderPath, fileName: item.name, fileBytes: item.size,
        });
        return res.ok ? { ok: true, name: item.name, fileLink: res.fileLink } : { ok: false, error: res.error, kind: res.kind };
      }
      // Bare-file link with unknown name: snapshot destFolder, import, diff to discover what landed —
      // same technique doImportMegaLink already uses for its "isSingleFile" branch
      // (import-engine.js lines ~453-468).
      const preImportPaths = await _findFilesUnderPath(destFolderPath).catch(() => []);
      const result = await importMegaLink(item.url, destFolderPath); // from megacmd.js, already exported
      if (!result.ok) return { ok: false, error: result.error, kind: result.kind };
      const postImportPaths = await _findFilesUnderPath(destFolderPath).catch(() => []);
      const newPath = postImportPaths.find(p => !preImportPaths.includes(p));
      if (!newPath) return { ok: false, error: 'Import reported success but no new file was found in destination folder' };
      const detectedName = path.posix.basename(newPath);
      const fileLink = await getMegacmdFileLink(newPath).catch(() => '');
      appendImportRow({ fileName: detectedName, fileSize: item.size, fileLink, email: currentEmail, password: currentPass, destFolder: destFolderPath });
      return { ok: true, name: detectedName, fileLink };
    }

    if (_biKillFlag) throw new CancelledError();

    // ── Queue analysis ("Analyzing Queue…") ───────────────────────────────────
    send('bi:log', 'Analyzing Queue...');
    const analyzedQueue = [];

    for (const url of (queue || [])) {
      if (_biKillFlag) throw new CancelledError();
      const linkType = classifyMegaLink(url);

      if (linkType === 'folder-root') {
        try {
          const tree = await fetchFolderTree(url);
          for (const file of tree.files) {
            analyzedQueue.push({ url: `${tree.baseUrl}/file/${file.handle}`, name: file.name, size: file.size });
          }
          send('bi:log', `Scanned folder: ${tree.rootName} — ${tree.files.length} file(s) found.`);
        } catch (err) {
          network.interruption(err);
          send('bi:log', `Could not read folder link (${err.message}) — skipping: ${url}`);
          erroredInputLinks++;
        }
      } else if (linkType === 'bare-file' || linkType === 'folder-file') {
        const sizeBytes = await getMegaPublicFileSize(url);
        if (sizeBytes === null) {
          send('bi:log', `Could not determine size for ${url} — skipping.`);
          send('bi:itemError', { item: url, error: 'Could not resolve file size from MEGA public API' });
          erroredInputLinks++;
        } else {
          analyzedQueue.push({ url, name: null, size: sizeBytes });
        }
      } else {
        send('bi:log', `Not a recognized MEGA link, skipping: ${url}`);
        erroredInputLinks++;
      }
    }

    _biPendingQueue = [...analyzedQueue];

    if (erroredInputLinks > 0) {
      send('bi:log', `${erroredInputLinks} input link(s) could not be processed and were skipped.`);
    }

    // ── Account strategy ───────────────────────────────────────────────────────
    if (manualEmail && manualPassword) {
      currentEmail = manualEmail;
      currentPass  = manualPassword;
      usageKb = 0;
      send('bi:log', `Using manual account: ${currentEmail}`);
      try {
        await ensureMegaCmdServer(_biTrackProc);
        await megaSwitch(currentEmail, currentPass, _biTrackProc);
        try { await rwtT(megaCmdBin(), ['mkdir', '-p', destFolderPath], megaSpawnOpts(), 30000); } catch { /* may already exist, fine */ }
      } catch (setupErr) {
        network.interruption(setupErr);
        if (isOverQuotaError(setupErr.message || '') && !_biKillFlag) {
          send('bi:log', `[quota] Manual account ${currentEmail} is Over Quota — creating a fresh account instead…`);
          await createBulkImportAccount();
        } else { throw setupErr; }
      }
      if (!_biKillFlag) {
        send('bi:log', '[storage check] Querying actual account storage via megacmd…');
        const liveKb = await queryActualUsageKb(currentEmail, currentPass, 'megacmd', _biTrackProc);
        if (liveKb !== null) {
          usageKb = liveKb;
          send('bi:log', `[storage check] Account is using ${formatFileSize(usageKb * 1024)} — will create a new account if the next item would exceed ${cfg.accountThresholdGb || 19.5} GB.`);
        } else {
          send('bi:log', '[storage check] Could not retrieve live storage — starting from 0 KB (conservative).');
        }
      }
      send('bi:account', { email: currentEmail, password: currentPass, usageKb });

    } else if (resumeAccount) {
      if (!fs.existsSync(getAccountCsv())) throw new Error('No account log found. Run a fresh import first.');
      const rows = fs.readFileSync(getAccountCsv(), 'utf8')
        .split('\n').map(l => l.trim()).filter(Boolean).slice(1);
      if (rows.length === 0) throw new Error('account_log.csv has no account entries in the configured data folder. Run a fresh import first.');
      const cols = parseCSVLine(rows[rows.length - 1]);
      currentEmail = cols[0].trim();
      currentPass  = cols[1].trim();
      usageKb = parseFloat(cols[2]) * 1024 * 1024 || 0; // CSV fallback — overridden below if live query succeeds
      send('bi:log', `Resuming account: ${currentEmail}`);
      try {
        await ensureMegaCmdServer(_biTrackProc);
        await megaSwitch(currentEmail, currentPass, _biTrackProc);
        try { await rwtT(megaCmdBin(), ['mkdir', '-p', destFolderPath], megaSpawnOpts(), 30000); } catch { /* may already exist, fine */ }
      } catch (setupErr) {
        network.interruption(setupErr);
        if (isOverQuotaError(setupErr.message || '') && !_biKillFlag) {
          send('bi:log', `[quota] Resumed account ${currentEmail} is Over Quota — creating a fresh account instead…`);
          await createBulkImportAccount();
        } else { throw setupErr; }
      }
      if (!_biKillFlag) {
        send('bi:log', '[storage check] Querying actual account storage via megacmd…');
        const liveKb = await queryActualUsageKb(currentEmail, currentPass, 'megacmd', _biTrackProc);
        if (liveKb !== null) {
          usageKb = liveKb;
          send('bi:log', `[storage check] Account is using ${formatFileSize(usageKb * 1024)} — will create a new account if the next item would exceed ${cfg.accountThresholdGb || 19.5} GB.`);
        } else {
          send('bi:log', `[storage check] Could not retrieve live storage — using CSV value: ${formatFileSize(usageKb * 1024)}.`);
        }
      }
      send('bi:account', { email: currentEmail, password: currentPass, usageKb });

    } else {
      await createBulkImportAccount();
    }

    // ── Smart ordering — reorder queue to minimise wasted account space ─────────
    if (smartOrderingEnabled && _biPendingQueue.length > 1) {
      send('bi:log', 'Optimizing import order (bin-packing)…');
      const descriptors = _biPendingQueue.map((item, i) => ({ id: i, originalIndex: i, size: item.size }));
      const { orderedFiles } = computeSmartUploadOrder(descriptors, accountThresholdKb * 1024, usageKb * 1024);
      _biPendingQueue = orderedFiles.map(f => _biPendingQueue[f.id]).filter(Boolean);
    }

    // ── Main loop ──────────────────────────────────────────────────────────────
    const retryPool    = [];
    let totalCount     = _biPendingQueue.length;
    let processedCount = 0;

    while (_biPendingQueue.length > 0) {
      if (_biKillFlag) break;
      const item = _biPendingQueue.shift();
      processedCount++;

      if (_biSkipSet.has(item.url)) { _biSkipSet.delete(item.url); send('bi:itemSkipped', { item: item.name || item.url }); continue; }

      // ── Oversize guard — MUST run before the threshold/rotate check, or a file ──
      // ── bigger than accountThresholdKb alone would cause an infinite rotate loop ──
      if (item.size / 1024 > accountThresholdKb) {
        send('bi:log', `${item.name || item.url}: ${formatFileSize(item.size)} exceeds the account threshold and cannot be split — skipping.`);
        send('bi:itemError', { item: item.name || item.url, error: 'File exceeds single-account size threshold' });
        continue;
      }

      // ── Per-item account threshold check (identical pattern to upload-engine.js line 1119) ──
      if (usageKb + (item.size / 1024) > accountThresholdKb) {
        await createBulkImportAccount();
      }

      send('bi:status', { item: { url: item.url, name: item.name, size: item.size }, idx: processedCount, total: totalCount });

      // ── Perform the import (always in the already-logged-in megacmd session) ──
      const result = await importOneItem(item);
      if (result.ok) {
        usageKb += item.size / 1024;
        markSecurityUpgrade(currentEmail);
        updateAccountRow(currentEmail, item.size / 1024);
        send('bi:link', { url: item.url, name: result.name, link: result.fileLink, size: formatFileSize(item.size), email: currentEmail, password: currentPass, folderName: importFolder });
        send('bi:log', `✓ Imported: ${result.name}`);
      } else {
        const kind = result.kind || 'transient';
        if (kind === 'fatal') {
          send('bi:itemError', { item: item.name || item.url, error: result.error });
          send('bi:log', `✕ Failed (permanent): ${item.name || item.url} — ${result.error}`);
        } else if (kind === 'session') {
          send('bi:log', `[session] Session error — re-logging in and retrying: ${item.name || item.url}`);
          try {
            await cancellableDelay(3000);
            await ensureMegaCmdServer(_biTrackProc);
            await megaSwitch(currentEmail, currentPass, _biTrackProc);
            const retryResult = await importOneItem(item);
            if (retryResult.ok) {
              usageKb += item.size / 1024;
              markSecurityUpgrade(currentEmail);
              updateAccountRow(currentEmail, item.size / 1024);
              send('bi:link', { url: item.url, name: retryResult.name, link: retryResult.fileLink, size: formatFileSize(item.size), email: currentEmail, password: currentPass, folderName: importFolder });
              send('bi:log', `✓ Imported: ${retryResult.name}`);
            } else {
              retryPool.push(item);
              send('bi:log', `⚠ Still failing after re-login — deferred to retry pass: ${item.name || item.url}`);
            }
          } catch (sessionErr) {
            network.interruption(sessionErr);
            retryPool.push(item);
            send('bi:log', `⚠ Re-login failed (${sessionErr.message}) — deferred to retry pass: ${item.name || item.url}`);
          }
        } else {
          retryPool.push(item);
          send('bi:log', `⚠ Transient error — deferred to retry pass: ${item.name || item.url}`);
        }
      }
    }

    // ── Retry pass — one attempt at every deferred transient failure ───────────
    if (retryPool.length > 0 && !_biKillFlag) {
      send('bi:log', `Retry pass: retrying ${retryPool.length} failed item(s) — restoring session…`);
      try {
        await megaSwitch(currentEmail, currentPass, _biTrackProc);
      } catch (err) {
        network.interruption(err);
        send('bi:log', `[retry] Could not restore session: ${err.message} — attempting retries anyway…`);
      }
      for (const item of retryPool) {
        if (_biKillFlag) break;
        if (usageKb + (item.size / 1024) > accountThresholdKb) {
          await createBulkImportAccount();
        }
        send('bi:log', `[retry] ${item.name || item.url}`);
        const result = await importOneItem(item);
        if (result.ok) {
          usageKb += item.size / 1024;
          markSecurityUpgrade(currentEmail);
          updateAccountRow(currentEmail, item.size / 1024);
          send('bi:link', { url: item.url, name: result.name, link: result.fileLink, size: formatFileSize(item.size), email: currentEmail, password: currentPass, folderName: importFolder });
          send('bi:log', `✓ Imported: ${result.name}`);
        } else {
          send('bi:itemError', { item: item.name || item.url, error: result.error });
          send('bi:log', `✕ Failed permanently: ${item.name || item.url} — ${result.error}`);
        }
      }
    }

    if (_biKillFlag) throw new CancelledError();
    send('bi:complete', { email: currentEmail });
    send('bi:log', 'Process Complete!');

  } catch (err) {
    network.interruption(err);
    if (!err.cancelled) send('bi:log', `Error: ${err.message || err}`);
    send('bi:complete', null);
  } finally {
    _biKillFlag = false;
    _biRunning  = false;
  }
}

// ── Queue control (called directly from IPC handlers in main.js) ─────────────
function killBulkImportQueue() {
  network.cancel('bulk-import');
  _biKillFlag = true;
  _biPendingQueue = [];
  _biSkipSet.clear();
  if (_biCurrentSetupProc && !_biCurrentSetupProc.killed) { try { _biCurrentSetupProc.kill(); } catch { /* ignore */ } }
}
function skipBulkImportItem(urlOrName) { _biSkipSet.add(urlOrName); }

module.exports = { startBulkImport: network.wrap('bulk-import', startBulkImport, (error, [args, send]) => {
  send('bi:log', error.message);
  send('bi:complete', null);
}), killBulkImportQueue, skipBulkImportItem };
