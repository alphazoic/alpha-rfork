'use strict';
// Real main/service/controller/preload/renderers, isolated profile, fake Proton.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
async function main() {
  const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-vpn-catalog-ui-'));
  const data = path.join(profile, 'data'); fs.mkdirSync(data);
  const configPath = path.join(profile, 'mega-dl-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dataDir: data, defaultOutputDir: data, defaultTab: 'settings', toolOrderRefresh: ['megatools'], omdbApiKey: 'preserved-key', proxy: 'https://unused.invalid' }));
  const csv = 'Switzerland,Zurich,CH#1\nGermany,Berlin,DE#2\nUnited States,Atlanta,US#3\n"Test, Land",Capital,ZZ#1\nFrance,Paris,FR#13-TOR,\n';
  fs.writeFileSync(path.join(profile, 'valid.txt'), csv); fs.writeFileSync(path.join(profile, 'invalid.txt'), 'invalid private catalog');
  const preload = path.join(profile, 'preload.cjs'), launcher = path.join(profile, 'launcher.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'preload.js'))});
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('catalogQa', { action: value => ipcRenderer.invoke('catalog-qa', value) });`);
  fs.writeFileSync(launcher, `
const { app, ipcMain, Menu } = require('electron');
const path = require('path');
const ROOT = ${JSON.stringify(root)}, PROFILE = ${JSON.stringify(profile)};
app.setPath('userData', PROFILE);
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [] }, { label: 'Help', submenu: [] }]));
global.fetch = async () => ({ ok: false });
const cp = require('child_process'), originalSpawn = cp.spawn;
cp.spawn = (command, ...args) => { if (/protonvpn/.test(command)) throw new Error('Live Proton forbidden'); return originalSpawn(command, ...args); };
let mode = 'ok', file = 'valid', status = { state: 'disconnected', server: null }, targets = [];
let controller, virtual = false, offset = 0, timerSequence = 0, statusFailure = false, fault = null, releaseProbe, cliOutstanding = false;
let probes = [], batchEvents = [], writes = 0, tracking = false, mutations = 0, peakMutations = 0, upgradeEmail = null;
const timers = new Map(), time = () => Date.now() + offset;
const control = require(path.join(ROOT, 'src/vpn-controller')), realController = control.createVpnController;
control.createVpnController = options => controller = realController({ ...options, now: time,
  retryTimers: {
    setTimeout(fn, ms) { if (!virtual) return setTimeout(fn, ms); const id = ++timerSequence; timers.set(id, { fn, at: time() + ms }); return id; },
    clearTimeout(id) { if (timers.has(id)) timers.delete(id); else clearTimeout(id); }
  }
});
const network = require(path.join(ROOT, 'src/network-operations'));
require(path.join(ROOT, 'src/proc-utils')).runCommandWithTimeout = async (_command, args) => {
  network.checkpoint('megacmd-session');
  if (args[0] === 'ls') {
    probes.push(args.includes('-u') ? args[args.indexOf('-u') + 1] : upgradeEmail);
    if (fault && probes.length === 2) {
      const chosen = fault; fault = null;
      if (chosen === 'disconnect') { status = { state: 'disconnected', server: null }; mode = 'zero'; await controller.poll(); }
      else {
        statusFailure = true; await controller.poll();
        const signal = network.currentSignal();
        await new Promise((resolve, reject) => {
          const done = () => { signal.removeEventListener('abort', abort); releaseProbe = null; resolve(); };
          const abort = () => { signal.removeEventListener('abort', abort); releaseProbe = null; reject(signal.reason); };
          releaseProbe = done; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
      }
    }
  }
  network.checkpoint(); return args[0] === 'df' ? 'Used: 128' : 'Root';
};
// Exercise the real security-upgrade workflow/IPC/CSV path with local command fixtures.
const mega = require(path.join(ROOT, 'src/megacmd'));
mega.ensureMegaCmdServer = async () => network.checkpoint('megacmd-session');
mega.megaSwitch = async email => { network.checkpoint('megacmd-session'); upgradeEmail = email; };
mega.megaLogout = async () => network.checkpoint('megacmd-session');
const manager = require(path.join(ROOT, 'src/account-manager')), realRefresh = manager.refreshAccounts, realUpgrade = manager.upgradeAllInsecure;
manager.refreshAccounts = (mode, send) => realRefresh(mode, (channel, data) => { batchEvents.push({ channel, data }); send(channel, data); });
manager.upgradeAllInsecure = send => realUpgrade((channel, data) => { batchEvents.push({ channel, data }); send(channel, data); });
const accountPath = path.join(PROFILE, 'data', 'account_log.csv'), realWrite = require('fs').writeFileSync;
require('fs').writeFileSync = function(file, ...args) { if (tracking && file === accountPath) writes++; return realWrite.call(this, file, ...args); };
const proton = require(path.join(ROOT, 'src/protonvpn'));
const caps = { commands: { connect: true, disconnect: true, status: true }, selectors: { server: true, country: true, city: true, random: true } };
const adapter = {
  getProcessState() { return { blocked: cliOutstanding }; },
  async inspect() { return caps; },
  async diagnose() { return { ready: true, installed: true, version: '1.0.5', authentication: 'signed-in', capabilities: caps, diagnostics: [], status }; },
  async getStatus() { if (statusFailure) throw new proton.ProtonVpnError('COMMAND_FAILED', 'status', 0); return structuredClone(status); },
  async connect(target) {
    targets.push(target); status = { state: 'disconnected', server: null };
    if (controller.snapshot().activeOperations.length) throw new Error('Route mutation overlapped account work');
    peakMutations = Math.max(peakMutations, ++mutations);
    try {
    if (mode !== 'ok') {
      const error = new proton.ProtonVpnError(mode === 'auth' ? 'AUTH_REQUIRED' : mode === 'unsafe' ? 'TIMEOUT' : mode === 'zero' ? 'COMMAND_FAILED' : 'CONNECTION_FAILED', 'connect', mode === 'zero' ? 0 : 1);
      if (mode === 'unsafe') cliOutstanding = true;
      error.terminationConfirmed = mode !== 'unsafe'; throw error;
    }
    return status = { state: 'connected', server: { id: target.server || 'CH#1', location: 'Fixture location' } };
    } finally { mutations--; }
  },
  async disconnect() { return status = { state: 'disconnected', server: null }; },
};
proton.createProtonVpn = () => adapter;
const electron = require('electron'), NativeWindow = electron.BrowserWindow;
const fixtureElectron = Object.create(electron);
Object.defineProperty(fixtureElectron, 'dialog', { value: { ...electron.dialog,
  async showOpenDialog() { return file === 'cancel' ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path.join(PROFILE, file + '.txt')] }; }
} });
Object.defineProperty(fixtureElectron, 'BrowserWindow', { value: class extends NativeWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, preload: ${JSON.stringify(preload)}, sandbox: false } }); }
  loadFile(value, options) { return super.loadFile(path.isAbsolute(value) ? value : path.join(ROOT, value), options); }
} });
const Module = require('module'), originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'electron' ? fixtureElectron : originalLoad.call(this, id, ...args); };
ipcMain.handle('catalog-qa', async (_, value) => {
  if (['ok', 'fail', 'auth', 'unsafe'].includes(value)) mode = value;
  if (['file-valid', 'file-invalid', 'file-cancel'].includes(value)) file = value.slice(5);
  if (value === 'close-process') { cliOutstanding = false; mode = 'ok'; }
  if (value?.action === 'seed-batch') {
    virtual = true; tracking = false; mode = 'ok'; statusFailure = false; fault = value.fault;
    realWrite(accountPath, 'Email,Password,Used,Created,Last Login,Status,Security\\n' +
      Array.from({ length: value.count || 4 }, (_, i) => 'fixture' + i + '@example.test,fixture-only,7,2020-01-01,2021-01-01,Active,No\\n').join(''));
    probes = []; batchEvents = []; writes = 0; tracking = true; upgradeEmail = null;
  }
  if (value === 'next-timer') {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (next) { offset += Math.max(0, next[1].at - time()); timers.delete(next[0]); next[1].fn(); }
    await new Promise(resolve => setImmediate(resolve));
  }
  if (value === 'heal-status') { statusFailure = false; await controller.poll(); releaseProbe?.(); }
  if (value === 'monitor') await controller.poll();
  return { mode, targets: structuredClone(targets), controller: controller?.snapshot(), probes, writes,
    done: batchEvents.filter(event => event.channel === 'up:refreshDone').map(event => event.data),
    upgradeDone: batchEvents.filter(event => event.channel === 'up:upgradeAllDone').map(event => event.data),
    peakMutations, timers: timers.size };
});
require(path.join(ROOT, 'main.js'));
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', launcher], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', browser, page, stage = 'launch'; const errors = [];
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No browser endpoint')), 20000);
    child.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code)); });
  });
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint });
    for (let i = 0; i < 100; i++) { page = (await browser.pages()).find(value => value.url().endsWith('/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(page); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.catalogQa && document.getElementById('vpn-catalog-summary').textContent.includes('16,821'));
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    const set = (id, value) => page.$eval('#' + id, (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    const qa = value => page.evaluate(value => window.catalogQa.action(value), value);
    const connected = () => page.waitForFunction(() => document.getElementById('vpn-state').textContent === 'Connected' && !document.getElementById('vpn-connect').disabled);
    const save = async () => { await page.click('#vpn-save'); await page.waitForFunction(() => !document.getElementById('vpn-save-status').textContent.includes('Unsaved') && !document.getElementById('vpn-save').disabled); };
    stage = 'local import';
    await page.click('#vpn-catalog-import');
    await page.waitForFunction(() => document.getElementById('vpn-catalog-summary').textContent.includes('4 regular servers'));
    assert.match(await page.$eval('#vpn-catalog-summary', element => element.textContent), /Excluded 1 Tor/);
    assert.equal(fs.readFileSync(path.join(profile, 'valid.txt'), 'utf8'), csv);
    stage = 'pool filters and local lookup';
    await page.select('#vpn-pool-mode', 'countries'); await page.select('#vpn-country-picker', 'Test, Land'); await page.click('#vpn-country-add');
    await page.waitForFunction(() => document.getElementById('vpn-pool-summary').textContent.startsWith('1 eligible'));
    assert.equal(await page.$eval('#vpn-countries', element => element.value), '"Test, Land"');
    await set('vpn-countries', ''); await page.select('#vpn-country-picker', 'Germany'); await page.click('#vpn-country-add');
    await page.waitForFunction(() => document.getElementById('vpn-pool-summary').textContent.startsWith('1 eligible'));
    await page.$eval('#vpn-search', element => { element.closest('details').open = true; }); await set('vpn-search', 'Berlin');
    await page.waitForFunction(() => document.getElementById('vpn-server-results').options.length === 1);
    await page.click('#vpn-server-add'); assert.equal(await page.$eval('#vpn-pool-mode', element => element.value), 'servers');
    await page.select('#vpn-pool-mode', 'cities');
    const atlanta = JSON.stringify({ country: 'United States', city: 'Atlanta' });
    await page.select('#vpn-cities', atlanta); await page.select('#vpn-order', 'file-order'); await set('vpn-recent', '0');
    await page.$eval('#vpn-retry-fields', element => { element.closest('details').open = true; });
    await set('vpn-retry-candidates', '1'); await set('vpn-retry-initial', '0'); await set('vpn-retry-cooldown', '0'); await set('vpn-retry-restart', '1');
    await page.select('#vpn-mode', 'manual'); await page.click('#vpn-enabled'); await save();
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.omdbApiKey, 'preserved-key'); assert.equal(saved.vpn.serverSelection.mode, 'cities'); assert.equal(saved.vpn.connectionRetry.roundRetryDelayMs, 1000);
    stage = 'real manual catalog connection';
    await page.select('#vpn-target', 'pool'); await page.click('#vpn-connect'); await connected();
    assert.deepEqual((await qa('snapshot')).targets, [{ server: 'US#3' }]);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.catalogQa && document.getElementById('vpn-catalog-summary').textContent.includes('4 regular servers'));
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    assert.equal(await page.$eval('#vpn-pool-mode', element => element.value), 'cities');
    assert.equal(await page.$eval('#vpn-cities', element => element.selectedOptions[0].textContent), 'United States · Atlanta');
    stage = 'action required and persisted pool change';
    await page.select('#vpn-pool-mode', 'servers'); await set('vpn-servers', 'DE#2'); await save(); await page.select('#vpn-target', 'pool');
    await qa('auth'); await page.click('#vpn-connect');
    await page.waitForFunction(() => !document.getElementById('vpn-held-actions').hidden && !document.getElementById('vpn-retry').disabled);
    assert.equal(await page.$eval('#vpn-state', element => element.textContent), 'Waiting for Proton');
    await page.click('#vpn-change-pool'); await page.waitForFunction(() => !document.getElementById('vpn-apply-pool-row').hidden);
    assert.equal(await page.$eval('#vpn-enabled', element => element.disabled), true);
    await set('vpn-servers', 'US#3'); await qa('ok'); await page.click('#vpn-apply-pool'); await connected();
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).vpn.serverSelection.servers, ['US#3']);
    stage = 'editing pauses a timed retry';
    await set('vpn-servers', 'DE#2'); await save(); await page.select('#vpn-target', 'pool'); await qa('fail'); await page.click('#vpn-connect');
    await page.waitForFunction(() => document.getElementById('vpn-state').textContent === 'Waiting to retry' && !document.getElementById('vpn-retry').disabled);
    await page.click('#vpn-change-pool'); await page.waitForFunction(() => !document.getElementById('vpn-apply-pool-row').hidden);
    const beforeEdit = (await qa('snapshot')).targets.length; await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await qa('snapshot')).targets.length, beforeEdit);
    await page.click('#vpn-abandon-pool'); await qa('ok'); await page.click('#vpn-retry'); await connected();
    stage = 'cancel held edit';
    await set('vpn-servers', 'US#3'); await save(); await page.select('#vpn-target', 'pool'); await qa('auth'); await page.click('#vpn-connect');
    await page.waitForFunction(() => !document.getElementById('vpn-retry').disabled);
    await page.click('#vpn-change-pool'); await page.click('#vpn-cancel');
    await page.waitForFunction(() => document.getElementById('vpn-cancel').hidden);
    const canceled = (await qa('snapshot')).targets.length; await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal((await qa('snapshot')).targets.length, canceled);
    stage = 'invalid and canceled imports, reset';
    await qa('file-invalid'); await page.click('#vpn-catalog-import');
    await page.waitForFunction(() => !document.getElementById('vpn-catalog-import').disabled && document.getElementById('vpn-error').textContent.includes('Expected country'));
    assert.match(await page.$eval('#vpn-catalog-summary', element => element.textContent), /4 regular servers/);
    await qa('file-cancel'); await page.click('#vpn-catalog-import');
    assert.equal((await page.evaluate(() => window.api.vpnCatalog())).catalog.servers, 4);
    assert.equal((await page.evaluate(() => window.api.vpnCatalogAction({ action: 'import', file: '/private' }))).ok, false);
    await page.click('#vpn-catalog-reset'); await page.waitForFunction(() => document.getElementById('vpn-catalog-summary').textContent.includes('16,821'));
    stage = 'real batch: temporary status uncertainty';
    await qa('file-valid'); await page.click('#vpn-catalog-import');
    await page.waitForFunction(() => !document.getElementById('vpn-catalog-import').disabled && document.getElementById('vpn-catalog-summary').textContent.includes('4 regular servers'));
    await set('vpn-servers', 'CH#1, DE#2, US#3');
    await page.select('#vpn-refresh-mode', 'batch'); await set('vpn-refresh-batch', '100'); await save();
    await qa('ok'); await page.click('#vpn-connect'); await connected();
    const accounts = async () => { await page.click('.tab[data-tab="upload"]'); await page.click('#up-tabAccounts'); };
    const waitHeld = () => page.waitForFunction(async () => (await window.api.vpnGetState()).controller.retryWaiting);
    const waitDone = () => page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.startsWith('Done — 4 checked'));
    const initialTargets = (await qa('snapshot')).targets.length;
    await qa({ action: 'seed-batch', fault: 'status' }); await accounts(); await page.click('#btn-refreshAll');
    await page.waitForFunction(async () => (await window.api.vpnGetState()).controller.state === 'checking');
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    assert.match(await page.$eval('#vpn-recovery-last', element => element.textContent), /Connected to/);
    assert.match(await page.$eval('#vpn-recovery-status', element => element.textContent), /Temporarily unavailable/);
    assert.match(await page.$eval('#vpn-recovery-command', element => element.textContent), /protonvpn status/);
    assert.equal(await page.$eval('#vpn-disconnect', element => element.disabled), true);
    const duringRefresh = await page.evaluate(() => window.api.vpnCommand({ action: 'disconnect' }));
    assert.equal(duringRefresh.ok, false); assert.equal(duringRefresh.error.code, 'DISCONNECT_BUSY');
    await (await page.$('#vpn-waiting')).screenshot({ path: '/tmp/m3-vpn-continuous-checking.png' });
    await qa('heal-status'); await waitDone();
    let batch = await qa('snapshot');
    assert.equal(batch.writes, 4); assert.equal(batch.probes.length, 4); assert.equal(batch.done.length, 1);
    assert.equal(batch.targets.length, initialTargets); assert.equal(batch.done[0].counts.alive, 4);

    stage = 'real batch: persistent unknown status and automatic resumption';
    await qa({ action: 'seed-batch', fault: 'status' }); await accounts(); await page.click('#btn-refreshAll');
    await page.waitForFunction(async () => (await window.api.vpnGetState()).controller.state === 'checking');
    await qa('next-timer'); await waitHeld();
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    assert.equal(await page.$eval('#vpn-cancel', element => element.hidden || element.disabled), false);
    assert.match(await page.$eval('#vpn-waiting', element => element.textContent), /temporarily unavailable|status command reported an error/);
    assert.ok(!await page.$eval('#vpn-error', element => element.textContent.includes('protection was lost')));
    for (let i = 0; i < 3; i++) { await qa('next-timer'); await waitHeld(); }
    batch = await qa('snapshot'); assert.equal(batch.writes, 1); assert.equal(batch.done.length, 0);
    await qa('heal-status'); await qa('next-timer'); await waitDone();
    batch = await qa('snapshot');
    assert.equal(batch.writes, 4); assert.equal(batch.probes.length, 5); assert.equal(batch.probes[1], batch.probes[2]);
    assert.equal(batch.targets.length, initialTargets); assert.equal(batch.done.length, 1);

    stage = 'real batch: exit-zero failures across many automatic rounds';
    await qa({ action: 'seed-batch', fault: 'disconnect' }); await accounts(); await page.click('#btn-refreshAll'); await waitHeld();
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    assert.match(await page.$eval('#vpn-error', element => element.textContent), /despite exiting with code 0/);
    assert.match(await page.$eval('#vpn-recovery-command', element => element.textContent), /protonvpn connect/);
    assert.match(await page.$eval('#vpn-recovery-last', element => element.textContent), /Disconnected/);
    for (let i = 0; i < 12; i++) {
      const round = (await qa('snapshot')).controller.connectionProgress.round;
      await qa('next-timer');
      await page.waitForFunction(async previous => {
        const ctl = (await window.api.vpnGetState()).controller;
        return ctl.retryWaiting && ctl.connectionProgress.round > previous;
      }, {}, round);
    }
    batch = await qa('snapshot');
    assert.equal(batch.done.length, 0); assert.equal(batch.writes, 1);
    assert.equal(new Set(batch.targets.slice(initialTargets).map(target => target.server)).size, 3);
    for (const width of [1200, 900]) {
      await page.setViewport({ width, height: 1000 });
      await page.$eval('#vpn-waiting', element => element.scrollIntoView({ block: 'center' }));
      assert.equal(await page.$eval('#vpn-waiting', element => element.scrollWidth <= element.clientWidth + 1), true);
      assert.equal(await page.$eval('#vpn-cancel', element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true);
      await (await page.$('#vpn-waiting')).screenshot({ path: '/tmp/m3-vpn-continuous-retrying-' + width + '.png' });
    }
    await qa('ok'); await qa('next-timer'); await waitDone();
    batch = await qa('snapshot');
    assert.equal(batch.done.length, 1); assert.equal(batch.done[0].counts.alive, 4);
    assert.equal(batch.writes, 4); assert.equal(batch.probes.length, 5); assert.equal(batch.probes[1], batch.probes[2]);
    assert.equal(batch.peakMutations, 1); assert.ok(batch.controller.history.length <= 100);

    stage = 'real batch: Stop cancels automatic recovery permanently for that job';
    await qa({ action: 'seed-batch', fault: 'disconnect' }); await accounts(); await page.click('#btn-refreshAll'); await waitHeld();
    await page.click('#btn-cancelRefresh');
    await page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.startsWith('Canceled — 1/4 checked'));
    const stopped = await qa('snapshot'); assert.equal(stopped.done.length, 1); assert.equal(stopped.writes, 1);
    await qa('ok'); await qa('next-timer'); await qa('monitor');
    batch = await qa('snapshot'); assert.equal(batch.targets.length, stopped.targets.length); assert.equal(batch.timers, 0);

    stage = 'real security upgrade: lease, every-five rotation, completion, and saved results';
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings');
    const upgradeSettings = await page.evaluate(() => window.api.vpnSaveSettings({ refreshMode: 'batch', refreshBatchSize: 5,
      serverSelection: { mode: 'servers', servers: ['CH#1', 'DE#2', 'US#3'], recentLimit: 0 } }));
    assert.equal(upgradeSettings.ok, true);
    await page.click('#vpn-connect'); await connected();
    const beforeUpgrades = (await qa('snapshot')).targets.length;
    await qa({ action: 'seed-batch', count: 12 }); await accounts(); await page.click('#btn-upgradeInsecure');
    await page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.startsWith('Done — 12/12 upgraded'));
    batch = await qa('snapshot');
    assert.equal(batch.upgradeDone.length, 1); assert.equal(batch.upgradeDone[0].upgraded, 12);
    assert.equal(batch.targets.length, beforeUpgrades + 2); assert.equal(batch.writes, 12);
    assert.equal(await page.$eval('#btn-upgradeInsecure', element => element.disabled), false);
    assert.equal(await page.$eval('#btn-cancelRefresh', element => element.hidden), true);
    assert.ok(fs.readFileSync(path.join(data, 'account_log.csv'), 'utf8').trim().split('\n').slice(1).every(line => line.endsWith(',Yes')));
    stage = 'real security upgrade: cancellation during automatic recovery';
    await qa({ action: 'seed-batch', fault: 'disconnect' }); await accounts(); await page.click('#btn-upgradeInsecure'); await waitHeld();
    assert.equal(await page.$eval('#btn-cancelRefresh', element => element.hidden), false);
    await page.click('#btn-cancelRefresh');
    await page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.startsWith('Canceled — 1/4 upgraded'));
    batch = await qa('snapshot'); assert.equal(batch.upgradeDone.length, 1); assert.equal(batch.writes, 1);
    const upgradeTargets = batch.targets.length;
    await qa('ok'); await qa('next-timer'); await qa('monitor');
    assert.equal((await qa('snapshot')).targets.length, upgradeTargets);

    stage = 'explicit Disconnect with idle reconnect enabled';
    await page.click('#vpn-status-pill'); await page.click('#vpn-terminal-settings'); await page.click('#vpn-auto-recover'); await save();
    await page.click('#vpn-connect'); await connected();
    const disconnectTargets = (await qa('snapshot')).targets.length;
    await page.click('#vpn-disconnect');
    await page.waitForFunction(() => document.getElementById('vpn-state').textContent === 'Disconnected' && document.getElementById('vpn-cancel').hidden);
    await qa('monitor'); await qa('next-timer');
    batch = await qa('snapshot'); assert.equal(batch.targets.length, disconnectTargets); assert.equal(batch.controller.state, 'disconnected');
    await page.click('#vpn-connect'); await connected();
    stage = 'late CLI closure resumes automatically without a manual Retry';
    await qa('unsafe'); await page.click('#vpn-switch'); await waitHeld();
    assert.equal(await page.$eval('#vpn-retry', element => element.disabled), true);
    assert.match(await page.$eval('#vpn-recovery-reason', element => element.textContent), /previous CLI process to close/);
    const outstanding = (await qa('snapshot')).targets.length;
    await qa('next-timer'); await waitHeld();
    assert.equal((await qa('snapshot')).targets.length, outstanding);
    await qa('close-process'); await qa('next-timer'); await connected();
    assert.equal((await qa('snapshot')).targets.length, outstanding + 1);
    stage = 'layout';
    for (const width of [1200, 900]) {
      await page.setViewport({ width, height: 1000 }); await page.$eval('#vpn-pool-fields', element => element.scrollIntoView({ block: 'start' }));
      assert.equal(await page.$eval('#vpn-settings-card', element => element.scrollWidth <= element.clientWidth + 1), true);
      await page.screenshot({ path: '/tmp/m3-vpn-catalog-' + width + '.png' });
    }
    stage = 'unconfirmed CLI process cannot be bypassed from controls';
    await qa('file-valid'); await page.click('#vpn-catalog-import');
    await page.waitForFunction(() => !document.getElementById('vpn-catalog-import').disabled && document.getElementById('vpn-catalog-summary').textContent.includes('4 regular servers'));
    const unsafeTarget = (await qa('snapshot')).controller.status.server?.id === 'DE#2' ? 'US#3' : 'DE#2';
    await set('vpn-servers', unsafeTarget); await save(); await page.select('#vpn-target', 'pool'); await qa('unsafe'); await page.click('#vpn-connect');
    await waitHeld();
    assert.equal(await page.$eval('#vpn-retry', element => element.disabled), true);
    assert.equal(await page.$eval('#vpn-change-pool', element => element.disabled), true);
    const blocked = (await qa('snapshot')).targets.length;
    await page.click('#vpn-cancel'); await page.waitForFunction(() => document.getElementById('vpn-cancel').hidden);
    await qa('monitor'); await qa('next-timer');
    assert.equal((await qa('snapshot')).controller.connectionCommandActive, false);
    assert.equal((await page.evaluate(() => window.api.vpnRetry())).ok, false);
    assert.equal((await qa('snapshot')).targets.length, blocked);
    assert.deepEqual(errors, []);
    console.log('Real Electron catalog/retry/refresh flow passed: 12-account security upgrade with every-five rotation, per-account saves, UI completion and recovery cancellation; native catalog controls, settings persistence, paused pool editing, Retry now, Cancel, 1200/900px layout, actual account refresh through temporary/persistent status errors and 13 failed exit-zero rounds, same-account resumption with one CSV commit per account, Stop without restart, explicit Disconnect with idle recovery enabled, automatic recovery after late CLI closure. No live VPN or external requests.');
  } catch (error) {
    console.error('Catalog UI stage: ' + stage + '; page errors: ' + errors.join('; ') + '\n' + stderr.slice(-1000));
    if (page) { console.error(await page.evaluate(async () => {
      const state = await window.api.vpnGetState(), qa = await window.catalogQa.action('snapshot');
      return { error: document.getElementById('vpn-error')?.textContent, state: document.getElementById('vpn-state')?.textContent,
        pool: state.preferences.serverSelection, progress: state.controller.connectionProgress, targets: qa.targets, timers: qa.timers };
    })); await page.screenshot({ path: '/tmp/m3-vpn-catalog-debug.png' }); }
    throw error;
  } finally {
    browser?.disconnect(); child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) return resolve(); const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
