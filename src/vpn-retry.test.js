'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { BUNDLED_CATALOG } = require('./vpn-catalog-store');
const { parseCatalog } = require('./vpn-catalog');
const { ProtonVpnError } = require('./protonvpn');
const { createVpnRetryEngine, normalizeRetrySettings, DEFAULT_RETRY_SETTINGS, createRecoveryState, retryDelay } = require('./vpn-retry');
const turn = () => new Promise(resolve => setImmediate(resolve));
const DISCONNECTED = { state: 'disconnected', server: null };
const connected = id => ({ state: 'connected', server: { id } });
const failure = (code = 'CONNECTION_FAILED', details = {}) => Object.assign(new ProtonVpnError(code, 'connect', 1), { terminationConfirmed: true }, details);
const catalog = parseCatalog('Canada,Montreal,CA#1\nCanada,Toronto,CA#2\nGermany,Berlin,DE#1\nGermany,Frankfurt,DE#2\nFrance,Paris,FR#1\n');
function virtualClock() {
  let time = 1000, sequence = 0; const pending = new Map();
  return {
    now: () => time,
    timers: { setTimeout(fn, ms) { pending.set(++sequence, { fn, at: time + ms }); return sequence; }, clearTimeout(id) { pending.delete(id); } },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at; pending.delete(next[0]); next[1].fn();
      }
      time = end;
    },
    pending: () => pending.size,
  };
}
function fixture({ connect, getStatus, status = DISCONNECTED, sleep } = {}) {
  const clock = virtualClock(), calls = [], events = [], delays = [];
  const state = { status: structuredClone(status) };
  const adapter = {
    async getStatus(options) {
      calls.push({ operation: 'status', options });
      return getStatus ? getStatus({ state, calls, clock, options }) : structuredClone(state.status);
    },
    async connect(target, options) {
      calls.push({ operation: 'connect', target, options });
      if (connect) return connect({ target, options, clock, state, calls });
      state.status = connected(target.server); return structuredClone(state.status);
    },
  };
  const engine = createVpnRetryEngine({ adapter, now: clock.now, timers: clock.timers,
    random: () => 0.5, sleep: async (ms, signal) => { delays.push(ms); if (sleep) await sleep(ms, signal, clock); else clock.advance(ms); } });
  const run = options => engine.runRound({ catalog, selection: { order: 'file-order', recentLimit: 0 },
    onProgress: event => events.push(event), ...options });
  return { clock, engine, run, calls, events, delays, state, connects: () => calls.filter(call => call.operation === 'connect') };
}

for (const order of ['file-order', 'shuffle']) {
  test(`${order} traverses the entire bundled catalog across successful connection rounds without early repeats`, async () => {
    const full = parseCatalog(fs.readFileSync(BUNDLED_CATALOG, 'utf8'));
    let status = DISCONNECTED, connects = 0;
    const engine = createVpnRetryEngine({ adapter: {
      getStatus: async () => status,
      connect: async target => { connects++; return status = connected(target.server); },
    }, random: () => 0.5 });
    const selected = [];
    for (let i = 0; i < full.records.length; i++) {
      const result = await engine.runRound({ catalog: full, selection: { mode: 'all', order, recentLimit: 5 } });
      assert.equal(result.outcome, 'connected'); selected.push(result.server);
    }
    assert.equal(connects, 16821); assert.equal(new Set(selected).size, 16821);
    if (order === 'file-order') {
      assert.deepEqual(selected, full.records.map(record => record.id));
      assert.deepEqual(selected.slice(0, 6), ['AF#1', 'AF#2', 'AF#3', 'AF#4', 'AF#5', 'AL#25']);
    }
    assert.equal(engine.snapshot().selection.pass, 1); assert.equal(engine.snapshot().selection.remaining, 0);
    assert.equal(engine.snapshot().cachedPools, 1); assert.equal(engine.snapshot().recentServers.length, 1000);
    const next = await engine.runRound({ catalog: full, selection: { mode: 'all', order } });
    assert.equal(next.outcome, 'connected'); assert.equal(next.selection.pass, 2);
    assert.notEqual(next.server, selected.at(-1));
  });
}
test('exhausted one-candidate rounds advance through a failed pool then cycle and recover without manual Retry', async () => {
  let ready = false; const recovery = createRecoveryState();
  const f = fixture({ connect: ({ target, state }) => { if (!ready) throw failure(); return state.status = connected(target.server); } });
  const retry = { maxCandidates: 1, initialDelayMs: 0, failedServerCooldownMs: 0, roundRetryDelayMs: 1 };
  const selected = [];
  for (let i = 0; i < 10; i++) {
    const result = await f.run({ recovery, retry }); assert.equal(result.outcome, 'waiting');
    selected.push(...result.attemptedServers); f.clock.advance(result.retryDelayMs);
  }
  assert.deepEqual(selected, [...catalog.records, ...catalog.records].map(record => record.id));
  ready = true;
  assert.equal((await f.run({ recovery, retry })).server, 'CA#1'); assert.equal(f.connects().length, 11);
});
test('a round deadline during backoff preserves the unattempted next server for the next round', async () => {
  let ready = false;
  const f = fixture({ connect: ({ target }) => { if (!ready) throw failure(); return connected(target.server); } });
  assert.equal((await f.run({ retry: { roundTimeoutMs: 100 } })).reason, 'round-timeout');
  ready = true;
  assert.equal((await f.run({ retry: { initialDelayMs: 0 } })).server, 'CA#2');
  assert.deepEqual(f.connects().map(call => call.target.server), ['CA#1', 'CA#2']);
});
test('prerequisite failures retain their candidate until the prerequisite is restored', async () => {
  let ready = false;
  const f = fixture({ connect: ({ target }) => { if (!ready) throw failure('AUTH_REQUIRED'); return connected(target.server); } });
  assert.equal((await f.run()).outcome, 'attention'); assert.equal(f.engine.snapshot().selection.used, 0);
  ready = true;
  assert.equal((await f.run()).server, 'CA#1');
});
test('a small rotating pool ages out recent avoidance and can fall back to its original route after disconnection', async () => {
  const f = fixture({ status: connected('CA#1'), connect: ({ target, state }) => {
    state.status = DISCONNECTED;
    if (target.server === 'CA#2') throw failure();
    return state.status = connected(target.server);
  } });
  const selection = { mode: 'countries', countries: ['CA'], order: 'file-order', recentLimit: 1000 };
  const result = await f.run({ selection, excludeServers: ['CA#1'], recentServers: ['CA#1', 'CA#2'] });
  assert.equal(result.outcome, 'connected'); assert.deepEqual(result.attemptedServers, ['CA#2', 'CA#1']);
  assert.equal(f.engine.snapshot().cooldowns[0].server, 'CA#2');
});
test('the sole permitted server is reused when Proton already reports connected instead of waiting forever to rotate', async () => {
  const f = fixture({ status: connected('CA#1') });
  for (let i = 0; i < 10; i++) assert.equal((await f.run({ selection: { mode: 'servers', servers: ['CA#1'], recentLimit: 1000 }, excludeServers: ['CA#1'] })).server, 'CA#1');
  assert.equal(f.connects().length, 0);
});
test('equivalent pools, recency edits, and returning to a cached order preserve traversal; new catalog objects reset it', async () => {
  const f = fixture();
  assert.equal((await f.run()).server, 'CA#1');
  assert.equal((await f.run({ selection: { order: 'file-order', recentLimit: 999 } })).server, 'CA#2');
  assert.equal((await f.run({ selection: { mode: 'countries', countries: ['CA', 'DE', 'FR'], order: 'file-order' } })).server, 'DE#1');
  await f.run({ selection: { order: 'shuffle' } });
  f.state.status = DISCONNECTED;
  assert.equal((await f.run()).server, 'DE#2'); assert.equal(f.engine.snapshot().cachedPools, 2);
  const reloaded = parseCatalog('Canada,Montreal,CA#1\nCanada,Toronto,CA#2\nGermany,Berlin,DE#1');
  f.state.status = DISCONNECTED;
  assert.equal((await f.run({ catalog: reloaded })).server, 'CA#1'); assert.equal(f.engine.snapshot().cachedPools, 1);
});
test('many edited pools retain only a bounded number of traversal decks', async () => {
  const f = fixture();
  const large = parseCatalog(Array.from({ length: 20 }, (_, i) => `Canada,Montreal,CA#${i + 1}`).join('\n'));
  for (let i = 1; i < 19; i++) {
    f.state.status = DISCONNECTED;
    await f.run({ catalog: large, selection: { mode: 'servers', servers: [`CA#${i}`, `CA#${i + 1}`], order: 'file-order' } });
  }
  assert.equal(f.engine.snapshot().cachedPools, 8);
});

test('retry defaults are independent and invalid settings cannot remove all attempts or invent flags', () => {
  assert.deepEqual(normalizeRetrySettings(), DEFAULT_RETRY_SETTINGS);
  assert.equal(DEFAULT_RETRY_SETTINGS.attemptsPerServer, 1); assert.equal(DEFAULT_RETRY_SETTINGS.maxCandidates, 10);
  assert.equal(DEFAULT_RETRY_SETTINGS.roundTimeoutMs, 300000); assert.equal(DEFAULT_RETRY_SETTINGS.failedServerCooldownMs, 900000);
  for (const input of [null, [], { maxCandidates: 0 }, { attemptsPerServer: 0 }, { maxCandidates: 1001 }, { attemptsPerServer: 11 },
    { attemptTimeoutMs: 0 }, { roundTimeoutMs: NaN }, { roundRetryDelayMs: -1 }, { initialDelayMs: 60001 },
    { failedServerCooldownMs: -1 }, { maxDelayMs: 1.5 }, { protonTimeoutMs: 120000 }]) {
    assert.throws(() => normalizeRetrySettings(input), error => error.code === 'INVALID_RETRY_SETTINGS');
  }
  assert.equal(normalizeRetrySettings({ initialDelayMs: 0, maxDelayMs: 0 }).maxDelayMs, 0);
});
test('a failed first connection moves to another explicit server and succeeds', async () => {
  const f = fixture({ connect: ({ target, state }) => {
    if (target.server === 'CA#1') throw failure();
    return state.status = connected(target.server);
  } });
  const result = await f.run();
  assert.equal(result.outcome, 'connected'); assert.equal(result.status.server.id, 'CA#2'); assert.equal(result.error, null);
  assert.deepEqual(result.attemptedServers, ['CA#1', 'CA#2']); assert.equal(result.attempts, 2);
  assert.deepEqual(f.delays, [1000]); assert.equal(f.clock.pending(), 0); assert.equal(f.engine.snapshot().active, false);
  assert.deepEqual(f.calls.map(call => call.operation), ['status', 'connect', 'status', 'connect']);
  assert.ok(f.connects().every(call => call.options.retryFastest === false && call.options.connectTimeoutMs === 90000));
  assert.equal(f.events.find(event => event.phase === 'attempt-failed').status.state, 'disconnected');
  assert.match(f.events.find(event => event.phase === 'retrying').message, /CA#2.*server 2 of up to 10/);
});
test('generic exit-zero errors retain the command reason and move to a different server automatically', async () => {
  const f = fixture({ connect: ({ target, state }) => {
    if (target.server === 'CA#1') throw failure('COMMAND_FAILED', { exitCode: 0, reason: 'cli-error-output' });
    return state.status = connected(target.server);
  } });
  const result = await f.run();
  assert.equal(result.server, 'CA#2'); assert.deepEqual(result.attemptedServers, ['CA#1', 'CA#2']);
  assert.equal(result.failures[0].operation, 'connect'); assert.equal(result.failures[0].exitCode, 0);
  assert.equal(result.failures[0].reason, 'cli-error-output'); assert.match(result.failures[0].message, /exiting with code 0/);
  assert.equal(result.lastConfirmed.status.server.id, 'CA#2'); assert.equal(result.lastConfirmed.time, f.clock.now());
});
test('status errors schedule a recheck and reconcile a completed connection before making another mutation', async () => {
  const recovery = createRecoveryState(); let failStatus = true;
  const f = fixture({ connect: ({ target, state }) => {
    state.status = connected(target.server); throw failure('COMMAND_FAILED');
  }, getStatus: ({ state, calls }) => {
    if (calls.length > 1 && failStatus) throw failure('COMMAND_FAILED', { operation: 'status', exitCode: 0 });
    return state.status;
  } });
  const first = await f.run({ recovery });
  assert.equal(first.outcome, 'waiting'); assert.equal(first.reason, 'status-unavailable'); assert.ok(first.nextRetryAt > f.clock.now());
  assert.equal(first.error.operation, 'status'); assert.equal(first.lastConfirmed.status.state, 'disconnected');
  failStatus = false; f.clock.advance(first.retryDelayMs);
  assert.equal((await f.run({ recovery })).server, 'CA#1'); assert.equal(f.connects().length, 1);
  assert.equal(recovery.failures, 0);
});
test('backoff survives round limits, is capped, and resets only on a successful connection', async () => {
  const recovery = createRecoveryState(); let ready = false;
  const f = fixture({ connect: ({ target }) => { if (!ready) throw failure(); return connected(target.server); } });
  const retry = { maxCandidates: 1, roundRetryDelayMs: 1, failedServerCooldownMs: 0 };
  const waits = [];
  for (let i = 0; i < 8; i++) {
    const result = await f.run({ retry, recovery }); waits.push(result.retryDelayMs); f.clock.advance(result.retryDelayMs);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000]);
  ready = true; assert.equal((await f.run({ retry, recovery })).outcome, 'connected'); assert.equal(recovery.failures, 0);
  ready = false; assert.equal((await f.run({ retry, recovery })).retryDelayMs, 1000);
  assert.equal(retryDelay(DEFAULT_RETRY_SETTINGS, 50, () => 0.999), 60000);
});
test('a one-server pool waits for its failed-server cooldown then recovers automatically on a later round', async () => {
  let ready = false; const recovery = createRecoveryState();
  const f = fixture({ connect: ({ target }) => { if (!ready) throw failure(); return connected(target.server); } });
  const options = { recovery, selection: { mode: 'servers', servers: ['CA#1'], recentLimit: 0 },
    retry: { initialDelayMs: 0, failedServerCooldownMs: 5000, roundRetryDelayMs: 1 } };
  const first = await f.run(options); assert.equal(first.retryDelayMs, 5000); assert.equal(f.connects().length, 1);
  assert.equal((await f.run(options)).attempts, 0);
  ready = true; f.clock.advance(5000);
  assert.equal((await f.run(options)).outcome, 'connected'); assert.equal(f.connects().length, 2);
});
test('cooldowns outside the selected pool cannot shorten or extend its automatic retry schedule', async () => {
  const f = fixture({ connect: () => { throw failure(); } });
  const run = (server, cooldown) => f.run({ selection: { mode: 'servers', servers: [server], recentLimit: 0 },
    retry: { initialDelayMs: 0, roundRetryDelayMs: 1, failedServerCooldownMs: cooldown } });
  assert.equal((await run('CA#1', 5000)).retryDelayMs, 5000);
  assert.equal((await run('DE#1', 10000)).retryDelayMs, 10000);
  assert.equal((await run('CA#2', 1000)).retryDelayMs, 1000);
});
for (const code of ['SERVER_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT', 'CONNECTION_UNVERIFIED']) {
  test(`${code} with confirmed process closure and disconnection permits failover`, async () => {
    const f = fixture({ connect: ({ target }) => { if (target.server === 'CA#1') throw failure(code); return connected(target.server); } });
    const result = await f.run(); assert.equal(result.outcome, 'connected'); assert.equal(result.attempts, 2);
    if (code === 'TIMEOUT') assert.equal(result.failures[0].deadlineOrigin, 'm3-process');
  });
}
test('additional attempts on one server are configurable and success removes its cooldown', async () => {
  let attempt = 0;
  const f = fixture({ connect: ({ target }) => { if (++attempt === 1) throw failure(); return connected(target.server); } });
  const result = await f.run({ retry: { attemptsPerServer: 2 } });
  assert.equal(result.outcome, 'connected'); assert.equal(result.attempts, 2); assert.deepEqual(result.attemptedServers, ['CA#1']);
  assert.deepEqual(f.connects().map(call => call.target.server), ['CA#1', 'CA#1']); assert.deepEqual(f.engine.snapshot().cooldowns, []);
});
test('exhaustion returns a waiting result with the latest failure instead of throwing or starting another round', async () => {
  const f = fixture({ connect: () => { throw failure('SERVER_UNAVAILABLE'); } });
  const result = await f.run({ retry: { maxCandidates: 2 } });
  assert.equal(result.outcome, 'waiting'); assert.equal(result.reason, 'candidate-limit');
  assert.equal(result.attempts, 2); assert.deepEqual(result.attemptedServers, ['CA#1', 'CA#2']);
  assert.equal(result.error.code, 'SERVER_UNAVAILABLE'); assert.equal(result.nextRetryAt, f.clock.now() + 30000);
  assert.equal(f.clock.pending(), 0); assert.equal(f.connects().length, 2);
});
test('default rounds try up to ten distinct candidates rather than stopping on the first failure', async () => {
  const f = fixture({ connect: () => { throw failure(); } });
  const large = parseCatalog(Array.from({ length: 12 }, (_, i) => `Canada,Montreal,CA#${i + 1}`).join('\n'));
  const result = await f.run({ catalog: large });
  assert.equal(result.outcome, 'waiting'); assert.equal(result.reason, 'candidate-limit'); assert.equal(result.attempts, 10);
  assert.equal(new Set(result.attemptedServers).size, 10); assert.equal(f.connects().length, 10);
});
test('delays escalate between failed attempts and stop at the configured cap', async () => {
  const f = fixture({ connect: () => { throw failure(); } });
  await f.run({ retry: { initialDelayMs: 1000, maxDelayMs: 3000 } });
  assert.deepEqual(f.delays, [1000, 2000, 3000, 3000]);
});
test('failed candidates stay on cooldown across rounds, expire, and can be tried again', async () => {
  const f = fixture({ connect: () => { throw failure(); } });
  const options = { selection: { mode: 'servers', servers: ['CA#1'], recentLimit: 0 }, retry: { failedServerCooldownMs: 100, initialDelayMs: 0 } };
  assert.equal((await f.run(options)).attempts, 1);
  assert.equal((await f.run(options)).attempts, 0); assert.equal(f.connects().length, 1);
  f.clock.advance(100);
  assert.equal(f.engine.snapshot().cooldowns.length, 0);
  assert.equal((await f.run(options)).attempts, 1); assert.equal(f.connects().length, 2);
  assert.equal((await f.run({ ...options, retry: { ...options.retry, failedServerCooldownMs: 0 } })).attempts, 1);
  assert.equal(f.engine.snapshot().cooldowns.length, 0);
});
test('pool filters stay strict while recent avoidance yields to recovery in a small exhausted pool', async () => {
  const f = fixture({ status: connected('CA#1'), connect: () => { throw failure(); } });
  // A failed command must actually report disconnected before another attempt.
  f.state.status = DISCONNECTED;
  const result = await f.run({ selection: { mode: 'countries', countries: ['CA'], order: 'file-order' }, recentServers: ['CA#1'] });
  assert.deepEqual(result.attemptedServers, ['CA#2', 'CA#1']); assert.equal(result.reason, 'pool-exhausted');
  assert.equal((await f.run({ selection: { mode: 'servers', servers: ['CA#999999'] } })).attempts, 0);
  const current = fixture({ status: connected('CA#1') });
  assert.equal((await current.run()).server, 'CA#2');
});
test('opted-in fallback is identified, and exclusions still apply', async () => {
  const f = fixture({ connect: ({ target }) => { if (target.server.startsWith('CA')) throw failure(); return connected(target.server); } });
  const result = await f.run({ selection: { mode: 'countries', countries: ['CA'], order: 'file-order', fallbackToAll: true,
    excludeServers: ['DE#1'] } });
  assert.deepEqual(result.attemptedServers, ['CA#1', 'CA#2', 'DE#2']); assert.equal(result.fallback, true);
});
for (const code of ['AUTH_REQUIRED', 'AUTH_FAILED', 'VPN_2FA_REQUIRED', 'KEYRING_UNAVAILABLE', 'SESSION_UNAVAILABLE',
  'SERVICE_UNAVAILABLE', 'CLI_PERMISSION', 'GUI_CONFLICT', 'PLAN_RESTRICTED', 'CAPABILITY_UNAVAILABLE']) {
  test(`${code} waits for its prerequisite with an automatic recheck instead of cycling servers`, async () => {
    const f = fixture({ connect: () => { throw failure(code); } });
    const result = await f.run();
    assert.equal(result.outcome, 'attention'); assert.equal(result.error.code, code);
    assert.equal(f.connects().length, 1); assert.equal(result.nextRetryAt, f.clock.now() + 30000);
    assert.equal(f.calls.length, 2); assert.equal(f.engine.snapshot().cooldowns.length, 0);
    assert.equal(f.engine.snapshot().progress.server, 'CA#1');
  });
}
test('connected status on the requested server is accepted even when the command exited with a connection error', async () => {
  for (const code of ['CONNECTION_FAILED', 'COMMAND_FAILED']) {
    const f = fixture({ connect: ({ target, state }) => { state.status = connected(target.server); throw failure(code); } });
    const result = await f.run(); assert.equal(result.outcome, 'connected'); assert.equal(result.attempts, 1);
    assert.equal(f.connects().length, 1); assert.equal(f.engine.snapshot().cooldowns.length, 0);
  }
});
test('connected elsewhere or unknown status schedules another status check without forcing a disconnect', async () => {
  for (const status of [connected('DE#2'), { state: 'unknown', server: null }]) {
    const f = fixture({ connect: ({ state }) => { state.status = status; throw failure(); } });
    const result = await f.run(); assert.equal(result.outcome, 'waiting'); assert.equal(f.connects().length, 1);
    assert.ok(result.nextRetryAt > f.clock.now());
    assert.equal(result.error.code, status.state === 'connected' ? 'SERVER_MISMATCH' : 'UNKNOWN_OUTPUT');
  }
});
test('status failures before or after an attempt do not trigger speculative failover', async () => {
  for (const after of [false, true]) {
    const f = fixture({ getStatus: ({ calls }) => {
      if (!after || calls.length > 1) throw failure('SESSION_UNAVAILABLE'); return DISCONNECTED;
    }, connect: () => { throw failure(); } });
    const result = await f.run(); assert.equal(result.outcome, 'attention'); assert.equal(result.error.code, 'SESSION_UNAVAILABLE');
    assert.equal(f.connects().length, after ? 1 : 0);
  }
});
test('a failed or missing termination handshake latches the engine until the unsafe process is addressed', async () => {
  for (const error of [failure('TIMEOUT', { terminationConfirmed: false }), failure('CONNECTION_FAILED', { terminationConfirmed: undefined }), failure('PROCESS_UNCONFIRMED')]) {
    const f = fixture({ connect: () => { throw error; } });
    const first = await f.run(); assert.equal(first.error.code, 'PROCESS_UNCONFIRMED'); assert.equal(first.outcome, 'attention');
    const count = f.calls.length; assert.equal((await f.run()).outcome, 'attention');
    assert.equal(f.calls.length, count); assert.equal(f.engine.snapshot().blocked, true);
  }
});
test('an unconfirmed status process also latches future rounds', async () => {
  const f = fixture({ getStatus: () => { throw failure('TIMEOUT', { terminationConfirmed: false }); } });
  assert.equal((await f.run()).error.code, 'PROCESS_UNCONFIRMED');
  await f.run(); assert.equal(f.calls.length, 1);
});
test('an initial unknown status does not start a connection', async () => {
  const f = fixture({ status: { state: 'unknown', server: null } });
  assert.equal((await f.run()).error.code, 'UNKNOWN_OUTPUT'); assert.equal(f.connects().length, 0);
});
test('round deadline clips the process guard and returns waiting after confirmed command closure', async () => {
  const f = fixture({ connect: ({ clock, options }) => {
    clock.advance(120); assert.equal(options.signal.aborted, true); throw failure('CANCELED');
  } });
  const result = await f.run({ retry: { roundTimeoutMs: 100, attemptTimeoutMs: 1000 } });
  assert.equal(f.connects()[0].options.connectTimeoutMs, 100); assert.equal(result.reason, 'round-timeout');
  assert.equal(result.outcome, 'waiting'); assert.equal(f.connects().length, 1);
  assert.equal(f.clock.pending(), 0); assert.equal(result.status.state, 'unknown');
});
test('round deadline during a backoff never starts the next command', async () => {
  const f = fixture({ connect: () => { throw failure(); } });
  const result = await f.run({ retry: { roundTimeoutMs: 100 } });
  assert.equal(result.reason, 'round-timeout'); assert.deepEqual(f.delays, [100]); assert.equal(f.connects().length, 1);
  assert.deepEqual(result.attemptedServers, ['CA#1']); assert.equal(result.attempts, 1);
});
test('cancellation before a round or during backoff prevents later connection attempts', async () => {
  const pre = new AbortController(); pre.abort(); const a = fixture();
  await assert.rejects(a.run({ signal: pre.signal }), error => error.code === 'CANCELED'); assert.equal(a.calls.length, 0);
  const abort = new AbortController();
  const f = fixture({ connect: () => { throw failure(); }, sleep: async () => { abort.abort(); } });
  await assert.rejects(f.run({ signal: abort.signal }), error => error.code === 'CANCELED');
  assert.equal(f.connects().length, 1); assert.equal(f.clock.pending(), 0);
});
test('cancel or deadline waits for the CLI cleanup promise before releasing serialization', async () => {
  for (const userCancel of [true, false]) {
    let close;
    const abort = new AbortController();
    const f = fixture({ connect: ({ options }) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { close = () => reject(failure('CANCELED')); }, { once: true });
    }) });
    const work = f.run({ signal: abort.signal, retry: { roundTimeoutMs: 100 } });
    await turn();
    if (userCancel) abort.abort(); else f.clock.advance(100);
    assert.equal(typeof close, 'function'); assert.equal(f.engine.snapshot().active, true);
    await assert.rejects(f.run(), error => error.code === 'BUSY'); assert.equal(f.connects().length, 1);
    const completion = userCancel ? assert.rejects(work, error => error.code === 'CANCELED' && error.terminationConfirmed) : work;
    close(); const result = await completion;
    if (!userCancel) assert.equal(result.reason, 'round-timeout');
    assert.equal(f.engine.snapshot().active, false); assert.equal(f.clock.pending(), 0);
  }
});
test('cancellation cannot clear an unconfirmed-process safety latch', async () => {
  const abort = new AbortController();
  const f = fixture({ connect: () => { abort.abort(); throw failure('CANCELED', { terminationConfirmed: false }); } });
  await assert.rejects(f.run({ signal: abort.signal }), error => error.code === 'CANCELED' && error.terminationConfirmed === false);
  assert.equal(f.engine.snapshot().blocked, true); const count = f.calls.length;
  await f.run(); assert.equal(f.calls.length, count);
});
test('the normal backoff timer cancels promptly without starting another connection', async () => {
  const abort = new AbortController(); let connects = 0;
  const engine = createVpnRetryEngine({ adapter: {
    getStatus: async () => DISCONNECTED,
    connect: async () => { connects++; throw failure(); },
  } });
  const work = engine.runRound({ catalog, selection: { order: 'file-order' }, signal: abort.signal,
    retry: { initialDelayMs: 10000 }, onProgress(event) { if (event.phase === 'retrying') setImmediate(() => abort.abort()); } });
  await assert.rejects(work, error => error.code === 'CANCELED');
  assert.equal(connects, 1); assert.equal(engine.snapshot().active, false);
});
test('fresh connected server history can be recorded without any CLI request', async () => {
  const f = fixture(); f.engine.noteConnected('ca#1');
  const result = await f.run({ selection: { order: 'file-order', recentLimit: 1 } });
  assert.equal(result.server, 'CA#2'); assert.deepEqual(f.engine.snapshot().recentServers, ['CA#1', 'CA#2']);
});
test('progress and history separate Proton internal waits from M3 process deadlines and discard raw details', async () => {
  const f = fixture({ connect: () => { throw failure('CONNECTION_FAILED', {
    message: 'private token=abc user@example.com https://mega.nz/key', action: 'private path',
    connection: { timeoutSeconds: 10, secret: 'private' },
  }); } });
  const result = await f.run({ retry: { maxCandidates: 1 } });
  assert.equal(result.failures[0].deadlineOrigin, 'proton-cli'); assert.equal(result.failures[0].protonTimeoutSeconds, 10);
  assert.match(result.failures[0].message, /Proton.*10 seconds/);
  assert.ok(!JSON.stringify([result, f.events, f.engine.snapshot()]).includes('private'));
  const unknown = fixture({ connect: () => { throw new Error('private unclassified error'); } });
  assert.equal((await unknown.run()).error.code, 'PROCESS_UNCONFIRMED');
});
test('observer errors cannot produce overlapping or extra connections', async () => {
  const f = fixture(); assert.equal((await f.run({ onProgress() { throw new Error('observer'); } })).outcome, 'connected');
  assert.equal(f.connects().length, 1); assert.equal(f.engine.snapshot().active, false);
});
test('retry rounds and waits do not make network requests or spawn programs themselves', async t => {
  const deny = () => { throw new Error('Unexpected network or process'); };
  for (const [mod, names] of [[require('node:http'), ['request', 'get']], [require('node:https'), ['request', 'get']],
    [require('node:dns'), ['lookup', 'resolve']], [require('node:child_process'), ['spawn', 'exec', 'execFile']]]) {
    for (const name of names) { const original = mod[name]; mod[name] = deny; t.after(() => { mod[name] = original; }); }
  }
  const original = globalThis.fetch; globalThis.fetch = deny; t.after(() => { globalThis.fetch = original; });
  const f = fixture({ connect: ({ target }) => { if (target.server === 'CA#1') throw failure(); return connected(target.server); } });
  assert.equal((await f.run()).outcome, 'connected');
});
