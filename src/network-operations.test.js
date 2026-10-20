'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createVpnController } = require('./vpn-controller');
const { createNetworkOperations } = require('./network-operations');

test('wrappers created before main installs the coordinator acquire a lease at invocation time', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = path.join(__dirname, 'network-operations.js'), module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    id => require(id.startsWith('.') ? path.resolve(__dirname, id) : id), module, module.exports);
  const api = module.exports;
  const early = api.wrap('security-upgrade', async () => { api.checkpoint('megacmd-session'); return 'leased'; });
  const { controller } = fixture(t); api.installNetworkOperations(controller);
  await controller.configure({ enabled: true, required: false });
  assert.equal(await early(), 'leased');
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const code = expected => error => { assert.equal(error.code, expected); return true; };
function fixture(t, options = {}) {
  const calls = [];
  const controller = createVpnController({ adapter: {
    async getStatus() { return { state: 'connected', server: { id: 'CH#1' } }; },
    async connect() { calls.push('connect'); },
  }, verifyProtection: async () => ({ verified: true, startup: true, switching: true, tunnelLoss: true }),
 });
  t.after(() => controller.dispose());
  return { controller, calls, network: createNetworkOperations(controller, options) };
}

test('operation failures and nested helpers release one lease', async t => {
  const { network, controller } = fixture(t);
  await assert.rejects(network.run('upload', async () => {
    await network.run('account-create', async () => {
      assert.equal(controller.snapshot().activeOperations.length, 1);
      network.checkpoint('megacmd-session'); throw new Error('intentional test failure');
    });
  }), /intentional test failure/);
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('shutdown cancels work, confirms child closure, and blocks new network operations', async t => {
  const child = new EventEmitter(); child.pid = 1; child.kill = () => { queueMicrotask(() => child.emit('close')); };
  const { network } = fixture(t, { spawn: () => child });
  const entered = deferred();
  const work = network.run('upload', async () => { network.spawnNetwork('tool', []); entered.resolve(); await network.delay(60000); });
  const rejected = assert.rejects(work, code('DISPOSED')); await entered.promise;
  await network.shutdown(); await rejected;
  await assert.rejects(network.run('upload', async () => {}), code('DISPOSED'));
  assert.throws(() => network.spawnNetwork('tool', []), code('DISPOSED'));
});

test('waiting jobs cancel promptly and never run after the blocking owner exits', async t => {
  const { network, controller } = fixture(t);
  const holding = deferred(), started = deferred();
  const upload = network.run('upload', async () => { started.resolve(); await holding.promise; });
  await started.promise;
  let ran = false;
  const waiting = network.run('account-refresh', async () => { ran = true; });
  const rejected = assert.rejects(waiting, code('CANCELED'));
  network.cancel('account-refresh'); await rejected;
  holding.resolve(); await upload; await turn();
  assert.equal(ran, false); assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('canceling an active delay preserves cancellation instead of a fallback failure', async t => {
  const { network, controller } = fixture(t);
  const entered = deferred();
  const work = network.run('upload', async () => {
    entered.resolve(); try { await network.delay(60000); } catch (error) { network.interruption(error); }
  });
  const rejected = assert.rejects(work, code('CANCELED'));
  await entered.promise; network.cancel('upload'); await rejected;
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('central subprocess helper refuses an unleased call in enabled mode', async t => {
  let spawned = false;
  const { network, controller } = fixture(t, { spawn: () => { spawned = true; } });
  await controller.configure({ enabled: true });
  assert.throws(() => network.spawnNetwork('megatools', []), code('LEASE_INVALID'));
  assert.equal(spawned, false);
  await assert.rejects(network.run('metadata', async () => network.spawnNetwork('/bin/mega-exec', ['ls'])), code('RESOURCE_REQUIRED'));
});

test('disabled unleased commands preserve existing module behavior', async t => {
  let spawned = false;
  const { network } = fixture(t, { spawn: () => { spawned = true; return {}; } });
  network.spawnNetwork('tool', []); assert.equal(spawned, true);
});

test('emergency recovery waits for an interrupted child close event', async t => {
  const child = new EventEmitter(); child.pid = 1; child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  const { network, controller, calls } = fixture(t, { spawn: () => child, terminationGraceMs: 500 });
  await controller.configure({ enabled: true });
  const entered = deferred();
  const work = network.run('upload', async () => { network.spawnNetwork('megatools', []); entered.resolve(); await network.delay(60000); });
  const rejected = assert.rejects(work, code('VPN_RECOVERY'));
  await entered.promise;
  const recovery = controller.requestSwitch({ recovery: true });
  await turn(); assert.deepEqual(child.kills, ['SIGTERM']); assert.deepEqual(calls, []);
  child.emit('close', null); await rejected; await recovery;
  assert.deepEqual(calls, ['connect']);
});

test('unconfirmed child termination retains the lease and prevents a switch', async t => {
  const child = new EventEmitter(); child.pid = 1; child.kill = () => true;
  const { network, controller, calls } = fixture(t, { spawn: () => child, terminationGraceMs: 5 });
  await controller.configure({ enabled: true });
  const entered = deferred();
  const work = network.run('upload', async () => { network.spawnNetwork('megatools', []); entered.resolve(); await network.delay(60000); });
  const rejected = assert.rejects(work, code('TRANSPORT_UNCONFIRMED'));
  await entered.promise;
  const switchSignal = new AbortController();
  const recovery = controller.requestSwitch({ recovery: true, signal: switchSignal.signal });
  const switchRejected = assert.rejects(recovery, code('CANCELED'));
  await rejected;
  assert.deepEqual(calls, []); assert.equal(controller.snapshot().activeOperations.length, 1);
  switchSignal.abort(); await switchRejected;
  child.emit('close', null); await turn();
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('canceled fetches and HTTPS requests are stopped and cannot start new traffic', async t => {
  let request, fetchSignal;
  const lib = { request() { request = new EventEmitter(); request.destroy = error => { request.reason = error; request.emit('close'); }; return request; } };
  const { network } = fixture(t, { fetch: async (_url, options) => { fetchSignal = options.signal; return {}; } });
  const entered = deferred();
  const work = network.run('download', async () => {
    network.requestNetwork(lib, 'request', 'https://example.test');
    await network.fetchNetwork('https://example.test'); entered.resolve(); await network.delay(60000);
  });
  const rejected = assert.rejects(work, code('CANCELED'));
  await entered.promise; network.cancel('download'); await rejected;
  assert.equal(fetchSignal.aborted, true); assert.equal(request.reason.code, 'CANCELED');
});

test('enabled required mode cannot be bypassed by an unleased fetch', async t => {
  let fetched = false;
  const { network, controller } = fixture(t, { fetch: async () => { fetched = true; } });
  await controller.configure({ enabled: true });
  await assert.rejects(network.fetchNetwork('https://example.test'), code('LEASE_INVALID'));
  assert.equal(fetched, false);
});

test('a helper returning before its child closes cannot release the lease early', async t => {
  const child = new EventEmitter(); child.pid = 1; child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  const { controller, network } = fixture(t, { spawn: () => child, terminationGraceMs: 500 });
  const work = network.run('upload', async () => { network.spawnNetwork('megatools', []); return 'finished'; });
  await turn(); assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(controller.snapshot().activeOperations.length, 1);
  child.emit('close', null); assert.equal(await work, 'finished');
  assert.equal(controller.snapshot().activeOperations.length, 0);
});

test('HTTP destruction must be confirmed closed before recovery changes routes', async t => {
  const request = new EventEmitter(); request.destroy = () => {};
  const lib = { request: () => request };
  const { controller, network, calls } = fixture(t, { terminationGraceMs: 500 });
  await controller.configure({ enabled: true });
  const entered = deferred();
  const work = network.run('download', async () => {
    network.requestNetwork(lib, 'request', 'https://example.test'); entered.resolve(); await network.delay(60000);
  });
  const rejected = assert.rejects(work, code('VPN_RECOVERY'));
  await entered.promise; const recovery = controller.requestSwitch({ recovery: true });
  await turn(); assert.deepEqual(calls, []); assert.equal(controller.snapshot().activeOperations.length, 1);
  request.emit('close'); await rejected; await recovery; assert.deepEqual(calls, ['connect']);
});
