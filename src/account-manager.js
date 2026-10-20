'use strict';

const network = require('./network-operations');

const fs   = require('fs');

const { loadConfig, getAccountCsv }                          = require('./config');
const { parseCSVLine }                                        = require('./utils');
const { refreshThresholdDays, parseAccountRecords, needsAccountRefresh } = require('./account-refresh-policy');
const { runCommandWithTimeout }                             = require('./proc-utils');
const { ensureMegaCmdServer, megaSwitch, megaLogout,
        megaCmdBin, megaSpawnOpts, parseMegaDf }              = require('./megacmd');
const { obscurePass, rcloneRemote }                           = require('./rclone');
const { getBinPath }                                          = require('../binPath');

const STORAGE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

const { VpnControllerError } = require('./vpn-controller');
const { classifyRefreshFailure } = require('./account-refresh-result');

let refreshVpn = null;
function installRefreshVpn(service) { refreshVpn = service; }
function refreshError(error) {
  if (error?.code === 'ACCOUNT_CSV_MISSING') return 'account_log.csv not found in the configured data folder.';
  return error?.vpnInterrupted || error?.name === 'ProtonVpnError'
    ? error.message : 'Account refresh could not complete. Previous results were preserved.';
}
function checkCanceled(signal) { if (signal?.aborted) throw signal.reason || new VpnControllerError('CANCELED'); }

// A result is complete only after login/listing and valid storage information.
// Every fallback and its quota probe share the caller's account/route lease.
async function attemptAccountLogin(email, password, order) {
  const refreshErrs = {};
  for (const tool of order) {
    let stage = 'authentication';
    try {
      let liveUsedBytes;
      if (tool === 'megatools') {
        await runCommandWithTimeout(getBinPath('megatools'), ['ls', '-u', email, '-p', password], { stdio: 'pipe' }, 60000);
        stage = 'storage';
        const output = await runCommandWithTimeout(getBinPath('megatools'), ['df', '-u', email, '-p', password], { stdio: 'pipe' }, 30000);
        const match = output.match(/Used[^:\r\n]*:\s+(\d+)\s*(?:bytes)?\s*(?:\r?\n|$)/i);
        liveUsedBytes = match ? Number(match[1]) : null;
      } else if (tool === 'megacmd') {
        await ensureMegaCmdServer();
        await megaSwitch(email, password);
        await runCommandWithTimeout(megaCmdBin(), ['ls', '/'], megaSpawnOpts(), 60000);
        stage = 'storage';
        const output = await runCommandWithTimeout(megaCmdBin(), ['df'], megaSpawnOpts(), 30000);
        liveUsedBytes = parseMegaDf(output)?.used ?? null;
      } else if (tool === 'rclone') {
        const obscured = await obscurePass(password);
        const remote = rcloneRemote(email, obscured);
        const output = await runCommandWithTimeout(getBinPath('rclone'), ['about', '--json', `${remote}:`], { stdio: 'pipe' }, 60000);
        stage = 'storage';
        const match = output.match(/\{[\s\S]*\}/);
        liveUsedBytes = match ? JSON.parse(match[0]).used : null;
      } else { throw new Error('Unknown account refresh tool'); }
      if (!Number.isSafeInteger(liveUsedBytes) || liveUsedBytes < 0) throw new Error('Storage response could not be verified');
      network.checkpoint();
      return { toolSucceeded: tool, liveUsedBytes,
        newStatus: liveUsedBytes > STORAGE_LIMIT_BYTES ? 'Over Quota' : 'Active', refreshErrs };
    } catch (error) {
      network.interruption(error);
      refreshErrs[tool] = { message: error.message, refreshStage: stage };
    } finally {
      // The persistent MEGAcmd session must be closed before yielding this
      // account boundary to another workflow or a normal VPN switch.
      if (tool === 'megacmd') {
        network.checkpoint();
        await megaLogout();
        network.checkpoint();
      }
    }
  }
  network.checkpoint();
  return { toolSucceeded: null, liveUsedBytes: null, newStatus: null, refreshErrs };
}

// Re-read the latest CSV for each completed result; never rebuild from a batch's
// old snapshot or overwrite concurrent changes to unrelated rows/columns.
function persistRefreshResult(email, attempt, failure) {
  network.checkpoint();
  const lines = fs.readFileSync(getAccountCsv(), 'utf8').split('\n');
  let result = null;
  const updated = lines.map((line, index) => {
    if (!index || !line.trim()) return line;
    const cols = parseCSVLine(line);
    if ((cols[0] || '').trim() !== email) return line;
    while (cols.length < 7) cols.push('');
    const success = Boolean(attempt.toolSucceeded);
    if (success) {
      cols[2] = (attempt.liveUsedBytes / 1024 / 1024 / 1024).toFixed(4);
      cols[4] = new Date().toISOString(); cols[5] = attempt.newStatus;
      if (attempt.toolSucceeded === 'megacmd') cols[6] = 'Yes';
    } else if (failure.status) cols[5] = failure.status;
    result = { status: cols[5], lastLogin: cols[4], securityUpgrade: cols[6] || 'No',
      liveUsedBytes: success ? attempt.liveUsedBytes : null, outcome: success ? 'success' : failure.kind };
    return success || failure.status ? cols.map(value => /[,"\r\n]/.test(value)
      ? '"' + value.replace(/"/g, '""') + '"' : value).join(',') : line;
  });
  if (!result) throw new Error('Account row no longer exists');
  if (attempt.toolSucceeded || failure.status) fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
  return result;
}

// ── Account CSV helpers ───────────────────────────────────────────────────────

// Append a brand-new account row (bandwidth=0, no last-login yet)
function appendAccountRow(email, password, securityUpgrade) {
  const now = new Date().toISOString();
  try {
    if (!fs.existsSync(getAccountCsv())) {
      fs.writeFileSync(getAccountCsv(),
        'Email Address,Password,Bandwidth Used (GB),Date Created,Last Login Date,Account Status,Security Upgrade\n', 'utf8');
    }
    fs.appendFileSync(getAccountCsv(), `${email},${password},0,${now},,Active,${securityUpgrade || 'No'}\n`, 'utf8');
  } catch { /* non-fatal */ }
}

// Find the row for `email` and add `addedKb` to its bandwidth; stamp last-login
function updateAccountRow(email, addedKb) {
  if (!email || !fs.existsSync(getAccountCsv())) return;
  try {
    const raw   = fs.readFileSync(getAccountCsv(), 'utf8');
    const lines = raw.split('\n');
    const now   = new Date().toISOString();
    let found   = false;
    const updated = lines.map((line, idx) => {
      if (idx === 0 || !line.trim()) return line;
      const cols = parseCSVLine(line);
      if ((cols[0] || '').trim() !== email) return line;
      found = true;
      const prevGb  = parseFloat(cols[2]) || 0;
      const addedGb = addedKb / 1024 / 1024;
      cols[2] = (prevGb + addedGb).toFixed(4);
      cols[4] = now;
      return cols.join(',');
    });
    if (found) fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
  } catch { /* non-fatal */ }
}

// Stamp Last Login Date and Account Status=Alive after a successful resume/manual
// upload login. If the tool was megacmd, Security Upgrade is blindly set to Yes
// (No→Yes and Yes→Yes are identical outcomes, so reading the existing value is unnecessary).
function touchAccountRow(email, toolUsed) {
  if (!email || !fs.existsSync(getAccountCsv())) return;
  try {
    const now     = new Date().toISOString();
    const raw     = fs.readFileSync(getAccountCsv(), 'utf8');
    const lines   = raw.split('\n');
    const updated = lines.map((line, idx) => {
      if (idx === 0 || !line.trim()) return line;
      const cols = parseCSVLine(line);
      if ((cols[0] || '').trim() !== email) return line;
      while (cols.length < 7) cols.push('');
      cols[4] = now;                                // Last Login Date
      cols[5] = 'Active';                           // Account Status
      if (toolUsed === 'megacmd') cols[6] = 'Yes'; // Security Upgrade (blind write)
    return cols.join(',');
    });
    fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
  } catch { /* non-fatal */ }
}

// Stamp Account Status = 'Over Quota' for a known-full account.
// Called from upload-engine.js when MEGA's storage-exceeded banner is detected
// so the CSV reflects reality immediately rather than waiting for a refresh cycle.
function markAccountOverQuota(email) {
  if (!email || !fs.existsSync(getAccountCsv())) return;
  try {
    const raw     = fs.readFileSync(getAccountCsv(), 'utf8');
    const lines   = raw.split('\n');
    const updated = lines.map((line, idx) => {
      if (idx === 0 || !line.trim()) return line;
      const cols = parseCSVLine(line);
      if ((cols[0] || '').trim() !== email) return line;
      while (cols.length < 7) cols.push('');
      cols[5] = 'Over Quota';
      return cols.join(',');
    });
    fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
  } catch { /* non-fatal */ }
}

// ── refresh-accounts ──────────────────────────────────────────────────────────
// Fallback chain per account: megatools → megacmd → rclone
// mode: 'all' | 'inactive' | 'dormantBatch'

let _refreshRunning = false, batchAbort = null;
const singleRefreshes = new Map();
function cancelRefreshAccounts() { batchAbort?.abort(new VpnControllerError('CANCELED')); }
function cancelSingleAccountRefresh(email) { singleRefreshes.get(email)?.abort(new VpnControllerError('CANCELED')); }

async function refreshAccounts(mode, send) {
  if (_refreshRunning) return;
  _refreshRunning = true; batchAbort = new AbortController();
  const signal = batchAbort.signal, startTime = Date.now();
  const counts = { alive: 0, dead: 0, suspended: 0, overStorage: 0, error: 0,
    transport: 0, authentication: 0, rateLimited: 0, unverified: 0, vpnWaits: 0, vpnErrors: 0 };
  let processed = 0, total = 0, plan, stage = 'selection', error = null;
  try {
    const cfg           = loadConfig();
    const days = refreshThresholdDays(cfg);
    const now = Date.now();
    if (!fs.existsSync(getAccountCsv())) {
      throw Object.assign(new Error('Account CSV missing'), { code: 'ACCOUNT_CSV_MISSING' });
    }

    const raw       = fs.readFileSync(getAccountCsv(), 'utf8');
    let accounts = parseAccountRecords(raw).filter(a => a.password);

    // Fisher-Yates shuffle so accounts are never hit in the same order
    for (let i = accounts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
    }

    if (mode === 'inactive' || mode === 'dormantBatch') {
      accounts = accounts.filter(a => needsAccountRefresh(a, days, now));
    }

    // 'dormantBatch': refresh only the N oldest eligible accounts (N comes from
    // Settings), processed in reverse chronological order (newest last-login first).
    if (mode === 'dormantBatch') {
      const BATCH_SIZE = Math.max(1, parseInt(cfg.dormantRefreshCount, 10) || 10);
      // Age key: last login, else date created, else 0 (treated as the oldest).
      const activityTs = (a) => {
        const l = new Date(a.lastLogin).getTime();
        if (!isNaN(l)) return l;
        const c = new Date(a.created).getTime();
        return isNaN(c) ? 0 : c;
      };

      accounts = accounts
      .sort((a, b) => activityTs(a) - activityTs(b))   // oldest first
      .slice(0, BATCH_SIZE)                            // keep the N oldest
      .sort((a, b) => activityTs(b) - activityTs(a));  // reverse chronological
    }


    total = accounts.length;
    if (!total) send('up:refreshLog', 'No accounts matched the filter — nothing to do.');
    else send('up:refreshLog', `Starting refresh — ${total} account(s) queued…`);
    plan = refreshVpn?.beginRefresh({ signal }) || { requireVpn: false, beforeAccount: async () => {}, close() {} };
    const order = cfg.toolOrderRefresh?.length ? cfg.toolOrderRefresh : ['megatools', 'megacmd', 'rclone'];
    for (let i = 0; i < accounts.length; i++) {
      checkCanceled(signal);
      const acc = accounts[i];
      const progress = (phase, message) => send('up:refreshProgress', { current: i + 1, total, email: acc.email, phase, message });
      send('up:refreshLog', `[${i + 1}/${total}] ${acc.email}`);
      stage = 'vpn'; let waiting = false;
      const onWaiting = snapshot => {
        const blockers = [...new Set(snapshot.activeOperations.map(operation => operation.kind === 'browser' ? 'MEGA browser' : operation.kind))];
        const message = snapshot.connectionProgress?.message || (blockers.length ? 'Waiting for VPN rotation: ' + blockers.join(', ') : 'Changing the VPN connection');
        if (!waiting) { waiting = true; counts.vpnWaits++; send('up:refreshLog', '  → Waiting for VPN rotation / verification'); }
        progress('vpn-wait', message);
      };
      await plan.beforeAccount(i, { signal, onWaiting });
      let committed = false;
      while (true) {
        checkCanceled(signal); stage = 'probe'; waiting = false;
        progress('probe-wait', 'Waiting for connection or shared account session');
        try {
          await network.run('account-refresh', async () => {
            progress('checking', 'Checking account');
            const attempt = await attemptAccountLogin(acc.email, acc.password, order);
            const failure = attempt.toolSucceeded ? null : classifyRefreshFailure(attempt.refreshErrs);
            persistRefreshResult(acc.email, attempt, failure);
            processed++;
            if (attempt.toolSucceeded) {
              const full = attempt.newStatus === 'Over Quota'; counts[full ? 'overStorage' : 'alive']++;
              committed = true;
              send('up:refreshLog', '  → ' + attempt.newStatus + ' — ' + (attempt.liveUsedBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB');
            } else {
              if (failure.kind === 'suspended') counts.suspended++;
              else if (failure.kind === 'terminated') counts.dead++;
              else if (failure.kind === 'overStorage') counts.overStorage++;
              else { counts.error++; counts[failure.kind]++; }
              committed = true;
              send('up:refreshLog', '  → ' + failure.message);
            }
          }, { signal, requireVpn: plan.requireVpn });
          break;
        } catch (caught) {
          checkCanceled(signal);
          if (!plan.requireVpn || !plan.recover || !['VPN_LOST', 'VPN_STATUS_UNAVAILABLE', 'VPN_RECOVERY', 'TRANSPORT_UNCONFIRMED'].includes(caught?.code)) throw caught;
          counts.vpnErrors++; stage = 'vpn';
          send('up:refreshLog', '  → VPN work paused. The account and completed results are retained; recovering automatically.');
          progress('vpn-wait', 'Waiting for Proton to report a connected VPN before resuming this account');
          await plan.recover({ signal, onWaiting });
          // Cleanup can fail after the synchronous CSV commit. Never repeat a
          // committed probe, its write, or its counters when the route returns.
          if (committed) break;
        }
      }
    }
  } catch (caught) {
    error = caught;
    if (!signal.aborted && !caught?.cancelled && (stage === 'vpn' || caught?.vpnInterrupted)) counts.vpnErrors++;
    send('up:refreshLog', (signal.aborted || caught?.cancelled ? 'Refresh canceled. ' : 'Refresh stopped. ') + refreshError(caught));
  } finally {
    plan?.close();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const canceled = signal.aborted || Boolean(error?.cancelled);
    send('up:refreshLog', `Processed ${processed}/${total}; active ${counts.alive}, over quota ${counts.overStorage}, suspended ${counts.suspended}, terminated ${counts.dead}; network ${counts.transport}, authentication ${counts.authentication}, rate limited ${counts.rateLimited}, unverified ${counts.unverified}; VPN waits ${counts.vpnWaits}, VPN errors ${counts.vpnErrors}. ${elapsed}s`);
    _refreshRunning = false; batchAbort = null;
    send('up:refreshDone', { counts, elapsed, total: processed, planned: total, canceled,
      ...(error && !canceled ? { error: refreshError(error) } : {}) });
  }
}

// ── check-accounts-health ─────────────────────────────────────────────────────
function checkAccountsHealth() {
  const empty = { total: 0, refreshCount: 0, thresholdDays: 90 };
  try {
    empty.thresholdDays = refreshThresholdDays(loadConfig());
    if (!fs.existsSync(getAccountCsv())) return empty;
    const accounts = parseAccountRecords(fs.readFileSync(getAccountCsv(), 'utf8'));
    const now = Date.now();
    const refreshCount = accounts.filter(a => needsAccountRefresh(a, empty.thresholdDays, now)).length;
    return { ...empty, total: accounts.length, refreshCount };
  } catch {
    return empty;
  }
}

// ── refresh-single-account ────────────────────────────────────────────────────
// Fallback chain: megatools → megacmd → rclone
async function refreshSingleAccount(email, password, send) {
  if (singleRefreshes.has(email)) return;
  const abort = new AbortController(); singleRefreshes.set(email, abort);
  try {
    const result = await network.run('single-account', async () => {
      const cfg = loadConfig();
      const order = cfg.toolOrderRefresh?.length ? cfg.toolOrderRefresh : ['megatools', 'megacmd', 'rclone'];
      const attempt = await attemptAccountLogin(email, password, order);
      const failure = attempt.toolSucceeded ? null : classifyRefreshFailure(attempt.refreshErrs);
      const result = persistRefreshResult(email, attempt, failure);
      return { email, ...result, ...(failure && !failure.status ? { error: failure.message } : {}) };
    }, { signal: abort.signal });
    send('up:refreshSingleDone', result);
  } catch (error) {
    send('up:refreshSingleDone', { email, error: refreshError(error), canceled: abort.signal.aborted || Boolean(error?.cancelled) });
  } finally { singleRefreshes.delete(email); }
}

// ── upgrade-all-insecure ──────────────────────────────────────────────────────
function persistSecurityUpgrade(email) {
  network.checkpoint('megacmd-session');
  let found = false;
  const lines = fs.readFileSync(getAccountCsv(), 'utf8').split('\n');
  const updated = lines.map((line, index) => {
    if (!index || !line.trim()) return line;
    const cols = parseCSVLine(line);
    if ((cols[0] || '').trim() !== email) return line;
    found = true;
    while (cols.length < 7) cols.push('');
    cols[6] = 'Yes';
    return cols.map(value => /[,"\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value).join(',');
  });
  if (!found) throw new Error('Account row no longer exists');
  fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
}

async function upgradeAllInsecure(send) {
  if (_refreshRunning) return;
  _refreshRunning = true; batchAbort = new AbortController();
  const signal = batchAbort.signal, startTime = Date.now();
  let upgraded = 0, failed = 0, processed = 0, total = 0, plan, error = null;
  try {
    if (!fs.existsSync(getAccountCsv())) throw Object.assign(new Error('Account CSV missing'), { code: 'ACCOUNT_CSV_MISSING' });
    const accounts = parseAccountRecords(fs.readFileSync(getAccountCsv(), 'utf8'))
      .filter(account => account.password && account.securityUpgrade !== 'Yes');
    total = accounts.length;
    send('up:refreshLog', total ? `Starting security upgrade — ${total} insecure account(s) queued…` : 'No insecure accounts found — nothing to do.');
    if (!total) return;
    plan = refreshVpn?.beginRefresh({ signal }) || { requireVpn: false, beforeAccount: async () => {}, close() {} };
    for (let i = 0; i < accounts.length; i++) {
      checkCanceled(signal);
      const acc = accounts[i];
      const progress = (phase, message) => send('up:refreshProgress', { current: i + 1, total, email: acc.email, phase, message });
      const onWaiting = snapshot => progress('vpn-wait', snapshot.connectionProgress?.message || 'Waiting for VPN connection or active work');
      send('up:refreshLog', `[${i + 1}/${total}] ${acc.email}`);
      await plan.beforeAccount(i, { signal, onWaiting });
      let committed = false;
      while (true) {
        checkCanceled(signal);
        progress('probe-wait', 'Waiting for connection or shared account session');
        try {
          // Release both route and MEGAcmd session at each account boundary,
          // before asking the shared coordinator for a scheduled rotation.
          await network.run('security-upgrade', async () => {
            try {
              progress('checking', 'Upgrading account security');
              let success = false;
              try {
                await ensureMegaCmdServer();
                await megaSwitch(acc.email, acc.password);
                await runCommandWithTimeout(megaCmdBin(), ['ls', '/'], megaSpawnOpts(), 60000);
                network.checkpoint('megacmd-session');
                success = true;
              } catch (caught) {
                network.interruption(caught);
                failed++;
                send('up:refreshLog', '  → Security upgrade not applied; MEGAcmd could not complete the account check.');
              }
              if (success) {
                persistSecurityUpgrade(acc.email);
                upgraded++;
                send('up:refreshLog', '  → Security Upgrade: Yes');
              }
              processed++; committed = true;
            } finally {
              network.checkpoint('megacmd-session');
              await megaLogout();
              network.checkpoint('megacmd-session');
            }
          }, { signal, requireVpn: plan.requireVpn });
          break;
        } catch (caught) {
          checkCanceled(signal);
          if (!plan.requireVpn || !plan.recover || !['VPN_LOST', 'VPN_STATUS_UNAVAILABLE', 'VPN_RECOVERY', 'TRANSPORT_UNCONFIRMED'].includes(caught?.code)) throw caught;
          send('up:refreshLog', '  → VPN work paused. This account and saved upgrades are retained; recovering automatically.');
          progress('vpn-wait', 'Waiting for Proton to report a connected VPN before resuming this account');
          await plan.recover({ signal, onWaiting });
          // A cleanup interruption after a saved upgrade must not repeat it.
          if (committed) break;
        }
      }
    }
  } catch (caught) {
    error = caught;
    send('up:refreshLog', (signal.aborted || caught?.cancelled ? 'Security upgrade canceled. ' : 'Security upgrade stopped. ') +
      (caught?.vpnInterrupted || caught?.name === 'ProtonVpnError' ? caught.message : caught?.code === 'ACCOUNT_CSV_MISSING'
        ? 'account_log.csv not found.' : 'Completed upgrades were preserved; the remaining accounts were left unchanged.'));
  } finally {
    plan?.close();
    const canceled = signal.aborted || Boolean(error?.cancelled), elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    send('up:refreshLog', `Processed ${processed}/${total}; upgraded ${upgraded}, failed ${failed}. Completed upgrades saved. ${elapsed}s`);
    _refreshRunning = false; batchAbort = null;
    send('up:upgradeAllDone', { upgraded, failed, elapsed, total: processed, planned: total, canceled,
      ...(error && !canceled ? { error: error?.vpnInterrupted || error?.name === 'ProtonVpnError' ? error.message
        : error?.code === 'ACCOUNT_CSV_MISSING' ? 'account_log.csv not found.' : 'Security upgrade stopped. Completed results were preserved.' } : {}) });
  }
}

// Blindly write 'Yes' to the Security Upgrade column for a given email.
// Only modifies col[6] — does not touch Last Login Date or Account Status.
// Idempotent: rows already marked 'Yes' are left unchanged.
function markSecurityUpgrade(email) {
  if (!email || !fs.existsSync(getAccountCsv())) return;
  try {
    const raw     = fs.readFileSync(getAccountCsv(), 'utf8');
    const lines   = raw.split('\n');
    const updated = lines.map((line, idx) => {
      if (idx === 0 || !line.trim()) return line;
      const cols = parseCSVLine(line);
      if ((cols[0] || '').trim() !== email) return line;
      if ((cols[6] || '').trim() === 'Yes') return line; // already upgraded — no-op
      while (cols.length < 7) cols.push('');
      cols[6] = 'Yes';
      return cols.join(',');
    });
    fs.writeFileSync(getAccountCsv(), updated.join('\n'), 'utf8');
  } catch { /* non-fatal */ }
}

module.exports = {
  appendAccountRow,
  updateAccountRow,
  touchAccountRow,
  markAccountOverQuota,
  markSecurityUpgrade,
  installRefreshVpn, cancelRefreshAccounts, cancelSingleAccountRefresh,
  refreshAccounts,
  checkAccountsHealth,
  refreshSingleAccount,
  upgradeAllInsecure,
};
