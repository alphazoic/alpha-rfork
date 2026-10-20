'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpnController, VpnControllerError } = require('./vpn-controller');

const connected = () => ({ state: 'connected', server: { id: 'CH#1', location: 'Zurich, Switzerland' } });
const disconnected = () => ({ state: 'disconnected', server: null });
const protection = () => ({ verified: true, startup: true, switching: true, tunnelLoss: true });
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t, options = {}) {
  let current = connected();
  const calls = [];
  const adapter = {
    async getStatus() { calls.push('status'); return current; },
    async connect(target) { calls.push(['connect', target]); current = connected(); return current; },
    async disconnect() { calls.push('disconnect'); current = disconnected(); return current; },
    ...options.adapter,
  };
  const controller = createVpnController({ adapter, verifyProtection: async () => protection(),
    ...options, adapter });
  t.after(() => controller.dispose());
  return { controller, calls, setStatus: value => { current = value; } };
}
const code = expected => error => { assert.equal(error.code, expected); return true; };
function clockFixture() {
  let time = 0, sequence = 0; const pending = new Map();
  return { now: () => time,
    retryTimers: { setTimeout(fn, ms) { pending.set(++sequence, { fn, at: time + ms }); return sequence; }, clearTimeout(id) { pending.delete(id); } },
    async advance(ms) { time += ms; for (const [id, timer] of [...pending]) if (timer.at <= time) { pending.delete(id); timer.fn(); } await turn(); },
    pending: () => pending.size };
}
test('one failed status poll preserves the current lease, blocks new work, and recovers without a lost-tunnel claim', async t => {
  let fail = false;
  const { controller, calls } = fixture(t, { adapter: { async getStatus() { if (fail) throw new Error('private output'); return connected(); } } });
  await controller.configure({ enabled: true, required: false });
  const current = await controller.acquire({ requireVpn: true }); fail = true;
  await controller.poll(); assert.equal(controller.snapshot().state, 'checking'); assert.equal(controller.snapshot().status.state, 'unknown');
  assert.equal(current.signal.aborted, false); current.checkpoint();
  assert.equal(controller.snapshot().lastError.code, 'VPN_STATUS_UNAVAILABLE');
  assert.ok(!JSON.stringify(controller.snapshot()).includes('private output'));
  let started = false; const waiting = controller.acquire({ requireVpn: true }).then(lease => { started = true; return lease; });
  await turn(); assert.equal(started, false);
  fail = false; await controller.poll(); (await waiting).release(); current.release();
  assert.equal(controller.snapshot().state, 'connected'); assert.equal(calls.filter(Array.isArray).length, 0);
});
test('persistent unknown status pauses only after its grace period and cancels the grace timer on recovery', async t => {
  const clock = clockFixture();
  const { controller, setStatus } = fixture(t, { ...clock, statusGraceMs: 100 });
  await controller.configure({ enabled: true, required: false }); const lease = await controller.acquire({ requireVpn: true });
  setStatus({ state: 'unknown', server: null }); await controller.poll();
  await clock.advance(99); assert.equal(lease.signal.aborted, false); lease.checkpoint();
  await clock.advance(1); assert.equal(lease.signal.reason.code, 'VPN_STATUS_UNAVAILABLE');
  assert.equal(controller.snapshot().pendingSwitches, 1);
  setStatus(connected()); await controller.poll(); lease.release(); await turn();
  assert.equal(controller.snapshot().state, 'connected'); assert.equal(clock.pending(), 0);
});
test('explicit disconnection interrupts immediately and active work recovers even with idle recovery disabled', async t => {
  const { controller, setStatus, calls } = fixture(t);
  await controller.configure({ enabled: true, required: false, autoRecover: false });
  const releaseWork = controller.retainVpnWork();
  const lease = await controller.acquire({ requireVpn: true }); setStatus(disconnected());
  await controller.poll(); assert.equal(lease.signal.reason.code, 'VPN_LOST'); assert.equal(controller.snapshot().pendingSwitches, 1);
  assert.equal(calls.filter(Array.isArray).length, 0); lease.release(); await turn(); await turn();
  assert.equal(controller.snapshot().state, 'connected'); assert.equal(calls.filter(Array.isArray).length, 1);
  releaseWork();
});
test('idle manual mode rechecks status but never connects without a job or an idle recovery setting', async t => {
  const { controller, setStatus, calls } = fixture(t);
  await controller.configure({ enabled: true, required: false, autoRecover: false });
  setStatus(disconnected()); await controller.poll(); assert.equal(controller.snapshot().state, 'disconnected');
  assert.equal(calls.filter(Array.isArray).length, 0);
  setStatus(connected()); await controller.poll(); assert.equal(controller.snapshot().state, 'connected');
});
test('stopping the last job during status grace prevents a later automatic reconnect', async t => {
  const clock = clockFixture();
  const { controller, setStatus, calls } = fixture(t, { ...clock, statusGraceMs: 100 });
  await controller.configure({ enabled: true, required: false });
  const abort = new AbortController(), releaseWork = controller.retainVpnWork({ signal: abort.signal });
  const lease = await controller.acquire({ requireVpn: true, signal: abort.signal });
  setStatus({ state: 'unknown', server: null }); await controller.poll(); abort.abort(); lease.release(); releaseWork();
  await clock.advance(1000); assert.equal(calls.filter(Array.isArray).length, 0);
});
test('an explicit Disconnect suppresses idle automatic reconnection while status monitoring continues', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true, required: false, autoRecover: true });
  await controller.requestSwitch({ action: 'disconnect' }); await controller.poll(); await turn();
  assert.equal(controller.snapshot().state, 'disconnected'); assert.equal(calls.filter(Array.isArray).length, 0);
  assert.equal(controller.snapshot().lastConfirmed.status.state, 'disconnected');
});

test('disabled construction/configuration issues no Proton commands and leases release', async t => {
  const { controller, calls } = fixture(t);
  await controller.configure({ enabled: false });
  const lease = await controller.acquire({ kind: 'download' });
  lease.checkpoint(); lease.release(); lease.release();
  assert.equal(controller.snapshot().state, 'disabled'); assert.deepEqual(calls, []);
  assert.equal(controller.snapshot().activeOperations.length, 0);
  await assert.rejects(controller.requestSwitch(), code('DISABLED'));
});

test('strict mode rejects missing/incomplete protection evidence before any CLI call', async t => {
  const { controller, calls } = fixture(t, { verifyProtection: async () => ({ verified: true, switching: true }) });
  const state = await controller.configure({ enabled: true });
  assert.equal(state.state, 'attention'); assert.equal(state.protectionVerified, false);
  await assert.rejects(controller.acquire(), code('PROTECTION_UNVERIFIED'));
  await assert.rejects(controller.requestSwitch(), code('PROTECTION_UNVERIFIED'));
  assert.deepEqual(calls, []);
});

test("connected mode reuses Proton's reported tunnel status", async t => {
  const { controller, calls } = fixture(t);
  const result = await controller.configure({ enabled: true });
  assert.equal(result.state, 'connected'); assert.equal(result.status.state, 'connected');
  assert.equal(result.protectionVerified, true);
  const lease = await controller.acquire(); lease.release();
  assert.ok(calls.every(call => call === 'status'));
});

test('normal switches wait for every active lease; later work cannot jump the barrier', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  const lease = await controller.acquire({ kind: 'upload' });
  const switching = controller.requestSwitch({ target: { server: 'DE#1' } });
  let laterStarted = false;
  const next = controller.acquire({ kind: 'download' }).then(lease => { laterStarted = true; return lease; });
  await turn(); assert.equal(laterStarted, false); assert.equal(calls.filter(Array.isArray).length, 0);
  lease.release(); await switching;
  const nextLease = await next; assert.equal(laterStarted, true); nextLease.release();
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('identical concurrent alarms coalesce into one switch', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  await Promise.all([controller.requestSwitch({ recovery: true }), controller.requestSwitch({ recovery: true })]);
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('different selections execute serially', async t => {
  const first = deferred(); let running = 0, peak = 0, count = 0;
  const { controller } = fixture(t, { adapter: { async connect() {
    peak = Math.max(peak, ++running); if (++count === 1) await first.promise;
    --running; return connected();
  } } });
  await controller.configure({ enabled: true });
  const a = controller.requestSwitch({ target: { server: 'CH#1' } });
  const b = controller.requestSwitch({ target: { server: 'DE#2' } });
  await turn(); first.resolve(); await Promise.all([a, b]);
  assert.equal(count, 2); assert.equal(peak, 1);
});

test('canceling one coalesced subscriber does not cancel another', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  const lease = await controller.acquire();
  const signal = new AbortController();
  const a = controller.requestSwitch({ signal: signal.signal });
  const aRejected = assert.rejects(a, code('CANCELED'));
  const b = controller.requestSwitch();
  signal.abort(); await aRejected; lease.release(); await b;
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('canceling queued work removes it permanently and lets a switch proceed', async t => {
  const { controller } = fixture(t); await controller.configure({ enabled: true });
  const first = await controller.acquire({ resources: ['megacmd-session'] });
  const signal = new AbortController();
  const waiting = controller.acquire({ resources: ['megacmd-session'], signal: signal.signal });
  const rejected = assert.rejects(waiting, code('CANCELED'));
  const switching = controller.requestSwitch();
  signal.abort(); await rejected; first.release(); await switching;
  assert.equal(controller.snapshot().waitingOperations.length, 0);
});

test('exclusive MEGAcmd session allows independent download leases concurrently', async t => {
  const { controller } = fixture(t);
  const account = await controller.acquire({ kind: 'upload', resources: ['megacmd-session'] });
  let acquired = false;
  const second = controller.acquire({ kind: 'account-refresh', resources: ['megacmd-session'] }).then(lease => { acquired = true; return lease; });
  const download = await controller.acquire({ kind: 'download' });
  assert.equal(acquired, false); download.release(); account.release(); (await second).release();
});

test('tunnel loss invalidates leases but recovery waits for owner cleanup', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  const lease = await controller.acquire({ kind: 'download' });
  controller.reportTunnelLoss();
  assert.equal(lease.signal.aborted, true); assert.throws(() => lease.checkpoint(), code('VPN_LOST'));
  const recovery = controller.requestSwitch({ recovery: true });
  await turn(); assert.equal(calls.filter(Array.isArray).length, 0);
  lease.release(); await recovery; assert.equal(controller.snapshot().state, 'connected');
});

test('manual connect can unblock work waiting for a disconnected protected tunnel', async t => {
  const { controller, setStatus } = fixture(t); setStatus(disconnected());
  await controller.configure({ enabled: true });
  const waiting = controller.acquire();
  await controller.requestSwitch(); (await waiting).release();
});

test('failed switch holds queued work until a later manual recovery', async t => {
  let fail = true;
  const { controller } = fixture(t, { adapter: { async connect() { if (fail) throw new Error('token=private https://mega.nz/file/id#key'); } } });
  await controller.configure({ enabled: true });
  await assert.rejects(controller.requestSwitch());
  assert.equal(controller.snapshot().state, 'attention');
  assert.ok(!JSON.stringify(controller.snapshot()).includes('token=private'));
  const queued = controller.acquire(); fail = false;
  await controller.requestSwitch(); (await queued).release();
});

test('cooldown and rolling speed limits retain the same job and resume automatically when the window opens', async t => {
  const clock = clockFixture();
  const { controller, calls } = fixture(t, clock);
  await controller.configure({ enabled: true, recoveryCooldownMs: 10, recoveryWindowMs: 100, maxRecoverySwitches: 2 });
  await controller.requestSwitch({ recovery: true });
  const cooldown = controller.requestSwitch({ recovery: true }); await turn();
  assert.equal(controller.snapshot().state, 'waiting'); assert.equal(controller.snapshot().connectionProgress.nextRetryAt, 10);
  await clock.advance(10); await cooldown;
  const window = controller.requestSwitch({ recovery: true }); await turn();
  assert.equal(controller.snapshot().connectionProgress.nextRetryAt, 100);
  await clock.advance(90); await window;
  await controller.requestSwitch(); // Manual requests do not consume the recovery budget.
  assert.equal(calls.filter(Array.isArray).length, 4);
});

test('verification timeout cannot admit work based on a late result', async t => {
  const late = deferred();
  const { controller } = fixture(t, { verifyProtection: () => late.promise, verificationTimeoutMs: 10 });
  await controller.configure({ enabled: true });
  assert.equal(controller.snapshot().state, 'attention'); late.resolve(protection()); await turn();
  assert.equal(controller.snapshot().protectionVerified, false);
});

test('monitor failure reports loss and optional automatic recovery is coalesced', async t => {
  const { controller, setStatus, calls } = fixture(t);
  await controller.configure({ enabled: true, autoRecover: true });
  const lease = await controller.acquire(); setStatus(disconnected());
  await controller.poll(); assert.equal(lease.signal.aborted, true);
  controller.reportTunnelLoss(); lease.release();
  await turn(); await turn();
  assert.equal(calls.filter(Array.isArray).length, 1);
});

test('controller disposal stops active work; the app owns the subsequent disconnect sequence', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  const lease = await controller.acquire();
  await assert.rejects(controller.configure({ enabled: false }), code('BUSY'));
  const switching = controller.requestSwitch();
  const rejected = assert.rejects(switching, code('DISPOSED'));
  controller.dispose(); await rejected;
  assert.equal(lease.signal.aborted, true); lease.release();
  assert.ok(!calls.includes('disconnect'));
  await assert.rejects(controller.acquire(), code('DISPOSED'));
});

test('pre-aborted operations and connection commands issue no work', async t => {
  const { controller, calls } = fixture(t); await controller.configure({ enabled: true });
  const signal = new AbortController(); signal.abort(); const before = calls.length;
  await assert.rejects(controller.acquire({ signal: signal.signal }), code('CANCELED'));
  await assert.rejects(controller.requestSwitch({ signal: signal.signal }), code('CANCELED'));
  assert.equal(calls.length, before);
});

test('public settings cannot supply protection evidence', async t => {
  const { controller } = fixture(t);
  await assert.rejects(controller.configure({ protectionVerified: true }), /Unknown VPN setting/);
});

test('canceling an active switch keeps subsequent commands waiting until adapter cleanup', async t => {
  const finishing = deferred(), entered = deferred(); let canceled = false;
  const { controller, calls } = fixture(t, { adapter: { async connect(_target, { signal }) {
    entered.resolve(); signal.addEventListener('abort', () => { canceled = true; }); await finishing.promise;
  } } });
  await controller.configure({ enabled: true });
  const abort = new AbortController();
  const first = controller.requestSwitch({ signal: abort.signal });
  const rejected = assert.rejects(first, code('CANCELED'));
  await entered.promise; abort.abort(); await rejected; assert.equal(canceled, true);
  const pending = controller.acquire();
  const before = calls.length; await turn(); assert.equal(calls.length, before);
  finishing.resolve(); await turn(); assert.equal(controller.snapshot().state, 'attention');
  await controller.requestSwitch(); (await pending).release();
});

test('monitor and connection commands cannot race status verification', async t => {
  const pending = deferred(), entered = deferred(); let block = false, connects = 0;
  const { controller } = fixture(t, { adapter: { async getStatus() {
    if (block) { entered.resolve(); await pending.promise; } return connected();
  }, async connect() { connects++; } } });
  await controller.configure({ enabled: true }); block = true;
  const poll = controller.poll(); await entered.promise;
  const switching = controller.requestSwitch(); await turn(); assert.equal(connects, 0);
  block = false; pending.resolve(); await poll; await switching; assert.equal(connects, 1);
});

test('configuration persistence commits before new queued work is admitted', async t => {
  const blocked = deferred(), entered = deferred(); let hold = false, committed = false;
  const { controller } = fixture(t, { adapter: { async getStatus() {
    if (hold) { entered.resolve(); await blocked.promise; } return connected();
  } } });
  hold = true;
  const configuring = controller.configure({ enabled: true, required: false }, { commit: () => { committed = true; } });
  await entered.promise;
  const waiting = controller.acquire().then(lease => { assert.equal(committed, true); return lease; });
  hold = false; blocked.resolve(); await configuring; (await waiting).release();
});

test('failed configuration commit restores prior state and leaves the OS route untouched', async t => {
  const { controller, calls } = fixture(t);
  await assert.rejects(controller.configure({ enabled: true, required: false }, { commit: () => { throw new Error('write failed'); } }), /write failed/);
  assert.equal(controller.snapshot().state, 'disabled'); assert.equal(controller.snapshot().settings.enabled, false);
  assert.ok(!calls.includes('disconnect')); assert.ok(!calls.some(Array.isArray));
});

test('read-only reconciliation can restore admission after a recoverable attention state', async t => {
  const { controller } = fixture(t); await controller.configure({ enabled: true });
  controller.reportTunnelLoss(); const waiting = controller.acquire();
  await controller.poll(true); (await waiting).release(); assert.equal(controller.snapshot().state, 'connected');
});
