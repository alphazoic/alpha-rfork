'use strict';

// Launch the real Electron shell/preload/renderers with an isolated userData
// directory and explicit fake VPN IPC responses. Live Proton subprocesses are
// blocked in this fixture. Production code has no test-mode environment switch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert/strict');
const puppeteer = require('puppeteer');

async function main() {
  const root = path.resolve(__dirname, '..');
  const rforkLicense = path.join(root, 'bin/rfork-bundle/LICENSE-rclone.txt');
  const licenseMode = fs.statSync(rforkLicense).mode & 0o777;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-vpn-phase3-'));
  const dataDir = path.join(profile, 'data'); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(profile, 'mega-dl-config.json'), JSON.stringify({
    omdbApiKey: 'preserved-key', dataDir, defaultOutputDir: dataDir, proxy: 'https://worker.example.test', defaultTab: 'settings',
    toolOrderUpload: ['rclone', 'megacmd', 'megatools'],
    toolOrderRefresh: ['megacmd', 'rclone', 'megatools'],
    toolOrderView: ['rclone', 'megatools', 'megacmd'],
  }));
  const launcher = path.join(profile, 'launcher.cjs');
  fs.writeFileSync(launcher, `
const { app, ipcMain, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const ROOT = ${JSON.stringify(root)};
app.setPath('userData', ${JSON.stringify(profile)});
process.on('uncaughtException', error => { console.error('UI fixture startup error: ' + error.message); app.exit(1); });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [] }, { label: 'Help', submenu: [] }]));
global.fetch = async () => ({ ok: false }); // No external update/network requests.
const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, ...args) => {
  if (/protonvpn/.test(command)) throw new Error('UI QA cannot run the live Proton CLI');
  return originalSpawn(command, ...args);
};
require(path.join(ROOT, 'main.js'));
const { normalizeVpnSettings } = require(path.join(ROOT, 'src/vpn-settings'));
const { createVpnController } = require(path.join(ROOT, 'src/vpn-controller'));
const configPath = path.join(app.getPath('userData'), 'mega-dl-config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return { omdbApiKey: 'preserved-key' }; } };
let state = { revision: 100, supported: true, preferences: normalizeVpnSettings(),
  controller: createVpnController().snapshot(), diagnostics: null, serviceError: null,
  saving: false, checking: false, commands: [], history: [], availability: { refreshRotation: true, downloadRecovery: true, uploadRecovery: true }, serverDirectoryUrl: 'https://account.proton.me/vpn/WireGuard' };
function emit() {
  state.revision++;
  // Native BrowserWindow factories can return instances without the fixture
  // subclass prototype; enumerate webContents independently of that override.
  for (const contents of require('electron').webContents.getAllWebContents()) {
    if (contents.getType() === 'window') contents.send('vpn:state', state);
  }
}
function handler(name, callback) { ipcMain.removeHandler(name); ipcMain.handle(name, callback); }
function notify(channel, data) {
  for (const contents of require('electron').webContents.getAllWebContents()) {
    if (contents.getType() === 'window') contents.send(channel, data);
  }
}
const accountRows = [{ email: 'qa@example.test', password: 'fixture-only', status: 'Active',
  created: '2020-01-01', lastLogin: '2021-01-01', bandwidth: '7', securityUpgrade: 'No' }];
ipcMain.removeAllListeners('refresh-accounts');
ipcMain.removeAllListeners('cancel-account-refresh');
ipcMain.removeAllListeners('refresh-single-account');
ipcMain.removeAllListeners('cancel-single-account-refresh');
ipcMain.on('refresh-accounts', () => {
  state.refreshing = true; emit();
  notify('up:refreshProgress', { current: 2, total: 3, phase: 'vpn-wait', message: 'Waiting for VPN rotation: download' });
});
ipcMain.on('cancel-account-refresh', () => {
  state.refreshing = false; emit();
  notify('up:refreshDone', { total: 1, planned: 3, canceled: true, elapsed: '1.0', counts: {} });
});
ipcMain.on('refresh-single-account', () => {});
ipcMain.on('cancel-single-account-refresh', (_, { email }) => notify('up:refreshSingleDone', { email, canceled: true, error: 'VPN operation canceled.' }));
let controlledDownloads = false;
for (const channel of ['start-download', 'abort-download', 'skip-download']) ipcMain.removeAllListeners(channel);
ipcMain.on('start-download', () => {
  state.transferring = true; emit();
  if (controlledDownloads) return;
  notify('dl:batchStart', { totalFiles: 1, totalBytes: 1024 });
  notify('dl:progress', { fileName: 'fixture.bin', fileSize: 1024, receivedBytes: 128, chunk: 1, totalChunks: 1 });
  notify('dl:vpnState', { state: 'waiting', message: 'VPN recovery waiting for: upload' });
});
ipcMain.on('abort-download', () => {
  if (controlledDownloads) return;
  state.transferring = false; emit(); notify('dl:done', { duration: 1000, totalFiles: 1, failedFiles: 0, canceled: true });
});
ipcMain.on('skip-download', () => {
  state.transferring = false; emit(); notify('dl:done', { duration: 1000, totalFiles: 1, failedFiles: 0, skipped: true });
});
handler('vpn-get-state', () => state);
handler('vpn-diagnose', () => {
  state.diagnostics = { installed: true, version: '1.0.5', authentication: 'signed-in', ready: true,
    status: { state: 'disconnected', server: null }, diagnostics: [] };
  state.serviceError = null; emit(); return { ok: true, state };
});
handler('vpn-save-settings', (_, value) => {
  state.preferences = normalizeVpnSettings(value, state.preferences);
  fs.writeFileSync(configPath, JSON.stringify({ ...readConfig(), vpn: state.preferences }));
  state.controller.settings = { ...state.controller.settings, ...state.preferences };
  state.controller.state = state.preferences.enabled ? 'disconnected' : 'disabled';
  state.history.push({ time: Date.now(), action: 'preferences-saved' }); emit(); return { ok: true, state };
});
handler('save-config', (_, value) => {
  const config = { ...readConfig(), ...value };
  if (value.vpn) state.preferences = normalizeVpnSettings(value.vpn, state.preferences);
  fs.writeFileSync(configPath, JSON.stringify(config)); emit(); return true;
});
handler('vpn-command', (_, value) => {
  state.commands = [{ id: 1, action: value.action, preparing: false }];
  state.controller.pendingSwitches = 1;
  state.history.push({ time: Date.now(), action: 'command-queued' }); emit(); return { ok: true, requestId: 1, state };
});
handler('vpn-cancel-command', () => {
  state.commands = []; state.controller.pendingSwitches = 0;
  state.controller.connectionCommandActive = false; state.controller.connectionProgress = null;
  state.controller.lastError = null; state.controller.state = 'attention';
  state.history.push({ time: Date.now(), action: 'command-canceled' }); emit(); return { ok: true, state };
});
handler('qa-vpn-scenario', (_, scenario) => {
  state.serviceError = null;
  if (scenario && typeof scenario === 'object' && ['batchStart', 'progress', 'fileComplete', 'done', 'error', 'vpnState'].includes(scenario.downloadEvent)) {
    notify('dl:' + scenario.downloadEvent, scenario.data);
    if (['done', 'error'].includes(scenario.downloadEvent)) { state.transferring = false; emit(); }
    return true;
  }
  if (scenario === 'downloads-controlled') controlledDownloads = true;
  else if (scenario === 'fixture-accounts') handler('read-accounts-file', () => accountRows);
  else if (scenario === 'fastest-retry') {
    state.commands = [{ id: 1, action: 'connect', preparing: false }];
    state.controller.pendingSwitches = 1;
    state.controller.state = 'switching'; state.controller.connectionCommandActive = true;
    state.controller.connectionRequest = { action: 'connect', target: {}, fastest: false };
    state.controller.connectionProgress = { phase: 'retrying', server: 'DE#2', candidateNumber: 2, maxCandidates: 10,
      attempt: 1, maxAttempts: 1, round: 3, message: 'Proton’s fastest available connection timed out after 10 seconds. Retrying with DE#2 (server 2 of up to 10)…' };
  } else if (scenario === 'fastest-failed') {
    state.commands = [{ id: 1, action: 'connect', preparing: false }]; state.controller.pendingSwitches = 0;
    state.controller.connectionCommandActive = true;
    state.controller.state = 'waiting'; state.controller.status = { state: 'disconnected', server: null };
    state.controller.connectionProgress = { phase: 'waiting', nextRetryAt: Date.now() + 30000,
      message: 'VPN candidates are exhausted for this round. Work is paused; retrying in 30 seconds.' };
    state.controller.lastError = { code: 'CONNECTION_FAILED', message: 'Proton’s CLI connection wait timed out after 10 seconds. Proton reports disconnected.',
      protonSelectedServer: 'KH#3', exitCode: 1, action: 'Work is retained while M3 waits for another connection round.' };
  } else if (scenario === 'checking-status') {
    state.commands = []; state.controller.pendingSwitches = 0; state.controller.connectionCommandActive = false;
    state.controller.state = 'checking'; state.controller.status = { state: 'unknown', server: null };
    state.controller.lastConfirmed = { time: Date.now() - 5000, status: { state: 'connected', server: { id: 'CH#242' } } };
    state.controller.statusUncertainty = { graceUntil: Date.now() + 15000, interrupted: false, nextRetryAt: Date.now() + 5000 };
    state.controller.connectionProgress = { phase: 'checking', reason: 'status-unavailable', nextRetryAt: Date.now() + 5000 };
    state.controller.lastError = { code: 'VPN_STATUS_UNAVAILABLE', message: 'Proton’s VPN status is temporarily unavailable.' };
  } else if (scenario === 'speed-limit') {
    state.commands = []; state.controller.state = 'waiting'; state.controller.connectionCommandActive = true; state.controller.retryWaiting = true;
    state.controller.connectionProgress = { phase: 'waiting', reason: 'speed-switch-limit', nextRetryAt: Date.now() + 60000,
      message: 'Speed recovery is waiting for its configured limit; automatically retrying in 60 seconds.' };
    state.controller.statusUncertainty = null;
  } else if (scenario === 'connected' || scenario === 'browser') {
    state.commands = []; state.controller.pendingSwitches = 0; state.controller.connectionCommandActive = false; state.controller.lastError = null;
    state.controller.connectionProgress = null;
    state.controller.connectionRequest = null; state.controller.statusUncertainty = null; state.controller.retryWaiting = false;
    state.diagnostics = { installed: true, version: '1.0.5', authentication: 'signed-in', ready: true, diagnostics: [] };
    state.preferences.enabled = true; state.preferences.required = false;
    state.controller.settings.enabled = true; state.controller.settings.required = false;
    state.controller.state = 'connected'; state.controller.status = { state: 'connected', server: { id: 'CH#242', location: 'Zurich, Switzerland' } };
    state.controller.activeOperations = scenario === 'browser' ? [{ id: 10, kind: 'browser', resources: [], interrupted: false }] : [];
  } else if (scenario === 'upload-wait') {
    notify('up:status', { file: 'fixture.bin', idx: 1, total: 2 });
    notify('up:progress', { filePct: 25, speed: '500 B/s' });
    notify('up:vpnState', { state: 'deferred', message: 'Slow upload: VPN change after file completion.' });
  } else if (scenario === 'upload-stop') notify('up:complete', null);
  else if (scenario === 'upload-review-allow') global.__rforkRecoveryChoice = 1;
  else if (scenario === 'upload-review-cancel') global.__rforkRecoveryChoice = 0;
  else if (scenario === 'unsupported') state.supported = false;
  else if (scenario === 'malicious') state.serviceError = { code: 'TEST', message: '<img src=x onerror="window.__unsafe=1">' };
  else {
    const issues = { missing: ['CLI_MISSING', 'The Proton VPN CLI was not found.', 'Install the official Proton CLI.'],
      signedout: ['AUTH_REQUIRED', 'Proton VPN is not signed in.', 'Sign in once using protonvpn signin <username>.'],
      gui: ['GUI_CONFLICT', 'The Proton VPN desktop app is running.', 'Close Proton’s GUI before using its CLI through M3.'] };
    const issue = issues[scenario];
    state.diagnostics = { version: scenario === 'missing' ? null : '1.0.5', ready: false, authentication: 'unknown', diagnostics: [{ code: issue[0], message: issue[1], action: issue[2] }] };
  }
  emit(); return true;
});
`);
  // The test preload extends the real allowlisted API with one fixture-only IPC.
  // Install a second, isolated world exposure via a dedicated preload hook.
  const preload = path.join(profile, 'qa-preload.cjs');
  fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
require(${JSON.stringify(path.join(root, 'preload.js'))});
contextBridge.exposeInMainWorld('vpnQa', { scenario: name => ipcRenderer.invoke('qa-vpn-scenario', name), terminalEvents: events => ipcRenderer.invoke('qa-terminal-events', events), clipboard: () => ipcRenderer.invoke('qa-terminal-clipboard') });
`);
  // Patch only the launcher's BrowserWindow options before importing main.js.
  let source = fs.readFileSync(launcher, 'utf8');
  source = source.replace("require(path.join(ROOT, 'main.js'));", `
const electron = require('electron');
const NativeWindow = electron.BrowserWindow;
const fixtureElectron = Object.create(electron);
Object.defineProperty(fixtureElectron, 'BrowserWindow', { value: class extends NativeWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, preload: ${JSON.stringify(preload)}, sandbox: false } }); }
  loadFile(file, options) { return super.loadFile(path.isAbsolute(file) ? file : path.join(ROOT, file), options); }
} });
const Module = require('module');
const originalLoad = Module._load;
let terminalObserver;
Object.defineProperty(fixtureElectron, 'dialog', { value: { ...electron.dialog,
  showMessageBox: async () => ({ response: global.__rforkRecoveryChoice || 0 }),
  showSaveDialog: async () => ({ canceled: false, filePath: path.join(app.getPath('userData'), 'terminal-export.txt') }) } });
Module._load = function(id, ...args) {
  if (id === 'electron') return fixtureElectron;
  const loaded = originalLoad.call(this, id, ...args);
  if (id === './src/protonvpn' || id === './protonvpn') return { ...loaded, createProtonVpn(options = {}) {
    if (options.onTerminalEvent) terminalObserver = options.onTerminalEvent;
    const adapter = loaded.createProtonVpn(options);
    // Test cleanup must never reach the machine's real VPN.
    adapter.shutdown = async () => ({ state: 'disconnected' });
    return adapter;
  } };
  return loaded;
};
ipcMain.handle('qa-terminal-events', (_, events) => { for (const event of events) terminalObserver(event); return true; });
ipcMain.handle('qa-terminal-clipboard', () => electron.clipboard.readText());
require(path.join(ROOT, 'main.js'));`);
  fs.writeFileSync(launcher, source);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', launcher], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser, page, stderr = '', output = '', stage = 'launch';
  const errors = [];
  child.stdout.on('data', data => { output += data; });
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron did not expose a debugging endpoint.')), 20000);
    child.stderr.on('data', data => {
      stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited before UI checks, code ' + code + '\n' + stderr.slice(-2000) + '\n' + output.slice(-1000))); });
    child.once('error', reject);
  });
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint });
    for (let i = 0; i < 100; i++) {
      page = (await browser.pages()).find(candidate => candidate.url().endsWith('/index.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, 'M3 page opened; targets: ' + (await browser.pages()).map(page => page.url()).join(', ') + '\n' + stderr.slice(-1800));
    page.on('pageerror', error => errors.push(error.message));
    stage = 'initial panel';
    await page.waitForFunction(() => window.vpnQa && document.getElementById('vpn-settings-card').hidden === false);
    const scenario = name => page.evaluate(name => window.vpnQa.scenario(name), name);
    assert.equal(await page.$eval('#statusText', element => element.textContent), 'Downloads: idle');
    stage = 'rfork labels and saved provider orders';
    assert.equal(fs.statSync(rforkLicense).mode & 0o777, licenseMode, 'startup leaves rfork notices permissions unchanged');
    await page.waitForFunction(() => document.querySelector('#up-uploadChips .up-tool-chip')?.textContent.includes('rfork'));
    const readToolOrder = id => page.$$eval('#' + id + ' .tool-order-item', items => items.map(item => item.dataset.tool));
    assert.deepEqual(await readToolOrder('toolOrder-upload'), ['rclone', 'megacmd', 'megatools']);
    assert.deepEqual(await readToolOrder('toolOrder-refresh'), ['megacmd', 'rclone', 'megatools']);
    assert.deepEqual(await readToolOrder('toolOrder-view'), ['rclone', 'megatools', 'megacmd']);
    assert.deepEqual(await page.$$eval('[data-tool="rclone"] .tool-order-name', items => items.map(item => item.textContent)), ['rfork', 'rfork', 'rfork']);
    assert.match(await page.$eval('#up-uploadChips .up-tool-chip', item => item.title), /rfork/);
    await page.$eval('#up-uploadForceChk', item => { item.checked = true; item.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.$eval('#up-uploadChips .force-active', item => item.textContent), 'rfork');
    assert.match(await page.$eval('#up-uploadChips .force-active', item => item.title), /rfork.*forced/);
    await page.$eval('#up-uploadForceChk', item => { item.checked = false; item.dispatchEvent(new Event('change', { bubbles: true })); });
    stage = 'rfork interrupted upload review';
    const journalPath = path.join(dataDir, 'upload-recovery.json');
    fs.writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, entries: [{ id: 'fixture-review', account: 'review@example.test', destination: 'folder/interrupted.bin', source: '/fixture/interrupted.bin', state: 'uncertain' }] }));
    assert.equal((await page.evaluate(() => window.api.reviewUploadRecovery())).ok, false);
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries.length, 1);
    await scenario('upload-review-allow');
    assert.equal((await page.evaluate(() => window.api.reviewUploadRecovery())).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, 'utf8')).entries, []);
    await scenario('upload-review-cancel');
    stage = 'CSV account refresh reminder';
    await page.waitForFunction(() => document.getElementById('healthText').textContent === 'No accounts');
    const accountCsv = path.join(dataDir, 'account_log.csv');
    const accountHeader = 'Email,Password,Used,Created,Last Login,Status,Security\n';
    const excludedAccounts = 'suspended@example.test,fixture-only,0,2020-01-01,,Suspended,No\n' +
      'terminated@example.test,fixture-only,0,2020-01-01,,Terminated,No\n' +
      'quota@example.test,fixture-only,0,2020-01-01,,Over Quota,No\n';
    fs.writeFileSync(accountCsv, accountHeader + excludedAccounts +
      'old@example.test,fixture-only,0,2020-01-01,2021-01-01,Active,No\n' +
      'blank@example.test,fixture-only,0,2020-01-01,,,No\n' +
      'unknown@example.test,fixture-only,0,2020-01-01,,Unknown,No\n');
    await page.evaluate(() => updateHealthPill());
    assert.equal(await page.$eval('#healthText', element => element.textContent), 'Refresh needed: 3');
    assert.equal(await page.$eval('#healthPill', element => element.classList.contains('health-refresh')), true);
    assert.match(await page.$eval('#healthPill', element => element.title), /Refresh threshold: 90 days/);
    await page.waitForFunction(() => {
      const element = document.querySelector('#healthPill .pill-dot');
      const probe = document.createElement('span'); probe.style.color = 'var(--yellow)'; document.body.appendChild(probe);
      const amber = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(element).backgroundColor === amber;
    });
    await page.focus('#healthPill'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('uploadPanel').classList.contains('hidden') &&
      document.getElementById('up-accountsPanel').style.display !== 'none');
    await page.waitForFunction(() => document.querySelectorAll('#up-accountsList .up-acc-status').length === 6);
    const accountBadges = await page.$$eval('#up-accountsList .up-acc-status', elements => elements.map(element => element.textContent));
    assert.equal(accountBadges.filter(status => status === 'Dormant').length, 1);
    assert.equal(accountBadges.filter(status => status === 'Unknown').length, 2);
    assert.equal(await page.evaluate(async () => (await window.api.readAccountsFile()).filter(account => account.needsRefresh).length), 3);
    for (const width of [1200, 900]) {
      await page.setViewport({ width, height: 900 });
      assert.equal(await page.$eval('#healthPill', element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth;
      }), true);
    }
    await page.screenshot({ path: '/tmp/m3-account-refresh-reminder.png' });
    fs.writeFileSync(accountCsv, accountHeader + excludedAccounts);
    await page.evaluate(() => updateHealthPill());
    assert.equal(await page.$eval('#healthText', element => element.textContent), 'Up to date');
    assert.equal(await page.$eval('#healthPill', element => element.classList.contains('health-active')), true);
    fs.writeFileSync(accountCsv, accountHeader);
    await page.evaluate(() => updateHealthPill());
    assert.equal(await page.$eval('#healthText', element => element.textContent), 'No accounts');
    assert.equal(await page.$eval('#healthPill', element => element.className), 'status-pill');
    await page.setViewport({ width: 1200, height: 900 });
    await scenario('fixture-accounts');
    stage = 'global terminal viewer';
    const terminalEvents = events => page.evaluate(events => window.vpnQa.terminalEvents(events), events);
    const rawOutput = '  Traceback (most recent call last):\n\t<img src=x onerror="window.__unsafe=1"> Résumé 雨\n\x1b[31mraw stderr\x1b[0m\n';
    const initialEvent = { time: Date.now(), commandId: 401 };
    await terminalEvents([{ ...initialEvent, kind: 'cmd', text: 'protonvpn status', phase: 'start', deadlineMs: 15000 },
      { ...initialEvent, kind: 'stderr', text: rawOutput }]);
    for (const tab of ['download', 'upload', 'settings']) {
      await page.click('.tab[data-tab="' + tab + '"]');
      await page.focus('#vpn-status-pill'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('vpn-terminal').open);
      assert.equal(await page.$eval('.tab.active', element => element.dataset.tab), tab);
      await page.waitForFunction(() => document.getElementById('vpn-terminal-output').textContent.includes('Résumé 雨'));
      assert.equal(await page.$eval('#vpn-terminal-output', element => element.querySelectorAll('img').length), 0);
      assert.equal(await page.evaluate(() => window.__unsafe), undefined);
      assert.equal(await page.$eval('#vpn-terminal-output', element => element.textContent.includes('\x1b')), false);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'vpn-status-pill');
    }
    await page.$eval('#vpn-settings-card', element => element.scrollIntoView({ block: 'start' }));
    await page.click('#vpn-open-terminal'); await page.keyboard.press('Escape');
    await page.select('#vpn-pool-mode', 'mixed');
    await page.type('#vpn-countries', 'Draft country');
    const settingsScroll = await page.$eval('#settingsPanel', element => element.scrollTop);
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-copy');
    await page.waitForFunction(() => document.getElementById('vpn-terminal-feedback').textContent.includes('copied'));
    assert.ok((await page.evaluate(() => window.vpnQa.clipboard())).includes(rawOutput));
    await page.click('#vpn-terminal-save');
    await page.waitForFunction(() => document.getElementById('vpn-terminal-feedback').textContent.includes('saved'));
    assert.ok(fs.readFileSync(path.join(profile, 'terminal-export.txt'), 'utf8').includes(rawOutput));
    await page.click('#vpn-terminal-follow');
    await terminalEvents([{ time: Date.now(), commandId: 401, kind: 'stdout', text: 'Output while reading older lines\n' }]);
    await page.waitForFunction(() => document.getElementById('vpn-terminal-output').textContent.includes('Output while reading'));
    assert.equal(await page.$eval('#vpn-terminal-follow', element => element.checked), false);
    await page.click('#vpn-terminal-close');
    assert.equal(await page.$eval('#vpn-countries', element => element.value), 'Draft country');
    assert.equal(await page.$eval('#settingsPanel', element => element.scrollTop), settingsScroll);
    await terminalEvents([{ time: Date.now(), commandId: 401, kind: 'm3', phase: 'stop', code: 'TIMEOUT', text: 'Deadline exceeded (15000ms)' },
      { time: Date.now(), commandId: 401, kind: 'm3', phase: 'close', text: 'Process closed · exit none · signal SIGTERM' }]);
    await page.click('#vpn-status-pill');
    await page.waitForFunction(() => document.getElementById('vpn-terminal-output').textContent.includes('Deadline exceeded'));
    await page.screenshot({ path: '/tmp/m3-vpn-terminal-output.png' });
    assert.equal(await page.$eval('#vpn-terminal-follow', element => element.checked), false);
    await page.click('#vpn-terminal-latest');
    assert.equal(await page.$eval('#vpn-terminal-follow', element => element.checked), true);
    // Exercise retention and bounded rendering under a burst larger than a full buffer.
    await terminalEvents(Array.from({ length: 5100 }, (_, i) => ({ time: Date.now(), kind: 'm3', text: 'Buffered diagnostic ' + i })));
    await page.waitForFunction(() => document.getElementById('vpn-terminal-output').textContent.includes('Buffered diagnostic 5099'));
    assert.ok(await page.$eval('#vpn-terminal-retention', element => !element.hidden && element.textContent.includes('expired')));
    assert.ok(await page.$$eval('.vpn-terminal-line', elements => elements.length <= 5000));
    await page.$eval('#vpn-terminal-output', element => { element.scrollTop = 0; });
    await page.waitForFunction(() => !document.getElementById('vpn-terminal-follow').checked);
    await page.click('#vpn-terminal-latest');
    for (const size of [{ width: 1200, height: 800 }, { width: 900, height: 580 }]) {
      await page.setViewport(size);
      assert.equal(await page.$eval('#vpn-terminal', element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; }), true);
      assert.equal(await page.$eval('#vpn-terminal', element => { const rect = element.getBoundingClientRect(); return Math.abs((innerWidth - rect.width) / 2 - rect.left) < 2 && Math.abs((innerHeight - rect.height) / 2 - rect.top) < 2; }), true);
      assert.equal(await page.$eval('#vpn-terminal-save', element => { const rect = element.getBoundingClientRect(); return rect.bottom <= innerHeight; }), true);
    }
    await page.screenshot({ path: '/tmp/m3-vpn-terminal-narrow.png' });
    await page.click('#vpn-terminal-settings');
    await page.$eval('#vpn-countries', element => { element.value = ''; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.setViewport({ width: 1200, height: 900 });
    stage = 'setup and policy validation';
    assert.equal(await page.$('#vpn-ip'), null);
    assert.equal(await page.$('#vpn-check-ip'), null);
    assert.equal(await page.$('#vpn-verify-ip'), null);
    assert.equal(await page.evaluate(() => typeof window.api.vpnCheckPublicIp), 'undefined');
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    assert.equal(await page.$eval('#settingsPanel', element => getComputedStyle(element).display !== 'none'), true);
    assert.equal(await page.$eval('#vpn-connect', element => element.disabled), true);
    assert.equal(await page.$eval('#vpn-mode option[value=required]', element => element.disabled), true);
    assert.equal(await page.$eval('#vpn-refresh-mode', element => element.matches(':disabled')), false);
    assert.equal(await page.$eval('#vpn-download-enabled', element => element.matches(':disabled')), false);
    assert.equal(await page.$eval('#vpn-upload-enabled', element => element.matches(':disabled')), false);
    await page.click('#vpn-diagnose');
    await page.waitForFunction(() => document.getElementById('vpn-cli').textContent.includes('signed in'));
    await page.click('#vpn-enabled');
    await page.click('#vpn-save');
    await page.waitForFunction(() => document.getElementById('vpn-error').textContent.includes('Select Manual control'));
    await page.select('#vpn-mode', 'manual');
    stage = 'save settings';
    await page.select('#vpn-pool-mode', 'mixed');
    await page.type('#vpn-servers', 'ch#242, DE#2');
    await page.type('#vpn-countries', 'DE, CH');
    await page.select('#vpn-refresh-mode', 'batch');
    await page.$eval('#vpn-refresh-batch', element => { element.value = '2'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#vpn-download-enabled');
    await page.click('#vpn-upload-enabled');
    await page.$eval('#vpn-upload-speed', element => { element.value = '0.501'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#vpn-download-speed', element => { element.value = '1.001'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#vpn-save');
    await page.waitForFunction(() => document.querySelectorAll('#vpn-target option').length === 6 && !document.getElementById('vpn-connect').disabled);
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'mega-dl-config.json'), 'utf8'));
    assert.equal(saved.vpn.uploadRecoveryEnabled, true); assert.equal(saved.vpn.uploadThresholdBps, 501000);
    assert.equal(saved.omdbApiKey, 'preserved-key'); assert.deepEqual(saved.vpn.serverSelection.servers, ['CH#242', 'DE#2']);
    assert.equal(saved.vpn.refreshMode, 'batch'); assert.equal(saved.vpn.refreshBatchSize, 2);
    assert.equal(saved.vpn.downloadRecoveryEnabled, true); assert.equal(saved.vpn.downloadThresholdBps, 1001000);
    stage = 'reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.vpnQa && document.getElementById('vpn-enabled').checked);
    assert.equal(await page.$eval('#vpn-servers', element => element.value), 'CH#242, DE#2');
    assert.equal(await page.$eval('#vpn-refresh-mode', element => element.value), 'batch');
    assert.equal(await page.$eval('#vpn-download-enabled', element => element.checked), true);
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    stage = 'general settings save';
    await page.type('#vpn-countries', ', NL');
    await page.click('#cfg-save-top');
    await page.waitForFunction(() => document.getElementById('cfg-save-top').textContent.includes('Saved'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'mega-dl-config.json'), 'utf8')).vpn.serverSelection.countries, ['DE', 'CH', 'NL']);
    const savedTools = JSON.parse(fs.readFileSync(path.join(profile, 'mega-dl-config.json'), 'utf8'));
    assert.deepEqual(savedTools.toolOrderUpload, ['rclone', 'megacmd', 'megatools']);
    assert.deepEqual(savedTools.toolOrderRefresh, ['megacmd', 'rclone', 'megatools']);
    assert.deepEqual(savedTools.toolOrderView, ['rclone', 'megatools', 'megacmd']);
    console.log('rfork UI checks passed: visible names, forced selection, and legacy upload/refresh/view orders preserved through save/reload.');
    stage = 'setup errors and queued command';
    for (const [name, text] of [['missing', 'not found'], ['signedout', 'not signed in'], ['gui', 'desktop app is running']]) {
      await scenario(name);
      await page.waitForFunction(text => document.getElementById('vpn-setup-message').textContent.includes(text), {}, text);
      assert.ok(await page.$eval('#vpn-setup-message', element => element.textContent.length > 30));
    }
    await scenario('browser'); await page.click('#vpn-connect');
    await page.waitForFunction(() => document.getElementById('vpn-waiting').textContent.includes('MEGA browser'));
    assert.equal(await page.$eval('#vpn-connect', element => element.disabled), true);
    await page.click('#vpn-cancel');
    await page.waitForFunction(() => document.getElementById('vpn-cancel').hidden);
    await scenario('connected');
    stage = 'fastest retry and error details';
    await scenario('fastest-retry');
    await page.waitForFunction(() => document.getElementById('vpn-waiting').textContent.includes('Retrying with DE#2 (server 2 of up to 10)'));
    assert.match(await page.$eval('#vpn-recovery-command', element => element.textContent), /protonvpn connect.*DE#2/);
    assert.match(await page.$eval('#vpn-recovery-candidate', element => element.textContent), /Candidate 2 of up to 10.*attempt 1 of 1.*round 3/);
    await scenario('fastest-failed');
    await page.waitForFunction(() => document.getElementById('vpn-error').textContent.includes('CLI-selected server: KH#3'));
    const failureText = await page.$eval('#vpn-error', element => element.textContent);
    assert.ok(failureText.includes('timed out after 10 seconds'));
    assert.ok(failureText.includes('Proton reports disconnected'));
    assert.ok(!failureText.includes('Choose another server'));
    assert.equal(await page.$eval('#vpn-state', element => element.textContent), 'Waiting to retry');
    assert.equal(await page.$eval('#vpn-waiting', element => !element.hidden && element.textContent.includes('retrying automatically')), true);
    assert.equal(await page.$eval('#vpn-connect', element => element.disabled), true);
    assert.equal(await page.$eval('#vpn-cancel', element => !element.hidden && !element.disabled), true);
    await page.screenshot({ path: '/tmp/m3-vpn-fastest-error.png' });
    stage = 'status uncertainty and automatic countdown';
    await scenario('checking-status');
    await page.waitForFunction(() => document.getElementById('vpn-state').textContent === 'Checking status');
    assert.equal(await page.$eval('#vpn-waiting', element => element.hidden), false);
    assert.match(await page.$eval('#vpn-recovery-last', element => element.textContent), /Connected to CH#242/);
    assert.match(await page.$eval('#vpn-recovery-status', element => element.textContent), /Temporarily unavailable/);
    assert.match(await page.$eval('#vpn-recovery-grace', element => element.textContent), /Existing work continues/);
    assert.ok(!await page.$eval('#vpn-waiting', element => element.textContent.includes('disconnected')));
    const countdown = await page.$eval('#vpn-recovery-next', element => element.textContent);
    await page.focus('#vpn-target');
    await page.waitForFunction(before => document.getElementById('vpn-recovery-next').textContent !== before, {}, countdown);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'vpn-target');
    await scenario('speed-limit');
    await page.waitForFunction(() => !document.getElementById('vpn-held-actions').hidden);
    assert.equal(await page.$eval('#vpn-retry', element => element.disabled), true);
    assert.equal(await page.$eval('#vpn-cancel', element => element.hidden || element.disabled), false);
    assert.match(await page.$eval('#vpn-recovery-reason', element => element.textContent), /speed-switch cooldown/);
    await scenario('connected');
    stage = 'status and layout';
    await page.setViewport({ width: 1200, height: 1000 });
    await page.$eval('#vpn-settings-card', element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: '/tmp/m3-vpn-phase3-panel.png' });
    await page.$eval('#vpn-save', element => element.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: '/tmp/m3-vpn-phase3-policies.png' });
    await page.setViewport({ width: 900, height: 800 });
    await page.$eval('#vpn-settings-card', element => element.scrollIntoView({ block: 'start' }));
    for (const selector of ['#vpn-settings-card', '.header']) {
      const dimensions = await page.$eval(selector, element => ({ content: element.scrollWidth, available: element.clientWidth }));
      assert.ok(dimensions.content <= dimensions.available + 1, selector + ' overflow: ' + JSON.stringify(dimensions));
    }
    await page.screenshot({ path: '/tmp/m3-vpn-phase3-narrow.png' });
    stage = 'account refresh cancellation';
    await page.click('.tab[data-tab="upload"]'); await page.click('#up-tabAccounts');
    await page.waitForSelector('#up-accountsList .acc-row-refresh');
    await page.click('#btn-refreshAll');
    await page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.includes('Waiting for VPN rotation'));
    assert.equal(await page.$eval('#btn-cancelRefresh', element => element.hidden), false);
    await page.screenshot({ path: '/tmp/m3-vpn-phase4-refresh.png' });
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    assert.equal(await page.$eval('#vpn-refresh-mode', element => element.matches(':disabled')), true);
    await page.click('.tab[data-tab="upload"]');
    await page.click('#btn-cancelRefresh');
    await page.waitForFunction(() => document.getElementById('acc-refreshStatus').textContent.includes('completed results saved'));
    await page.waitForFunction(() => !document.getElementById('btn-refreshAll').disabled);
    await page.click('#up-accountsList .acc-row-refresh');
    await page.waitForFunction(() => [...document.querySelectorAll('#up-accountsList button')].some(button => button.textContent === 'Cancel refresh' && !button.hidden));
    await page.evaluate(() => [...document.querySelectorAll('#up-accountsList button')].find(button => button.textContent === 'Cancel refresh' && !button.hidden).click());
    await page.waitForFunction(() => document.querySelector('.acc-single-refresh-log').textContent.includes('canceled'));
    assert.equal(await page.$eval('#up-accountsList .up-acc-status', element => element.textContent), 'Active');
    stage = 'upload boundary recovery UI';
    await scenario('upload-wait');
    await page.waitForFunction(() => document.getElementById('up-statSpeed').textContent === 'VPN switch after file');
    await scenario('upload-stop');
    assert.notEqual(await page.$eval('#up-progPct', element => element.textContent), '100%');
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    stage = 'download recovery UI';
    await page.click('.tab[data-tab="download"]');
    await page.type('#bulkTextarea', 'https://mega.nz/file/TESTTEST#' + 'A'.repeat(43));
    await page.click('#addBulkBtn'); await page.click('#startBtn');
    await page.waitForFunction(() => document.getElementById('statusText').textContent === 'Downloads: VPN wait');
    assert.equal(await page.$eval('#dlLqList', element => element.textContent.includes('VPN recovery waiting for: upload')), true);
    assert.equal(await page.$eval('#stopBtn', element => element.disabled), false);
    await page.screenshot({ path: '/tmp/m3-vpn-phase5-download.png' });
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    assert.equal(await page.$eval('#vpn-download-enabled', element => element.matches(':disabled')), true);
    assert.equal(await page.$eval('#vpn-upload-enabled', element => element.matches(':disabled')), true);
    await page.click('.tab[data-tab="download"]'); await page.click('#stopBtn');
    await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
    stage = 'download status messages and run progress';
    await scenario('downloads-controlled');
    const downloadEvent = (downloadEvent, data) => scenario({ downloadEvent, data });
    const expectDownloadStatus = async text => {
      await page.waitForFunction(text => document.getElementById('statusText').textContent === text, {}, text);
    };
    const startDownloads = async count => {
      await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
      await page.evaluate(count => {
        for (let i = 0; i < count; i++) addToQueue('https://mega.nz/file/TESTTEST#' + 'A'.repeat(43), outDirInput.value, '');
        startBtn.click();
      }, count);
    };
    const progress = async (bytes = 420, fileName = 'example.bin') => {
      await downloadEvent('batchStart', { totalFiles: 1, totalBytes: 1000 });
      await downloadEvent('progress', { fileName, fileSize: 1000, receivedBytes: bytes, chunk: 1, totalChunks: 1 });
    };
    const finish = async (data = {}) => downloadEvent('done', { duration: 1000, totalFiles: 1, failedFiles: 0, ...data });
    await startDownloads(1); await progress();
    await expectDownloadStatus('Downloads: 42%');
    assert.match(await page.$eval('#statusPill', element => element.title), /example.bin \(42%\)/);
    await page.click('#dl-tabMediaInfoChecker');
    await page.click('.tab[data-tab="upload"]');
    await page.focus('#statusPill'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('downloadPanel').classList.contains('hidden') &&
      document.getElementById('dl-dashPanel').style.display !== 'none');
    await downloadEvent('vpnState', { state: 'attention', message: 'Recovery failed. Restore the VPN connection.' });
    await expectDownloadStatus('Downloads: check VPN');
    assert.equal(await page.$eval('#statusPill', element => element.classList.contains('error')), true);
    assert.match(await page.$eval('#statusPill', element => element.title), /Recovery failed/);
    await downloadEvent('vpnState', { state: 'waiting', message: 'Waiting for an upload to release the connection.' });
    await expectDownloadStatus('Downloads: VPN wait');
    assert.equal(await page.$eval('#statusPill', element => element.classList.contains('waiting')), true);
    await downloadEvent('vpnState', { state: 'resuming', message: 'Connection restored.' });
    await expectDownloadStatus('Downloads: 42%');
    await page.click('#stopBtn');
    await expectDownloadStatus('Downloads: stopping');
    // Late progress while the engine shuts down must not look like a resumed run.
    await downloadEvent('progress', { fileName: 'example.bin', fileSize: 1000, receivedBytes: 430, chunk: 1, totalChunks: 1 });
    await expectDownloadStatus('Downloads: stopping');
    // Cancellation itself is not a failure; any actual key/transfer failures
    // already observed remain in failedFiles (covered by the download UI suite).
    await finish({ canceled: true, failedFiles: 0 });
    await expectDownloadStatus('Downloads: stopped');
    assert.equal(await page.$eval('#statusPill', element => element.classList.contains('error')), false);

    await startDownloads(5);
    await expectDownloadStatus('Downloads: 0/5');
    for (let i = 0; i < 2; i++) {
      await progress(1000); await finish();
      await page.waitForFunction(completed => document.getElementById('statusText').textContent === 'Downloads: ' + completed + '/5', {}, i + 1);
      await page.waitForFunction(() => document.querySelector('#dlLqList .lq-active'));
    }
    await page.evaluate(() => addToQueue('https://mega.nz/file/TESTTEST#' + 'B'.repeat(43), outDirInput.value, ''));
    await expectDownloadStatus('Downloads: 2/6');
    await page.evaluate(() => removeQueue(queue.length - 1));
    await expectDownloadStatus('Downloads: 2/5');
    await page.click('#clearDoneBtn');
    await expectDownloadStatus('Downloads: 2/5');
    for (let i = 0; i < 3; i++) {
      await finish(i === 2 ? { failedFiles: 1 } : {});
      if (i < 2) await page.waitForFunction(() => document.querySelector('#dlLqList .lq-active'));
    }
    await expectDownloadStatus('Downloads: 1 failed');
    assert.equal(await page.$eval('#statusPill', element => element.classList.contains('error')), true);
    assert.match(await page.$eval('#statusPill', element => element.title), /4\/5 queued items successfully completed/);

    // A new run excludes the failed/stopped rows retained from earlier runs.
    await startDownloads(1);
    await progress(1000);
    await expectDownloadStatus('Downloads: 99%');
    await downloadEvent('fileComplete', { fileName: 'example.bin', fileSize: 1000, success: true });
    await finish();
    await expectDownloadStatus('Downloads: complete');
    assert.equal(await page.$eval('#statusPill', element => element.classList.contains('done')), true);
    await page.screenshot({ path: '/tmp/m3-download-status-complete.png' });

    await startDownloads(1);
    await downloadEvent('batchStart', { totalFiles: 3, totalBytes: 3000 });
    await downloadEvent('fileComplete', { fileName: 'folder/first.bin', fileSize: 1000, success: true });
    await downloadEvent('progress', { fileName: 'folder/second.bin', fileSize: 1000, receivedBytes: 500, chunk: 1, totalChunks: 1 });
    await expectDownloadStatus('Downloads: 50%');
    assert.match(await page.$eval('#statusPill', element => element.title), /second.bin \(50%\)/);
    await finish({ totalFiles: 3, failedFiles: 2 });
    await expectDownloadStatus('Downloads: 2 failed');

    await startDownloads(1);
    // A verified file already on disk is a success, not an unfinished user skip.
    await downloadEvent('fileComplete', { fileName: 'exists.bin', fileSize: 1000, success: true, skipped: true });
    await finish();
    await expectDownloadStatus('Downloads: complete');
    await startDownloads(1);
    await downloadEvent('fileComplete', { fileName: 'skipped.bin', fileSize: 1000, success: false, skipped: true });
    await finish({ skipped: true });
    await expectDownloadStatus('Downloads: stopped');
    assert.match(await page.$eval('#statusPill', element => element.title), /1 item\(s\) skipped/);
    await startDownloads(1);
    await downloadEvent('error', { message: 'Unable to fetch metadata <img src=x>' });
    await expectDownloadStatus('Downloads: 1 failed');
    assert.match(await page.$eval('#statusPill', element => element.title), /Unable to fetch metadata <img/);
    assert.equal(await page.$eval('#statusPill', element => element.querySelectorAll('img').length), 0);
    await page.setViewport({ width: 900, height: 900 });
    const headerSize = await page.$eval('.header', element => ({ content: element.scrollWidth, available: element.clientWidth }));
    assert.ok(headerSize.content <= headerSize.available + 1, 'download header overflow: ' + JSON.stringify(headerSize));
    await page.screenshot({ path: '/tmp/m3-download-status-failed.png' });
    await page.click('#vpn-status-pill');
    await page.click('#vpn-terminal-settings');
    stage = 'escaping';
    await scenario('malicious');
    await page.waitForFunction(() => document.getElementById('vpn-error').textContent.includes('<img'));
    assert.equal(await page.$eval('#vpn-error', element => element.querySelectorAll('img').length), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    stage = 'unsupported platform';
    await scenario('unsupported');
    await page.waitForFunction(() => document.getElementById('vpn-settings-card').hidden);
    assert.equal(await page.$eval('#vpn-settings-card', element => element.hidden), true);
    assert.equal(await page.$eval('#vpn-status-pill', element => element.hidden), true);
    assert.deepEqual(errors, []);
    console.log('Electron VPN UI checks passed: global terminal on all pages, raw copy/save, timeout/closed capture, draft/focus preservation, follow output, retention/5100-event burst, centered 1200/900px dialog; download status labels/progress/current-run counts/failures/stop/skips/keyboard navigation, CSV refresh reminder states/count/amber tooltip/keyboard navigation/layout, startup, rotation/download/upload settings, validation, persistence/reload/general save, setup errors, queue/cancel, 1200/900px layout, batch/row cancellation, retained badge, download waiting/Stop/busy controls, upload deferred/stopped status, escaping, unsupported platform.');
    console.log('Screenshots: /tmp/m3-vpn-phase3-panel.png, /tmp/m3-vpn-phase3-policies.png, /tmp/m3-vpn-phase3-narrow.png');
  } catch (error) {
    console.error('UI stage: ' + stage + '; renderer errors: ' + errors.join('; '));
    if (page) {
      console.error(JSON.stringify(await page.evaluate(() => ({ api: Object.keys(window.api || {}), fixture: Boolean(window.vpnQa),
        error: document.getElementById('vpn-error')?.textContent, panelHidden: document.getElementById('vpn-settings-card')?.hidden,
        cli: document.getElementById('vpn-cli')?.textContent, state: document.getElementById('vpn-state')?.textContent }))));
      await page.screenshot({ path: '/tmp/m3-vpn-phase3-debug.png' });
    }
    console.error(stderr.slice(-1200));
    throw error;
  } finally {
    browser?.disconnect(); child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
