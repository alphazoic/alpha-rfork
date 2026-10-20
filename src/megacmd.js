'use strict';

const network = require('./network-operations');

// ── MEGAcmd helpers ───────────────────────────────────────────────────────────
//
// MEGAcmd exposes commands through a single entry-point binary:
//   Windows  →  MEGAclient.exe  <subcommand> [args…]
//   Linux    →  mega-exec       <subcommand> [args…]
//
// Remote-path convention: MEGAcmd roots at the cloud root automatically,
// so paths are /folder (not /Root/folder as megatools expects).
//
// Session model: MEGAcmd runs a persistent background server that holds one
// active session. megaSwitch() always logs out before logging in so the
// correct session is always active.

const { app }  = require('electron');
const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const { getBinPath }          = require('../binPath');
const { MAX_PROC_OUT, runCommandWithTimeout, execRetry } = require('./proc-utils');

function megaCmdBin() {
  return getBinPath('mega-exec');
}

function megaHome() {
  const h = path.join(app.getPath('userData'), 'megacmd-home');
  if (!fs.existsSync(h)) fs.mkdirSync(h, { recursive: true });
  return h;
}

// Removes the files that make MEGAcmd's session sticky between account switches.
// Call after every logout and before every login to guarantee a clean slate.
// Safe to run while the server is alive — on Linux, unlinked files stay accessible
// through open handles until the server closes them, and new handles are created
// fresh on the next login.
function _deleteMegaCmdFiles() {
  const home = megaHome();
  try { fs.rmSync(path.join(home, 'session'), { force: true }); } catch { /* ignore */ }
  try {
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith('megaclient_statecache15_')) {
        try { fs.rmSync(path.join(home, entry), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  try {
    const fsDir = path.join(home, 'file-service');
    if (fs.existsSync(fsDir)) {
      for (const entry of fs.readdirSync(fsDir)) {
        try { fs.rmSync(path.join(fsDir, entry), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// On Linux/Mac open files can be unlinked while held — purge runs with the server alive.
// On Windows files are locked by the running server, so we must stop it first, purge,
// then restart it. The restart cost (~5-20 s) is paid once per account switch.
async function purgeMegaCmdSessionFiles() {
  network.checkpoint('megacmd-session');
  if (process.platform !== 'win32') {
    _deleteMegaCmdFiles();
    return;
  }
  // On Windows, NTFS locks files that are open by any process — not just the one
  // M3 spawned. Send a graceful `quit` first so the server stops cleanly regardless
  // of whether _megaCmdServerProc is set (i.e. whether M3 spawned it or it was
  // already running before M3 launched). If the server isn't running, quit fails
  // and the catch below swallows it harmlessly.
  try { await runCommandWithTimeout(megaCmdBin(), ['quit'], megaSpawnOpts(), 8000); } catch { /* ignore */ }
  if (_megaCmdServerProc) {
    try { _megaCmdServerProc.kill(); } catch { /* ignore */ }
    _megaCmdServerProc = null;
  }
  await network.delay(2000); // give Windows time to release handles; still cancelable
  _deleteMegaCmdFiles();
}

function megaEnv() {
  const megacmdDir = path.dirname(megaCmdBin());
  const sep        = process.platform === 'win32' ? ';' : ':';
  const home       = megaHome();
  const extra      = process.platform === 'win32'
  ? { APPDATA: home, LOCALAPPDATA: home }
  : {};
  return { ...process.env, PATH: megacmdDir + sep + (process.env.PATH || ''), HOME: home, USERPROFILE: home, ...extra };
}

// stdin MUST be 'ignore' (/dev/null) — leaving it as a pipe causes mega-exec
// to block indefinitely waiting for TTY input that never arrives.
function megaSpawnOpts() {
  return { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
}

// ── Bundled mega-cmd-server lifecycle ─────────────────────────────────────────
let _megaCmdServerProc = null;

async function ensureMegaCmdServer(onProc) {
  network.checkpoint('megacmd-session');
  try { await runCommandWithTimeout(megaCmdBin(), ['version'], megaSpawnOpts(), 10000, onProc); return; }
  catch (error) { network.interruption(error); /* not running */ }
  const isWin     = process.platform === 'win32';
  const serverBin = getBinPath('mega-cmd-server');
  if (!fs.existsSync(serverBin)) throw new Error(`mega-cmd-server not found at ${serverBin}. Check it exists and is executable (chmod +x).`);
  _megaCmdServerProc = spawn(serverBin, [], { detached: true, stdio: 'ignore', env: megaEnv(), cwd: path.dirname(serverBin) });
  _megaCmdServerProc.unref();
  for (let i = 0; i < 20; i++) {
    await network.delay(1000);
    try { await runCommandWithTimeout(megaCmdBin(), ['version'], megaSpawnOpts(), 5000, onProc); return; }
    catch (error) { network.interruption(error); /* still starting */ }
  }
  throw new Error('mega-cmd-server failed to start within 20 seconds.');
}

let serverShutdown = null;
function shutdownMegaCmdServer() {
  if (serverShutdown) return serverShutdown;
  const child = _megaCmdServerProc;
  if (!child) return Promise.resolve();
  serverShutdown = new Promise((resolve, reject) => {
    let killTimer, deadline;
    const closed = () => { clearTimeout(killTimer); clearTimeout(deadline); if (_megaCmdServerProc === child) _megaCmdServerProc = null; resolve(); };
    child.once('close', closed);
    if (child.exitCode != null || child.signalCode != null) { closed(); return; }
    try { child.kill('SIGTERM'); } catch { /* bounded escalation below */ }
    if (_megaCmdServerProc !== child) return;
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* retain failure for a retry */ }
      if (_megaCmdServerProc === child) deadline = setTimeout(() => reject(new Error('The MEGAcmd background server has not confirmed shutdown.')), 1000);
    }, 1000);
  });
  serverShutdown.then(() => { serverShutdown = null; }, () => { serverShutdown = null; });
  return serverShutdown;
}
app.on('before-quit', () => { shutdownMegaCmdServer().catch(() => {}); });

async function megaSwitch(email, password, onProc) {
  network.checkpoint('megacmd-session');
  const cfg = require('./config').loadConfig();
  try { await runCommandWithTimeout(megaCmdBin(), ['logout'], megaSpawnOpts(), 30000, onProc); } catch { /* fine */ }
  await purgeMegaCmdSessionFiles();
  await ensureMegaCmdServer(onProc); // on Windows the purge killed the server; restart it before login
  await runCommandWithTimeout(megaCmdBin(), ['login', email, password], megaSpawnOpts(), 90000, onProc);
  const conns = Math.min(100, Math.max(1, parseInt(cfg.megacmdConnections, 10) || 5));
  try { await runCommandWithTimeout(megaCmdBin(), ['speedlimit', '--upload-connections', String(conns)], megaSpawnOpts(), 10000, onProc); } catch { /* non-fatal */ }
}

async function megaLogout() {
  network.checkpoint('megacmd-session');
  try { await runCommandWithTimeout(megaCmdBin(), ['logout'], megaSpawnOpts(), 30000); } catch { /* ignore */ }
  await purgeMegaCmdSessionFiles();
}

// Run `mega-exec export -a <folderPath>` and return the first folder-type
// share link found in the output, or '' if none is found within 60 s.
//
// Unlike the general runCommandResolveOnMatch helper this function:
//   • uses -f to auto-accept MEGA's copyright agreement without stdin interaction
//   • matches only folder-type URLs (mega.nz/folder/…) to avoid capturing
//     file links or terms-of-service URLs that also appear in megacmd output
//
// sendFn is optional (used only to log the copyright-agreement event).
function getMegacmdFolderLink(folderPath, sendFn, onProc) {
  return new Promise(resolve => {
    const opts = { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
    const proc = network.spawnNetwork(megaCmdBin(), ['export', '-f', '-a', folderPath], opts);
    if (typeof onProc === 'function') onProc(proc);
    let combined = '', done = false;

    const finish = val => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve(val);
    };

    const timer = setTimeout(() => finish(''), 60000);

    const onData = d => {
      const chunk = d.toString();
      if (combined.length < MAX_PROC_OUT) combined += chunk;

      // Resolve as soon as we see a folder-type share link
      const m = combined.match(/https:\/\/mega\.nz\/folder\/[^\s]*/);
      if (m) finish(m[0]);
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', () => finish(''));
    proc.on('close', () => {
      if (done) return;
      clearTimeout(timer);
      try { network.checkpoint('megacmd-session'); } catch { finish(''); return; }
      // Check accumulated buffer one last time
      const m = combined.match(/https:\/\/mega\.nz\/folder\/[^\s]*/);
      if (m) { finish(m[0]); return; }

      // -a fails with "already exported" when the link exists — retrieve it without -a.
      if (/already exported/i.test(combined)) {
        const proc2 = network.spawnNetwork(megaCmdBin(), ['export', folderPath], { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        if (typeof onProc === 'function') onProc(proc2);
        let combined2 = '', done2 = false;

        const finish2 = val => {
          if (done2) return; done2 = true;
          clearTimeout(timer2);
          try { proc2.kill(); } catch { /* ignore */ }
          resolve(val);
        };

        const timer2 = setTimeout(() => finish2(''), 30000);

        const onData2 = d => {
          const chunk = d.toString();
          if (combined2.length < MAX_PROC_OUT) combined2 += chunk;
          // Matches: "/folder (folder, shared as exported permanent folder link: https://mega.nz/folder/XXX)"
          const m2 = combined2.match(/folder link:\s*(https:\/\/mega\.nz\/folder\/[^\s)]*)/i);
          if (m2) finish2(m2[1]);
        };

          proc2.stdout?.on('data', onData2);
          proc2.stderr?.on('data', onData2);
          proc2.on('error', () => finish2(''));
          proc2.on('close', () => {
            const m2 = combined2.match(/folder link:\s*(https:\/\/mega\.nz\/folder\/[^\s)]*)/i);
          finish2(m2 ? m2[1] : '');
          });
      } else {
        finish('');
      }
    });
  });
}

// Maps a MEGAcmd error message string to a status label.
function classifyMegaError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('suspend') || m.includes('block') || m.includes('terminat') || m.includes('eblock')) return 'Suspended';
  if (m.includes('too many') || m.includes('throttl') || m.includes('rate limit') || m.includes('eagain') || m.includes('429')) return 'RateLimit';
  return 'Dead';
}

// Parse `mega-df` (without -h) output — returns { used, total } or null.
function parseMegaDf(dfOut) {
  const usedMatch  = dfOut.match(/(?:own|used)\s+storage[^:]*:\s+(\d+)\s+of\s+(\d+)/i)
  || dfOut.match(/total\s+storage[^:]*:\s+(\d+)\s+of\s+(\d+)/i)
  || dfOut.match(/USED STORAGE:\s+(\d+)\s+[\d.]+%\s+of\s+(\d+)/i)
  || dfOut.match(/(\d{6,})\s+of\s+(\d{6,})/);
  if (!usedMatch) return null;
  return {
    used:  parseInt(usedMatch[1], 10),
    total: parseInt(usedMatch[2], 10),
  };
}

// Run `mega-exec find / --pattern=<fileName>` to locate a file in the active
// session's cloud drive and return its parent folder path (e.g. /folder/sub).
// Throws on failure. Requires an active MEGAcmd session (call megaSwitch first).
async function findFileInCloud(fileName) {
  let out = '';
  try {
    out = await runCommandWithTimeout(
      megaCmdBin(), ['find', '/', `--pattern=${fileName}`],
                                      megaSpawnOpts(), 30000
    );
  } catch (e) {
    network.interruption(e);
    throw new Error(`find failed: ${e.message}`);
  }
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  // Prefer a line whose last path component exactly matches the file name
  const fileLine = lines.find(l => {
    const parts = l.split('/');
    return parts[parts.length - 1] === fileName;
  }) || lines[0];
  if (!fileLine) throw new Error(`"${fileName}" not found in cloud drive`);
  const lastSlash = fileLine.lastIndexOf('/');
  if (lastSlash < 0) throw new Error(`Unexpected path format from find: ${fileLine}`);
  // Strip the file name — return just the folder path, no trailing slash
  return fileLine.slice(0, lastSlash) || '/';
}

// Run `mega-exec export <filePath>` and return the file-type share link.
// First tries without -a; if MEGAcmd reports the path is not yet exported,
// automatically re-runs with -a to create the link.
// Reads both stdout and stderr so no output is missed regardless of which
// stream MEGAcmd uses. Returns '' on failure or timeout.
function getMegacmdFileLink(filePath) {
  return new Promise(resolve => {
    const opts = { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
    const proc = network.spawnNetwork(megaCmdBin(), ['export', filePath], opts);
    let combined = '', done = false;

    const finish = val => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve(val);
    };

    const timer = setTimeout(() => finish(''), 30000);

    const onData = d => {
      const chunk = d.toString();
      if (combined.length < MAX_PROC_OUT) combined += chunk;
      // When already exported the output contains the URL in parentheses:
      // "/folder/file.ext (4.26 GB, shared as exported permanent file link: https://mega.nz/file/XXX)"
      // Exclude the trailing ) from the match.
      const m = combined.match(/https:\/\/mega\.nz\/file\/[^\s)]*/);
      if (m) finish(m[0]);
    };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', () => finish(''));
      proc.on('close', () => {
        if (done) return;
        clearTimeout(timer);
        try { network.checkpoint('megacmd-session'); } catch { finish(''); return; }
        const m = combined.match(/https:\/\/mega\.nz\/file\/[^\s)]*/);
      if (m) { resolve(m[0]); return; }

      if (/is not exported/i.test(combined)) {
        // Link has never been created — export with -a to create it.
        // Output: "Exported /folder/file.ext: https://mega.nz/file/XXX"
        const proc2 = network.spawnNetwork(megaCmdBin(), ['export', '-a', filePath], opts);
        let combined2 = '', done2 = false;

        const finish2 = val => {
          if (done2) return; done2 = true;
          clearTimeout(timer2);
          try { proc2.kill(); } catch { /* ignore */ }
          resolve(val);
        };

        const timer2 = setTimeout(() => finish2(''), 30000);

        const onData2 = d => {
          const chunk = d.toString();
          if (combined2.length < MAX_PROC_OUT) combined2 += chunk;
          const m2 = combined2.match(/https:\/\/mega\.nz\/file\/[^\s)]*/);
          if (m2) finish2(m2[0]);
        };

          proc2.stdout?.on('data', onData2);
          proc2.stderr?.on('data', onData2);
          proc2.on('error', () => finish2(''));
          proc2.on('close', () => {
            const m2 = combined2.match(/https:\/\/mega\.nz\/file\/[^\s)]*/);
          finish2(m2 ? m2[0] : '');
          });
      } else {
        resolve('');
      }
      });
  });
}

// Maps importMegaLink output/error text to a failure kind:
//   'fatal'    — unrecoverable; retrying will always produce the same result
//   'session'  — session dropped or mid-login; re-login and retry inline
//   'transient'— network or server glitch; defer to end-of-queue retry pass
function classifyImportError(err) {
  const m = (err || '').toLowerCase();
  if (!err)                                         return 'transient'; // empty output — no connection
  if (m.includes('timed out'))                      return 'transient';
  if (m.includes('not found'))                      return 'fatal';     // "Failed to import node: Not found"
  if (m.includes('not logged in'))                  return 'session';   // "Not logged in."
  if (m.includes('command not valid while login'))  return 'session';   // "Command not valid while login in"
  return 'transient';                                                    // unknown — safe to retry
}

// Run `mega-exec import <url> <destFolder>` to copy a public MEGA file/folder
// link directly into the currently logged-in account's cloud drive.
// destFolder must already exist in the destination account — MEGAcmd's
// import command does not create missing parent folders.
// Resolves { ok: true, output } on success, or { ok: false, error } otherwise.
function importMegaLink(url, destFolder) {
  return new Promise(resolve => {
    const opts = { env: megaEnv(), stdio: ['ignore', 'pipe', 'pipe'] };
    const proc = network.spawnNetwork(megaCmdBin(), ['import', url, destFolder], opts);
    let combined = '', done = false;

    const finish = val => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve(val);
    };

    // 5 minutes — a single file usually resolves in seconds, but a whole-folder
    // "Import All" can legitimately take much longer, and killing the local
    // process here doesn't cancel the copy already running on MEGA's servers.
    const timer = setTimeout(() => finish({ ok: false, error: 'Import timed out after 5 minutes', kind: 'transient' }), 300000);

    const onData = d => {
      const chunk = d.toString();
      if (combined.length < MAX_PROC_OUT) combined += chunk;
    };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.on('error', err => finish({ ok: false, error: err.message, kind: 'transient' }));
      proc.on('close', () => {
        if (done) return;
        try { network.checkpoint('megacmd-session'); }
        catch (error) { finish({ ok: false, error: error.message, kind: 'interrupted' }); return; }
        if (/Import(?:ed)?(?:\s+(?:file|folder))?\s+complete/im.test(combined)) {
          // A successful import where the key was corrupt lands as "/path/NO_KEY" —
          // MEGAcmd reports success but the file is permanently unreadable.
          if (/\/NO_KEY\b/i.test(combined)) {
            finish({ ok: false, error: 'Import failed: file key is missing or corrupt (broken link)', kind: 'fatal' });
          } else {
            finish({ ok: true, output: combined.trim() });
          }
        } else if (/Invalid destiny/i.test(combined)) {
          // Destination folder doesn't exist — create it, then retry.
          const mkdirProc = network.spawnNetwork(megaCmdBin(), ['mkdir', '-p', destFolder], { env: megaEnv(), stdio: 'ignore' });
          mkdirProc.on('error', err => finish({ ok: false, error: `mkdir failed: ${err.message}`, kind: 'transient' }));
          mkdirProc.on('close', () => {
            if (done) return;
            setTimeout(() => {
              if (done) return;
              try { network.checkpoint('megacmd-session'); }
              catch (error) { finish({ ok: false, error: error.message, kind: 'interrupted' }); return; }
              const retryProc = network.spawnNetwork(megaCmdBin(), ['import', url, destFolder], opts);
              let retryCombined = '';
              retryProc.stdout?.on('data', d => { if (retryCombined.length < MAX_PROC_OUT) retryCombined += d.toString(); });
              retryProc.stderr?.on('data', d => { if (retryCombined.length < MAX_PROC_OUT) retryCombined += d.toString(); });
              retryProc.on('error', err => finish({ ok: false, error: err.message, kind: 'transient' }));
              retryProc.on('close', () => {
                if (/Import(?:ed)?(?:\s+(?:file|folder))?\s+complete/im.test(retryCombined)) {
                  if (/\/NO_KEY\b/i.test(retryCombined)) {
                    finish({ ok: false, error: 'Import failed: file key is missing or corrupt (broken link)', kind: 'fatal' });
                  } else {
                    finish({ ok: true, output: retryCombined.trim() });
                  }
                } else {
                  const retryErr = retryCombined.trim() || 'Import failed after creating destination folder';
                  finish({ ok: false, error: retryErr, kind: classifyImportError(retryErr) });
                }
              });
            }, 500);
          });
        } else {
          const err = combined.trim();
          finish({ ok: false, error: err || 'Import failed with no output', kind: classifyImportError(err) });
        }
      });
  });
}

module.exports = {
  megaCmdBin, megaHome, megaEnv, megaSpawnOpts,
  ensureMegaCmdServer, shutdownMegaCmdServer, megaSwitch, megaLogout, purgeMegaCmdSessionFiles,
  getMegacmdFolderLink, getMegacmdFileLink, classifyMegaError, parseMegaDf,
  importMegaLink, findFileInCloud,
};
