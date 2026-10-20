'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createVpnController } = require('./vpn-controller');
const { createNetworkOperations } = require('./network-operations');

function load(filename, mocks) {
  const module = { exports: {} };
  const absolute = path.resolve(__dirname, filename);
  const customRequire = id => Object.hasOwn(mocks, id) ? mocks[id]
    : id.startsWith('.') ? require(path.resolve(path.dirname(absolute), id)) : require(id);
  const evaluate = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${fs.readFileSync(absolute, 'utf8')}\n})`, { filename: absolute });
  evaluate(customRequire, module, module.exports, path.dirname(absolute), absolute);
  return module.exports;
}
function fixture(t, { protection = false, puppeteer, spawn } = {}) {
  const calls = [];
  const controller = createVpnController({ adapter: {
    async getStatus() { return { state: 'connected', server: { id: 'CH#1' } }; },
    async connect() { calls.push('connect'); },
  }, verifyProtection: async () => protection ? { verified: true, startup: true, switching: true, tunnelLoss: true } : null,
 });
  t.after(() => controller.dispose());
  const network = createNetworkOperations(controller, { spawn });
  const writes = [];
  const mocks = {
    './network-operations': network,
    './config': { loadConfig: () => ({}), getAccountCsv: () => 'account.csv' },
    './megacmd': {}, './rclone': {}, './account-creator': {}, './account-manager': {}, './account-usage': {},
    '../binPath': { getBinPath: name => name },
    fs: { existsSync: () => false, writeFileSync: (...args) => writes.push(args), appendFileSync: (...args) => writes.push(args) },
    ...(puppeteer ? { puppeteer } : {}),
  };
  return { controller, network, calls, writes, mocks };
}

test('actual account refresh entry points fail before probes/CSV writes when protection is unavailable', async t => {
  const { controller, mocks, writes } = fixture(t);
  mocks.fs.existsSync = () => true;
  mocks.fs.readFileSync = () => 'Email,Password,Used,Created,Login,Status,Security\naccount@example.test,secret,0,,,Active,No\n';
  const accounts = load('account-manager.js', mocks); await controller.configure({ enabled: true });
  const events = [], send = (channel, data) => events.push({ channel, data });
  await accounts.refreshAccounts('all', send);
  await accounts.refreshSingleAccount('account@example.test', 'secret', send);
  await accounts.upgradeAllInsecure(send);
  assert.equal(writes.length, 0);
  const done = events.filter(event => event.channel.endsWith('Done'));
  assert.equal(done.length, 3);
  assert.ok(done.every(event => event.data.error.includes('VPN-required mode')));
  assert.equal(done[1].data.status, undefined);
  assert.ok(!JSON.stringify(events).includes('secret'));
});

test('actual queued upload cancel prevents startup and duplicate queued starts are ignored', async t => {
  const { controller, network, mocks } = fixture(t);
  const upload = load('upload-engine.js', mocks);
  const lease = await controller.acquire({ kind: 'account-refresh', resources: ['megacmd-session'] });
  const events = [], send = (channel, data) => events.push({ channel, data });
  const work = upload.startUpload({ queue: ['/tmp/not-read'] }, send);
  await upload.startUpload({ queue: ['/tmp/also-not-read'] }, send);
  assert.equal(controller.snapshot().waitingOperations.length, 1);
  upload.cancelCurrentFile(); await work; lease.release();
  assert.equal(network.hasTask('upload'), false);
  assert.deepEqual(events.map(event => event.channel), ['up:log', 'up:complete']);
  assert.match(events[0].data, /canceled/);
});

test('actual downloader Skip while waiting removes work without resetting its cancellation', async t => {
  const { controller, mocks } = fixture(t, { protection: true });
  // Waiting is caused by the switch barrier, with no active download entered.
  await controller.configure({ enabled: true });
  const holding = await controller.acquire();
  const switching = controller.requestSwitch();
  const downloader = load('downloader.js', mocks);
  const done = [];
  const work = downloader.startDownload({ url: 'not-a-link' }, { onLog() {}, onDone: data => done.push(data), onError: error => { throw error; } });
  downloader.skipCurrentDownload(); await work;
  holding.release(); await switching;
  assert.equal(done.length, 1); assert.equal(done[0].skipped, true); assert.equal(done[0].canceled, false);
  assert.equal(controller.snapshot().waitingOperations.length, 0);
});

test('manual browser holds the actual lease after Ready until it disconnects', async t => {
  const browser = new EventEmitter(); browser.pages = async () => [{ on() {}, goto: async () => {} }];
  browser.close = async () => { browser.emit('disconnected'); };
  const { controller, mocks, calls } = fixture(t, { protection: true, puppeteer: { launch: async () => browser } });
  const browserModule = load('browser-upload.js', mocks);
  await controller.configure({ enabled: true });
  const events = [];
  await browserModule.openMegaBrowser('', '', channel => events.push(channel));
  assert.ok(events.includes('up:browserReady'));
  assert.equal(controller.snapshot().activeOperations[0].kind, 'browser');
  const switching = controller.requestSwitch();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, []);
  await browserModule.closeMegaBrowser(); await switching;
  assert.equal(controller.snapshot().activeOperations.length, 0); assert.deepEqual(calls, ['connect']);
});

test('manual browser waiting to open is cancelable and never launches later', async t => {
  let launched = false;
  const { controller, mocks } = fixture(t, { protection: true, puppeteer: { launch: async () => { launched = true; } } });
  const browserModule = load('browser-upload.js', mocks); await controller.configure({ enabled: true });
  const holding = await controller.acquire();
  const switching = controller.requestSwitch();
  const opened = browserModule.openMegaBrowser('', '', () => {});
  const rejected = assert.rejects(opened, error => error.code === 'CANCELED');
  await browserModule.closeMegaBrowser(); await rejected;
  holding.release(); await switching; assert.equal(launched, false);
});

test('actual folder metadata flow uses tracked HTTP and releases its lease on disabled integration', async t => {
  const { controller, mocks } = fixture(t);
  let requestCount = 0;
  mocks.https = { request(_options, callback) {
    const request = new EventEmitter(); request.setTimeout = () => {}; request.write = () => {};
    request.destroy = () => request.emit('close');
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); callback(response);
      response.emit('data', Buffer.from('[{"f":[]}]')); response.emit('end'); request.emit('close');
    });
    requestCount++; return request;
  } };
  const folder = load('folder-browser.js', mocks);
  const result = await folder.fetchFolderTree('https://mega.nz/folder/abcdefgh#AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(requestCount, 1); assert.equal(result.files.length, 0);
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('actual successful account probe still updates account data with integration disabled', async t => {
  const { controller, network, mocks, writes, calls } = fixture(t);
  const original = 'Email Address,Password,Bandwidth Used (GB),Date Created,Last Login Date,Account Status,Security Upgrade\naccount@example.test,secret,0,2026-01-01,,Active,No\n';
  mocks.fs.existsSync = () => true; mocks.fs.readFileSync = () => original;
  mocks['./proc-utils'] = { runCommandWithTimeout: async (_cmd, args) => {
    network.checkpoint('megacmd-session'); return args[0] === 'df' ? 'Used: 128' : 'Root';
  } };
  const accounts = load('account-manager.js', mocks);
  const events = [];
  await accounts.refreshSingleAccount('account@example.test', 'secret', (channel, data) => events.push({ channel, data }));
  assert.equal(writes.length, 1); assert.match(writes[0][1], /,Active,No/);
  assert.equal(events[0].data.status, 'Active');
  assert.equal(controller.snapshot().activeOperations.length, 0); assert.deepEqual(calls, []);
});

test('tunnel loss during an actual account probe cannot mark the account terminated', async t => {
  const { controller, network, mocks, writes } = fixture(t, { protection: true });
  let started, complete;
  const entered = new Promise(resolve => { started = resolve; });
  const probe = new Promise(resolve => { complete = resolve; });
  mocks['./proc-utils'] = { runCommandWithTimeout: async () => { started(); await probe; network.checkpoint(); return 'Root'; } };
  const accounts = load('account-manager.js', mocks); await controller.configure({ enabled: true });
  const events = [];
  const work = accounts.refreshSingleAccount('account@example.test', 'secret', (channel, data) => events.push({ channel, data }));
  await entered; controller.reportTunnelLoss(); complete(); await work;
  assert.equal(writes.length, 0); assert.equal(events[0].data.status, undefined);
  assert.match(events[0].data.error, /Proton reports disconnected/);
});

test('main startup is inert and folder-link workflows own the full MEGAcmd session', async t => {
  const { controller, network, calls } = fixture(t);
  const handlers = new Map(), app = new EventEmitter(), accountCommands = [];
  app.whenReady = () => ({ then() {} });
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback), on() {} };
  const mega = {
    megaSwitch: async () => { network.checkpoint('megacmd-session'); accountCommands.push('login'); },
    megaLogout: async () => { network.checkpoint('megacmd-session'); accountCommands.push('logout'); },
    findFileInCloud: async () => { network.checkpoint('megacmd-session'); return '/folder/file'; },
    getMegacmdFolderLink: async () => { network.checkpoint('megacmd-session'); return 'https://mega.nz/folder/id#key'; },
  };
  const mocks = {
    electron: { app, ipcMain }, fs: { existsSync: () => false }, './binPath': {},
    './src/network-operations': { ...network, installNetworkOperations() {} },
    './src/vpn-controller': { createVpnController: () => controller },
    './src/megacmd': mega, './src/config': { loadConfig: () => ({}),
      getFileCsv: () => 'files.csv', getImportCsv: () => 'imports.csv', getAccountCsv: () => 'accounts.csv' },
  };
  for (const name of ['folder-browser', 'downloader', 'mediainfo-checker', 'utils', 'browser-upload', 'account-manager', 'account-creator', 'upload-engine', 'import-engine', 'bulk-import-engine']) {
    mocks['./src/' + name] = {};
  }
  mocks['./src/account-manager'].installRefreshVpn = () => {};
  mocks['./src/account-creator'].installCloudflareSignupMail = () => {};
  mocks['./src/downloader'].installDownloadVpn = () => {};
  mocks['./src/upload-engine'].installUploadVpn = () => {};
  load('../main.js', mocks);
  assert.deepEqual(calls, []);
  for (const name of ['generate-folder-link', 'generate-import-folder-link']) {
    const result = await handlers.get(name)(null, { name: 'file', email: 'account@example.test', password: 'secret' });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(accountCommands, ['login', 'logout', 'login', 'logout']);
  assert.equal(controller.snapshot().activeOperations.length, 0);
  assert.deepEqual(calls, []);
});

test('cancellation of a MEGAcmd health probe cannot launch the persistent server', async t => {
  const { controller, network, mocks } = fixture(t, { protection: true });
  let entered, finish, launched = false;
  const started = new Promise(resolve => { entered = resolve; });
  const probe = new Promise(resolve => { finish = resolve; });
  mocks.electron = { app: { getPath: () => '/tmp/m3-vpn-test', on() {} } };
  mocks['child_process'] = { spawn: () => { launched = true; throw new Error('must not launch'); } };
  mocks.fs.existsSync = () => true;
  mocks['./proc-utils'] = { runCommandWithTimeout: async () => { entered(); await probe; network.checkpoint(); } };
  const mega = load('megacmd.js', mocks); await controller.configure({ enabled: true });
  const work = network.run('megacmd', () => mega.ensureMegaCmdServer());
  const rejected = assert.rejects(work, error => error.code === 'VPN_LOST');
  await started; controller.reportTunnelLoss(); finish(); await rejected; assert.equal(launched, false);
});

test('a canceled export close callback cannot start its fallback command', async t => {
  const children = [];
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { controller, network, mocks } = fixture(t, { protection: true, spawn: () => {
    const child = new EventEmitter(); child.pid = 123; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => true; children.push(child); entered(); return child;
  } });
  mocks.electron = { app: { getPath: () => '/tmp/m3-vpn-test', on() {} } };
  mocks.fs.existsSync = () => true;
  const mega = load('megacmd.js', mocks); await controller.configure({ enabled: true });
  const work = network.run('megacmd', () => mega.getMegacmdFolderLink('/folder'));
  const rejected = assert.rejects(work, error => error.code === 'VPN_LOST');
  await started; children[0].stderr.emit('data', Buffer.from('already exported'));
  controller.reportTunnelLoss(); children[0].emit('close', null);
  await rejected; assert.equal(children.length, 1);
});
