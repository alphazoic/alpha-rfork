'use strict';
// Real Electron close/quit/signal lifecycle and real Proton adapter, with pipe
// fixtures instead of any installed Proton executable or live connection.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '..');
const help = 'Usage: protonvpn [OPTIONS] COMMAND [ARGS]...\nProton VPN command-line interface for Linux. 1.0.5\nCommands:\n  connect     Connect\n  disconnect  Disconnect\n  status      Status\n';
const connectHelp = 'Usage: protonvpn connect [OPTIONS] [SERVER_NAME]\nOptions:\n  --country TEXT\n  --city TEXT\n  --random\n';

async function scenario(mode) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-quit-ui-'));
  const data = path.join(profile, 'data'); fs.mkdirSync(data);
  const log = path.join(profile, 'lifecycle.json');
  fs.writeFileSync(path.join(profile, 'mega-dl-config.json'), JSON.stringify({ dataDir: data, defaultOutputDir: data,
    proxy: 'https://unused.invalid', vpn: { enabled: mode === 'connect', required: false } }));
  const preload = path.join(profile, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'preload.js'))});
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quitQa', { quit: () => ipcRenderer.invoke('qa-quit') });`);
  const launcher = path.join(profile, 'launcher.cjs');
  fs.writeFileSync(launcher, `
const electron = require('electron'), { app, ipcMain, Menu } = electron;
const fs = require('fs'), path = require('path'), { EventEmitter } = require('events'), { PassThrough } = require('stream');
const ROOT = ${JSON.stringify(root)}, MODE = ${JSON.stringify(mode)}, LOG = ${JSON.stringify(log)};
app.setPath('userData', ${JSON.stringify(profile)});
Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'File',submenu:[]},{label:'Help',submenu:[]}]));
global.fetch = async () => ({ ok: false });
let state = 'connected', disconnects = 0, connectActive = false;
const events = [];
function record(event) { events.push({ event, state, connectActive }); fs.writeFileSync(LOG, JSON.stringify(events)); }
const moduleProton = require(path.join(ROOT, 'src/protonvpn')), originalFactory = moduleProton.createProtonVpn;
moduleProton.createProtonVpn = options => originalFactory({ ...options, platform: 'linux', env: {}, spawn(_command, args) {
  const child = new EventEmitter(); child.pid = 42; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let closed = false;
  function close(code, signal) { if (closed) return; closed = true; if (args[0] === 'connect' && !args.includes('--help')) { connectActive = false; record('connect-closed'); } child.emit('close', code, signal); }
  child.kill = signal => { queueMicrotask(() => close(null, signal)); return true; };
  queueMicrotask(() => {
    if (args.includes('--help')) { child.stdout.write(args[0] === 'connect' ? ${JSON.stringify(connectHelp)} : ${JSON.stringify(help)}); close(0); }
    else if (args[0] === 'status') { child.stdout.write(state === 'connected' ? 'Status: Connected\\nServer: CH#1 in Zurich, Switzerland\\n' : 'Status: Disconnected\\n'); record('status-' + state); close(0); }
    else if (args[0] === 'connect') { connectActive = true; record('connect-start'); }
    else if (args[0] === 'disconnect') {
      record('disconnect-start'); disconnects++;
      setTimeout(() => {
        if (MODE === 'retry' && disconnects === 1) { child.stderr.write('Error: Proton VPN desktop app is currently running'); close(1); }
        else { state = 'disconnected'; record('disconnect-complete'); child.stdout.write('Disconnected.'); close(0); }
      }, 250);
    } else throw new Error('Unexpected fixture CLI command');
  });
  return child;
} });
const NativeWindow = electron.BrowserWindow, fixture = Object.create(electron);
let windowRef;
Object.defineProperty(fixture, 'BrowserWindow', { value: class extends NativeWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, preload: ${JSON.stringify(preload)}, sandbox: false } }); windowRef = this; }
  loadFile(file, options) { return super.loadFile(path.isAbsolute(file) ? file : path.join(ROOT, file), options); }
} });
Object.defineProperty(fixture, 'dialog', { value: { ...electron.dialog, showMessageBox: async () => { record('visible-failure'); return {response:1}; } } });
const Module = require('module'), originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'electron' ? fixture : originalLoad.call(this, id, ...args); };
ipcMain.handle('qa-quit', () => { if (MODE === 'connect') app.quit(); else windowRef.close(); return true; });
app.on('will-quit', () => record('exit'));
require(path.join(ROOT, 'main.js'));
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['--no-sandbox', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', launcher], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', browser;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No Electron endpoint: ' + stderr)), 20000);
    child.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Premature Electron exit ' + code + ': ' + stderr)); });
  });
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint });
    let page;
    for (let i = 0; i < 100; i++) { page = (await browser.pages()).find(p => p.url().endsWith('/index.html')); if (page) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(page); await page.waitForFunction(() => window.quitQa && window.api);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    if (mode === 'connect') {
      await page.evaluate(() => window.api.vpnCommand({ action: 'connect', target: { server: 'DE#2' } }));
      await page.waitForFunction(() => document.getElementById('vpn-state').textContent.includes('Connecting') || document.getElementById('vpn-state').textContent.includes('Switching'));
      for (let i = 0; i < 100 && (!fs.existsSync(log) || !JSON.parse(fs.readFileSync(log)).some(e => e.event === 'connect-start')); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(JSON.parse(fs.readFileSync(log)).some(e => e.event === 'connect-start'));
    }
    if (mode === 'signal') child.kill('SIGTERM'); else await page.evaluate(() => window.quitQa.quit());
    await page.waitForFunction(() => document.getElementById('app-shutdown').open);
    if (mode === 'retry') {
      await page.waitForFunction(() => !document.getElementById('app-shutdown-retry').hidden);
      assert.equal(child.exitCode, null);
      assert.ok(JSON.parse(fs.readFileSync(log)).some(e => e.event === 'visible-failure'));
      await page.click('#app-shutdown-terminal');
      await page.waitForFunction(() => document.getElementById('vpn-terminal').open);
      await page.keyboard.press('Escape'); await page.click('#app-shutdown-retry');
    }
    const result = await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Shutdown stalled: ' + stderr.slice(-1000))), 15000); timer.unref(); })]);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    const events = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(events.at(-1).event, 'exit'); assert.equal(events.at(-1).state, 'disconnected');
    assert.equal(events.at(-1).connectActive, false);
    assert.equal(events.filter(e => e.event === 'disconnect-start').length, mode === 'retry' ? 2 : 1);
    const lastDisconnect = events.findLastIndex(e => e.event === 'disconnect-complete');
    assert.ok(events.slice(lastDisconnect + 1).some(e => e.event === 'status-disconnected'));
    assert.ok(events.filter(e => e.event === 'disconnect-start').every(e => !e.connectActive));
    assert.deepEqual(errors, []);
    console.log('Electron VPN shutdown passed: ' + mode);
  } finally {
    browser?.disconnect();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit; fs.rmSync(profile, { recursive: true, force: true });
  }
}
(async () => { for (const mode of ['window', 'connect', 'retry', 'signal']) await scenario(mode); })().catch(error => { console.error(error); process.exitCode = 1; });
