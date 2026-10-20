'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { createNetworkOperations } = require('./network-operations');
const { ProtonVpnError } = require('./protonvpn');
const store = require('../scripts/vpn-test-catalog.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failed = (code = 'CONNECTION_FAILED') => Object.assign(new ProtonVpnError(code, 'connect', 1), { terminationConfirmed: true });
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(5); } throw new Error('Workflow condition timed out'); }
async function fixture(t, { connect, vpn = {}, catalogStore = store, controllerOptions = {}, adapterOverrides = {} } = {}) {
  let status = { state: 'connected', server: { id: 'CH#1' } };
  let config = { proxy: 'https://must-not-be-contacted.invalid', vpn: { enabled: true, required: false,
    refreshMode: 'every-account', preferredServers: ['CH#1', 'DE#2', 'US#3'],
    connectionRetry: { maxCandidates: 1, initialDelayMs: 0, roundRetryDelayMs: 20, failedServerCooldownMs: 0 }, ...vpn } };
  const calls = [], capabilities = { commands: { connect: true, disconnect: true, status: true }, selectors: { server: true, country: true, city: true, random: true } };
  const adapter = {
    async getStatus() { calls.push('status'); return structuredClone(status); },
    async inspect() { calls.push('inspect'); return capabilities; },
    async diagnose() { return { ready: true, capabilities, diagnostics: [], status: structuredClone(status) }; },
    async connect(target, options) {
      assert.equal(controller.snapshot().activeOperations.length, 0);
      calls.push({ target, signal: options.signal });
      status = { state: 'disconnected', server: null };
      if (connect) await connect({ target, options, calls, setStatus: value => { status = value; } });
      status = { state: 'connected', server: { id: target.server || 'DE#2' } };
      return structuredClone(status);
    },
    async disconnect() { calls.push('disconnect'); return status = { state: 'disconnected', server: null }; },
    ...adapterOverrides,
  };
  const controller = createVpnController({ adapter, ...controllerOptions });
  const service = createVpnService({ controller, adapter, catalogStore, platform: 'linux', loadConfig: () => structuredClone(config), saveConfig: next => { config = next; } });
  const network = createNetworkOperations(controller);
  t.after(async () => { service.dispose(); controller.dispose(); await turn(); });
  await service.restore();
  return { controller, service, network, calls, config: () => config,
    targets: () => calls.filter(call => typeof call === 'object').map(call => call.target),
    setStatus: value => { status = value; } };
}
function recoveryClock() {
  let now = 1000, sequence = 0; const timers = new Map();
  return {
    now: () => now,
    retryTimers: { setTimeout(fn, delay) { timers.set(++sequence, { fn, at: now + delay }); return sequence; }, clearTimeout(id) { timers.delete(id); } },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    pending: () => timers.size,
  };
}
test('a long outage retains one refresh request across 250 rounds, advances the real catalog, and recovers automatically', async t => {
  const { parseCatalog } = require('./vpn-catalog');
  const { BUNDLED_CATALOG } = require('./vpn-catalog-store');
  const catalog = parseCatalog(require('node:fs').readFileSync(BUNDLED_CATALOG, 'utf8'));
  const clock = recoveryClock(); let ready = false, mutations = 0, peak = 0;
  const f = await fixture(t, { catalogStore: { load: () => ({ catalog, source: 'bundled' }) },
    controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    vpn: { preferredServers: [], serverSelection: { mode: 'all', order: 'file-order', recentLimit: 0 },
      connectionRetry: { maxCandidates: 1, initialDelayMs: 0, roundRetryDelayMs: 1, failedServerCooldownMs: 0 } },
    connect: async () => {
      peak = Math.max(peak, ++mutations);
      try { await turn(); if (!ready) throw Object.assign(failed('COMMAND_FAILED'), { exitCode: 0 }); }
      finally { mutations--; }
    } });
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); let settled = false;
  work.then(() => { settled = true; }, () => { settled = true; });
  for (let round = 1; round <= 250; round++) {
    await until(() => f.controller.snapshot().retryWaiting && f.targets().length === round);
    assert.equal(settled, false); assert.equal(f.service.snapshot().commands.length, 1);
    assert.equal(f.controller.snapshot().connectionProgress.round, round);
    assert.equal(f.controller.snapshot().lastError.exitCode, 0);
    assert.ok(f.controller.snapshot().history.length <= 100); assert.equal(clock.pending(), 1);
    if (round === 250) ready = true;
    clock.advance(1);
  }
  await until(() => !f.service.snapshot().commands.length);
  await work; plan.close();
  assert.deepEqual(f.targets().map(target => target.server), catalog.records.slice(0, 251).map(record => record.id));
  assert.equal(peak, 1); assert.equal(clock.pending(), 0); assert.equal(f.service.snapshot().commands.length, 0);
  assert.equal(f.controller.snapshot().activeOperations.length, 0); assert.equal(f.controller.snapshot().state, 'connected');
});
for (const fault of ['pre-connect status', 'post-connect status', 'wrong connected server']) {
  test(`${fault} reconciles automatically within the same refresh request without speculative failover`, async t => {
    const clock = recoveryClock(); let faultActive = false, target = null;
    let status = { state: 'connected', server: { id: 'CH#1' } };
    const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
      adapterOverrides: {
        async getStatus() {
          if (faultActive && (fault === 'pre-connect status' || target && fault === 'post-connect status')) {
            throw Object.assign(new ProtonVpnError('COMMAND_FAILED', 'status', 0), { terminationConfirmed: true });
          }
          return structuredClone(status);
        },
        async connect(next) {
          assert.equal(f.controller.snapshot().activeOperations.length, 0);
          target = next.server;
          status = { state: 'connected', server: { id: faultActive && fault === 'wrong connected server' ? 'US#3' : target } };
          return this.getStatus();
        },
      } });
    faultActive = true;
    const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
    await until(() => f.controller.snapshot().retryWaiting);
    assert.equal(f.service.snapshot().commands.length, 1);
    if (fault === 'pre-connect status') assert.equal(target, null);
    else assert.equal(target, 'DE#2');
    faultActive = false;
    if (target) status = { state: 'connected', server: { id: target } };
    clock.advance(1000); await until(() => !f.service.snapshot().commands.length); await work; plan.close();
    assert.equal(target, 'DE#2'); assert.equal(f.controller.snapshot().status.server.id, target);
    assert.equal(clock.pending(), 0); assert.equal(f.service.snapshot().commands.length, 0);
  });
}
test('a temporary sign-in problem automatically resumes the same refresh job without Retry', async t => {
  let ready = false; const clock = recoveryClock();
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    connect: () => { if (!ready) throw failed('AUTH_REQUIRED'); } });
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  const pending = f.service.snapshot().commands[0].id;
  assert.equal(f.controller.snapshot().connectionProgress.nextRetryAt, 31000);
  ready = true; clock.advance(30000); await work; plan.close();
  assert.equal(f.targets().length, 2); assert.equal(f.controller.snapshot().state, 'connected');
  assert.equal(f.service.snapshot().commands.some(command => command.id === pending), false); assert.equal(clock.pending(), 0);
});
test('Settings Connect retains discovery failures inside automatic recovery instead of returning a preflight error', async t => {
  const clock = recoveryClock(); let unavailable = false, helpCalls = 0;
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers, retryRandom: () => 0.5 },
    adapterOverrides: {
      async inspect() { helpCalls++; if (unavailable) throw new ProtonVpnError('COMMAND_FAILED', 'inspect', 0); return {}; },
      async getStatus() { await this.inspect(); return { state: 'connected', server: { id: 'CH#1' } }; },
    } });
  unavailable = true;
  const command = await f.service.command({ action: 'connect' }); assert.equal(command.ok, true);
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.controller.snapshot().lastError.operation, 'inspect'); assert.equal(f.controller.snapshot().lastError.exitCode, 0);
  assert.equal(f.targets().length, 0); assert.ok(helpCalls > 0);
  unavailable = false; clock.advance(1000);
  await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.controller.snapshot().state, 'connected'); assert.deepEqual(f.targets(), [{}]);
});
test('late process closure automatically resumes a held connection job without overlapping commands', async t => {
  const clock = recoveryClock(); let closed = false;
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    adapterOverrides: { getProcessState: () => ({ blocked: !closed }) },
    connect: () => { if (!closed) throw Object.assign(failed('TIMEOUT'), { terminationConfirmed: false }); } });
  const command = await f.service.command({ action: 'switch' }); assert.equal(command.ok, true);
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.controller.snapshot().retryBlocked, true); assert.equal(f.targets().length, 1);
  clock.advance(30000); await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.targets().length, 1);
  closed = true; clock.advance(30000);
  await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.controller.snapshot().state, 'connected'); assert.equal(f.targets().length, 2);
});
test('canceling a slow prerequisite recheck removes its timer and cannot reconnect after the problem clears', async t => {
  const clock = recoveryClock(); let ready = false;
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers }, connect: () => { if (!ready) throw failed('AUTH_REQUIRED'); } });
  const command = await f.service.command({ action: 'switch' }); await until(() => f.controller.snapshot().retryWaiting);
  f.service.cancelCommand(command.requestId); await until(() => !f.service.snapshot().commands.length);
  ready = true; clock.advance(1000000); await turn();
  assert.equal(f.targets().length, 1); assert.equal(clock.pending(), 0);
});
test('Cancel request suppresses idle monitor reconnects until the user explicitly connects again', async t => {
  const clock = recoveryClock(); let ready = false;
  const f = await fixture(t, { vpn: { autoRecover: true }, controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    connect: () => { if (!ready) throw failed('AUTH_REQUIRED'); } });
  const command = await f.service.command({ action: 'switch' }); await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.service.cancelCommand(command.requestId).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  ready = true; clock.advance(100000); await f.controller.poll(); await turn();
  assert.equal(f.targets().length, 1); assert.equal(f.controller.snapshot().pendingSwitches, 0); assert.equal(clock.pending(), 0);
  await f.service.command({ action: 'connect' }); await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.targets().length, 2); assert.equal(f.controller.snapshot().state, 'connected');
});
test('Disconnect requires stopping active job scopes so they cannot silently reconnect afterward', async t => {
  const f = await fixture(t);
  for (const begin of [() => f.service.beginRefresh(), () => f.service.beginDownload(), () => f.service.beginUpload()]) {
    const plan = begin();
    const result = await f.service.command({ action: 'disconnect' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'DISCONNECT_BUSY');
    assert.ok(!f.calls.includes('disconnect')); plan.close();
  }
  assert.equal((await f.service.command({ action: 'disconnect' })).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.controller.snapshot().state, 'disconnected'); assert.equal(f.targets().length, 0);
});
test('a canceled idle reconnect does not hide a later disconnection from active VPN work', async t => {
  const f = await fixture(t); f.controller.suppressAutomaticRecovery();
  const abort = new AbortController(), lease = await f.controller.acquire({ requireVpn: true, signal: abort.signal });
  f.setStatus({ state: 'disconnected', server: null }); await f.controller.poll();
  assert.equal(lease.signal.reason.code, 'VPN_LOST');
  abort.abort(); lease.release();
  assert.equal(f.targets().length, 0);
});
test('changing the waiting pool discards pending reconciliation of a server outside the newly selected pool', async t => {
  let status = { state: 'connected', server: { id: 'CH#1' } }, unknown = false;
  const targets = [];
  const f = await fixture(t, { adapterOverrides: {
    async getStatus() { return unknown ? { state: 'unknown', server: null } : status; },
    async connect(target) {
      targets.push(target.server); status = { state: 'connected', server: { id: target.server } };
      if (targets.length === 1) { unknown = true; return { state: 'unknown', server: null }; }
      return status;
    },
  } });
  const command = await f.service.command({ action: 'switch' }); assert.equal(command.ok, true);
  await until(() => f.controller.snapshot().retryWaiting);
  assert.deepEqual(targets, ['DE#2']); unknown = false;
  assert.equal(f.service.changeWaitingPool({ mode: 'servers', servers: ['US#3'], recentLimit: 0 }).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.deepEqual(targets, ['DE#2', 'US#3']); assert.equal(f.controller.snapshot().status.server.id, 'US#3');
});
test('file-order refreshes continue beyond Afghanistan and retain position across refresh batches and other workflows', async t => {
  const { parseCatalog } = require('./vpn-catalog');
  const { BUNDLED_CATALOG } = require('./vpn-catalog-store');
  const full = parseCatalog(require('node:fs').readFileSync(BUNDLED_CATALOG, 'utf8'));
  const f = await fixture(t, { catalogStore: { load: () => ({ catalog: full, source: 'bundled' }) },
    vpn: { preferredServers: [], preferredCountries: [], recoveryCooldownMs: 0,
      serverSelection: { mode: 'all', order: 'file-order', recentLimit: 5 } } });
  for (let batch = 0; batch < 4; batch++) {
    const plan = f.service.beginRefresh();
    try { for (let account = 1; account <= 10; account++) await plan.beforeAccount(account); }
    finally { plan.close(); }
  }
  assert.deepEqual(f.targets().map(target => target.server), full.records.slice(0, 40).map(record => record.id));
  const manual = await f.service.command({ action: 'switch' }); assert.equal(manual.ok, true);
  await until(() => !f.service.snapshot().commands.length);
  const download = f.service.beginDownload(); await download.recover(undefined, 'speed'); download.close();
  const upload = f.service.beginUpload(); await upload.recover(undefined, 'speed'); upload.close();
  assert.deepEqual(f.targets().slice(40).map(target => target.server), full.records.slice(40, 43).map(record => record.id));
});
test('a two-server pool with an oversized recent preference continues rotating without getting stuck', async t => {
  const f = await fixture(t, { vpn: { serverSelection: { mode: 'servers', servers: ['CH#1', 'DE#2'],
    excludeServers: ['US#3'], order: 'file-order', recentLimit: 1000 } } });
  const plan = f.service.beginRefresh();
  try { for (let account = 1; account <= 12; account++) await plan.beforeAccount(account); }
  finally { plan.close(); }
  assert.deepEqual(f.targets().map(target => target.server), Array.from({ length: 12 }, (_, i) => i % 2 ? 'CH#1' : 'DE#2'));
});
test('an all-down pool keeps its refresh pending through a complete pass and cooldown then recovers automatically', async t => {
  const clock = recoveryClock(); let ready = false;
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    vpn: { connectionRetry: { maxCandidates: 10, initialDelayMs: 0, roundRetryDelayMs: 1, failedServerCooldownMs: 100 } },
    connect: () => { if (!ready) throw failed(); } });
  const plan = f.service.beginRefresh(); const work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(new Set(f.targets().map(target => target.server)).size, 3);
  assert.equal(f.targets().length, 3); assert.equal(f.service.snapshot().refreshing, true);
  ready = true; clock.advance(100); await work; plan.close();
  assert.equal(f.targets().length, 4); assert.equal(f.controller.snapshot().state, 'connected'); assert.equal(clock.pending(), 0);
});
test('refresh rotation keeps its switch barrier through failover and only then admits pending work', async t => {
  let release, entered = false;
  const f = await fixture(t, { vpn: { connectionRetry: { maxCandidates: 10, initialDelayMs: 0 } },
    connect: async ({ target }) => {
      if (target.server === 'DE#2') throw failed();
      entered = true; await new Promise(resolve => { release = resolve; });
    } });
  t.after(() => release?.());
  const lease = await f.controller.acquire({ kind: 'download' });
  const plan = f.service.beginRefresh(); t.after(() => plan.close());
  const rotation = plan.beforeAccount(1); rotation.catch(() => {});
  await turn(); assert.equal(f.targets().length, 0); lease.release();
  await until(() => entered);
  let admitted = false;
  const pending = f.network.run('metadata', () => { admitted = true; }); pending.catch(() => {});
  await turn(); assert.equal(admitted, false);
  assert.deepEqual(f.targets(), [{ server: 'DE#2' }, { server: 'US#3' }]);
  release(); await rotation; await pending;
  assert.equal(admitted, true); assert.equal(f.controller.snapshot().status.server.id, 'US#3');
});
test('an exhausted round automatically retries while retaining the same refresh promise and excluding the original route', async t => {
  let ready = false;
  const f = await fixture(t, { connect: () => { if (!ready) throw failed(); } });
  const plan = f.service.beginRefresh(); let finished = false;
  const work = plan.beforeAccount(1).then(() => { finished = true; }); work.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting');
  assert.equal(finished, false); assert.equal(f.service.snapshot().commands.length, 1);
  ready = true; await work; plan.close();
  assert.equal(finished, true); assert.deepEqual(f.targets(), [{ server: 'DE#2' }, { server: 'US#3' }]);
  assert.equal(f.controller.snapshot().state, 'connected');
});
test('authentication failures retain the job with a slow automatic recheck and optional Retry now', async t => {
  let ready = false;
  const f = await fixture(t, { connect: () => { if (!ready) throw failed('AUTH_REQUIRED'); } });
  const plan = f.service.beginRefresh(); const work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.controller.snapshot().state, 'attention'); assert.equal(f.controller.snapshot().lastError.code, 'AUTH_REQUIRED');
  assert.ok(f.controller.snapshot().connectionProgress.nextRetryAt > Date.now());
  const count = f.calls.length; await sleep(45); assert.equal(f.calls.length, count);
  ready = true; assert.equal(f.service.retryConnection().ok, true);
  await work; plan.close(); assert.equal(f.targets().length, 2);
});
test('an empty strict catalog pool holds the job until an explicit pool change', async t => {
  const f = await fixture(t, { vpn: { serverSelection: { mode: 'servers', servers: ['DE#999999'] } } });
  const plan = f.service.beginRefresh(); const work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.controller.snapshot().state, 'attention'); assert.equal(f.targets().length, 0);
  assert.equal(f.controller.snapshot().lastError.code, 'NO_CANDIDATES');
  assert.equal(f.service.retryConnection({ selection: { mode: 'servers', servers: ['US#3'], recentLimit: 0 } }).ok, true);
  await work; plan.close(); assert.deepEqual(f.targets(), [{ server: 'US#3' }]);
});
test('an explicit pool change can return to the old server after the failed rotation disconnected it', async t => {
  const f = await fixture(t, { connect: ({ target }) => { if (target.server !== 'CH#1') throw failed(); } });
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting');
  assert.equal(f.service.retryConnection({ selection: { mode: 'servers', servers: ['CH#1'], recentLimit: 0 } }).ok, true);
  await work; plan.close(); assert.equal(f.controller.snapshot().status.server.id, 'CH#1');
});
test('a corrupt custom catalog is not replaced by a broader bundled pool', async t => {
  const { VpnCatalogError } = require('./vpn-catalog');
  const f = await fixture(t, { catalogStore: { load() { throw new VpnCatalogError('INVALID_CATALOG', 'Invalid local catalog.'); } } });
  const abort = new AbortController(), plan = f.service.beginRefresh();
  const work = plan.beforeAccount(1, { signal: abort.signal }); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.controller.snapshot().lastError.code, 'INVALID_CATALOG'); assert.equal(f.targets().length, 0);
  abort.abort(); await assert.rejects(work, error => error.code === 'CANCELED'); plan.close();
});
test('canceling a waiting round removes its timer and cannot restart the refresh later', async t => {
  const f = await fixture(t, { connect: () => { throw failed(); } });
  const abort = new AbortController(), plan = f.service.beginRefresh();
  const work = plan.beforeAccount(1, { signal: abort.signal }); work.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting');
  abort.abort(); await assert.rejects(work, error => error.code === 'CANCELED'); plan.close();
  await until(() => !f.controller.snapshot().connectionCommandActive);
  const count = f.calls.length; await sleep(50);
  assert.equal(f.calls.length, count); assert.equal(f.service.retryConnection().ok, false);
});
test('Stop during a CLI attempt retains the barrier until the adapter confirms cleanup', async t => {
  let close, entered = false;
  const f = await fixture(t, { connect: ({ options }) => new Promise((resolve, reject) => {
    entered = true; close = () => reject(failed('CANCELED'));
    options.signal.addEventListener('abort', () => {}, { once: true });
  }) });
  t.after(() => close?.());
  const abort = new AbortController(), plan = f.service.beginRefresh();
  const work = plan.beforeAccount(1, { signal: abort.signal }); work.catch(() => {});
  await until(() => entered); abort.abort(); await assert.rejects(work, error => error.code === 'CANCELED');
  assert.equal(f.controller.snapshot().connectionCommandActive, true);
  let admitted = false; const pendingAbort = new AbortController();
  const pending = f.network.run('metadata', () => { admitted = true; }, { signal: pendingAbort.signal }); pending.catch(() => {});
  await turn(); assert.equal(admitted, false); assert.equal(f.targets().length, 1);
  close(); await until(() => !f.controller.snapshot().connectionCommandActive);
  assert.equal(admitted, false); pendingAbort.abort(); await assert.rejects(pending); plan.close();
});
test('unconfirmed termination blocks later disconnect commands even after the user cancels waiting', async t => {
  const f = await fixture(t, { connect: () => { const error = failed('TIMEOUT'); error.terminationConfirmed = false; throw error; } });
  const command = await f.service.command({ action: 'switch' });
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.service.retryConnection().ok, false);
  f.service.cancelCommand(command.requestId); await until(() => !f.service.snapshot().commands.length);
  const count = f.calls.length;
  const disconnect = await f.service.command({ action: 'disconnect' }); assert.equal(disconnect.ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.calls.length, count); assert.equal(f.service.snapshot().serviceError.code, 'PROCESS_UNCONFIRMED');
});
test('upload/download alarms share all candidates and rounds while consuming only one speed trigger', async t => {
  let ready = false;
  const f = await fixture(t, { vpn: { maxRecoverySwitches: 1 }, connect: () => { if (!ready) throw failed(); } });
  const download = f.service.beginDownload(), upload = f.service.beginUpload();
  const first = download.recover(undefined, 'speed'), second = upload.recover(undefined, 'speed');
  first.catch(() => {}); second.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting');
  assert.equal(f.targets().length, 1); ready = true;
  await Promise.all([first, second]); assert.equal(f.targets().length, 2);
  const canceled = new AbortController(), deferred = download.recover(canceled.signal, 'speed'); deferred.catch(() => {});
  await until(() => f.controller.snapshot().connectionProgress?.reason === 'speed-switch-limit');
  canceled.abort(); await assert.rejects(deferred, error => error.code === 'CANCELED');
  await until(() => !f.controller.snapshot().connectionCommandActive);
  const refresh = f.service.beginRefresh(); await refresh.beforeAccount(1); refresh.close();
  assert.equal(f.targets().length, 3); download.close(); upload.close();
});
test('a transfer held by its speed-switch window resumes automatically without Retry', async t => {
  const clock = recoveryClock();
  const f = await fixture(t, { controllerOptions: { now: clock.now, retryTimers: clock.retryTimers },
    vpn: { maxRecoverySwitches: 1, recoveryWindowMs: 100, recoveryCooldownMs: 0 } });
  const download = f.service.beginDownload(); await download.recover(undefined, 'speed');
  const work = download.recover(undefined, 'speed'); work.catch(() => {});
  await until(() => f.controller.snapshot().connectionProgress?.reason === 'speed-switch-limit');
  assert.equal(f.targets().length, 1); assert.equal(f.controller.snapshot().connectionProgress.nextRetryAt, 1100);
  clock.advance(100); await work;
  assert.equal(f.targets().length, 2); assert.equal(f.controller.snapshot().state, 'connected'); download.close();
});
test('canceling one transfer subscriber leaves the shared recovery running for another', async t => {
  let ready = false;
  const f = await fixture(t, { connect: () => { if (!ready) throw failed(); } });
  const a = f.service.beginDownload(), b = f.service.beginUpload(), abort = new AbortController();
  const first = a.recover(abort.signal, 'speed'), second = b.recover(undefined, 'speed'); first.catch(() => {}); second.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting'); abort.abort();
  await assert.rejects(first, error => error.code === 'CANCELED');
  assert.equal(f.controller.snapshot().connectionCommandActive, true);
  ready = true; await second; a.close(); b.close(); assert.equal(f.targets().length, 2);
});
test('a delayed alarm measured on the old connection reuses an already completed switch', async t => {
  const f = await fixture(t);
  const a = f.service.beginDownload(), b = f.service.beginUpload();
  const measured = f.controller.snapshot().connectionGeneration;
  await a.recover(undefined, 'speed', () => {}, measured);
  assert.notEqual(f.controller.snapshot().connectionGeneration, measured);
  await b.recover(undefined, 'speed', () => {}, measured);
  assert.equal(f.targets().length, 1); a.close(); b.close();
});
test('tunnel-loss recovery joins the controller round and is independent of speed cooldowns', async t => {
  const f = await fixture(t, { vpn: { autoRecover: true, maxRecoverySwitches: 1, recoveryCooldownMs: 999999 } });
  const transfer = f.service.beginDownload();
  await transfer.recover(undefined, 'speed');
  const closingTransport = await f.controller.acquire({ kind: 'download' });
  f.setStatus({ state: 'disconnected', server: null });
  f.controller.reportTunnelLoss(); const recovery = transfer.recover(undefined, 'loss');
  assert.equal(f.controller.snapshot().pendingSwitches, 1);
  closingTransport.release(); await recovery;
  assert.equal(f.targets().length, 2); assert.equal(f.controller.snapshot().state, 'connected'); transfer.close();
});
test('legacy mixed country/server pools migrate without dropping a configured country or broadening the pool', async t => {
  const f = await fixture(t, { vpn: { preferredServers: ['CH#1'], preferredCountries: ['Germany'] } });
  assert.equal(f.service.snapshot().preferences.serverSelection.mode, 'mixed');
  const plan = f.service.beginRefresh(); await plan.beforeAccount(1); plan.close();
  assert.deepEqual(f.targets(), [{ server: 'DE#2' }]);
  await f.service.saveApplicationConfig({ defaultTab: 'settings' });
  assert.equal(f.config().vpn.serverSelection.mode, 'mixed');
  await f.service.saveSettings({ preferredServers: [], preferredCountries: [] });
  assert.equal(f.service.snapshot().preferences.serverSelection.mode, 'all');
});
test('native Fastest available is tried once before explicit catalog failover', async t => {
  const f = await fixture(t, { vpn: { connectionRetry: { maxCandidates: 10, initialDelayMs: 0 } },
    connect: ({ target }) => { if (!target.server) throw failed(); } });
  const command = await f.service.command({ action: 'connect' }); assert.equal(command.ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.deepEqual(f.targets(), [{}, { server: 'DE#2' }]); assert.equal(f.controller.snapshot().state, 'connected');
});
test('explicit Connect reuses matching Proton status without a mutation or another verification step', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.command({ action: 'connect', target: { server: 'CH#1' } })).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.equal(f.targets().length, 0); assert.equal(f.controller.snapshot().state, 'connected');
});
test('workflow retries never make external requests or bypass the CLI adapter with a shell command', async t => {
  const deny = () => { throw new Error('Unexpected external request or subprocess'); };
  for (const [module, methods] of [[require('node:http'), ['get', 'request']], [require('node:https'), ['get', 'request']],
    [require('node:dns'), ['lookup', 'resolve']], [require('node:child_process'), ['spawn', 'exec', 'execFile']]]) {
    for (const name of methods) { const original = module[name]; module[name] = deny; t.after(() => { module[name] = original; }); }
  }
  const originalFetch = globalThis.fetch; globalThis.fetch = deny; t.after(() => { globalThis.fetch = originalFetch; });
  let ready = false;
  const f = await fixture(t, { connect: () => { if (!ready) throw failed(); } });
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().state === 'waiting'); ready = true; await work; plan.close();
  assert.equal(f.controller.snapshot().state, 'connected');
});
