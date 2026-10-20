'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { createNetworkOperations } = require('./network-operations');
const { normalizeVpnSettings } = require('./vpn-settings');
const { selectPreferredTarget, ProtonVpnError } = require('./protonvpn');
const { parseCSVLine } = require('./utils');
const { classifyRefreshFailure } = require('./account-refresh-result');
const refreshPolicy = require('./account-refresh-policy');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, options = {}) {
  const header = 'Email,Password,Used,Created,Last Login,Status,Security,Custom\n';
  let csv = header + Array.from({ length: options.count || 3 }, (_, i) =>
    `a${i}@example.test,private-password,7,2020-01-01,2021-01-0${i + 1},${options.status ?? 'Active'},No,keep-${i}\n`).join('');
  let config = { inactiveDays: options.inactiveDays ?? 90, dormantRefreshCount: options.dormantRefreshCount ?? 10, toolOrderRefresh: options.order || ['megatools'],
    vpn: normalizeVpnSettings({ enabled: true, required: false, preferredServers: ['CH#1', 'DE#2', 'US#3'],
      refreshMode: 'every-account', connectionRetry: { initialDelayMs: 0, roundRetryDelayMs: 20 }, ...options.vpn }) };
  let route = options.disconnected ? null : 'CH#1', connects = 0;
  const calls = [], events = [], writes = [];
  const capabilities = { commands: { connect: true, status: true }, selectors: { server: true, country: true, random: true } };
  const adapter = {
    async getStatus() {
      if (options.statusError) throw new ProtonVpnError('COMMAND_FAILED', 'status', 0);
      return { state: route ? 'connected' : 'disconnected', server: route ? { id: route } : null };
    },
    async inspect() { return capabilities; },
    async selectPreferredTarget(pool) { return selectPreferredTarget(pool, capabilities); },
    async connect(target) {
      assert.equal(controller.snapshot().activeOperations.length, 0);
      connects++; calls.push({ command: 'connect', target });
      if (options.connectError || options.failConnections > 0) {
        if (options.failConnections) options.failConnections--;
        route = null; const error = new ProtonVpnError('CONNECTION_FAILED'); error.terminationConfirmed = true; throw error;
      }
      route = target.server || (route === 'CH#1' ? 'DE#2' : 'CH#1');
      return this.getStatus();
    },
  };
  const controller = createVpnController({ adapter, ...options.controllerOptions });
  const network = createNetworkOperations(controller);
  const service = createVpnService({ controller, adapter, platform: 'linux', loadConfig: () => config,
    catalogStore: require('../scripts/vpn-test-catalog.cjs'),
    saveConfig: value => { config = value; } });
  t.after(() => { service.dispose(); controller.dispose(); });
  const command = async (tool, args) => {
    network.checkpoint('megacmd-session');
    const lease = controller.snapshot().activeOperations.find(item => item.kind.includes('account') || item.kind === 'security-upgrade');
    calls.push({ command: args[0], tool, route, lease: lease.id });
    await options.probe?.({ tool, args, network, controller, route });
    network.checkpoint();
    if (args[0] === 'df') return options.storageOutput ?? (options.invalidStorage ? 'unknown storage output' : 'Used: ' + (options.usedBytes ?? 128));
    if (args[0] === 'about') return '{"used":128}';
    return 'Root';
  };
  const mocks = {
    './network-operations': network,
    './config': { loadConfig: () => config, getAccountCsv: () => 'accounts.csv' },
    './proc-utils': { runCommandWithTimeout: command },
    './megacmd': { ensureMegaCmdServer: async () => network.checkpoint('megacmd-session'),
      megaSwitch: async (email, password) => command('megacmd', ['login', email, password]), megaCmdBin: () => 'megacmd', megaSpawnOpts: () => ({}),
      parseMegaDf: output => /Used: (\d+)/.test(output) ? { used: Number(output.match(/Used: (\d+)/)[1]) } : null,
      megaLogout: async () => { network.checkpoint('megacmd-session'); calls.push({ command: 'logout', route, lease: controller.snapshot().activeOperations[0].id }); } },
    './rclone': { obscurePass: async () => 'obscured', rcloneRemote: () => 'remote' },
    '../binPath': { getBinPath: name => name },
    fs: { existsSync: () => true, readFileSync: () => csv,
      writeFileSync: (_, value) => { csv = value; writes.push(value); } },
  };
  const filename = path.join(__dirname, 'account-manager.js'), module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    id => Object.hasOwn(mocks, id) ? mocks[id] : require(id.startsWith('.') ? path.resolve(__dirname, id) : id), module, module.exports);
  const accounts = module.exports; accounts.installRefreshVpn(service);
  await service.restore();
  const send = (channel, data) => { events.push({ channel, data }); options.onEvent?.(channel, data); };
  return { accounts, controller, network, service, send, calls, events, writes, connects: () => connects,
    csv: () => csv, rows: () => csv.trim().split('\n').slice(1).map(parseCSVLine),
    done: () => events.findLast(event => event.channel === 'up:refreshDone')?.data,
    setRoute: value => { route = value; }, setCsv: value => { csv = value; } };
}

test('security upgrades use per-account leases and rotate after every five completed accounts', async t => {
  const f = await fixture(t, { count: 12, vpn: { refreshMode: 'batch', refreshBatchSize: 5 } });
  const before = f.rows();
  await f.accounts.upgradeAllInsecure(f.send);
  const done = f.events.filter(e => e.channel === 'up:upgradeAllDone');
  assert.equal(done.length, 1); assert.equal(done[0].data.upgraded, 12); assert.equal(done[0].data.failed, 0);
  assert.equal(done[0].data.error, undefined); assert.equal(f.connects(), 2); assert.equal(f.writes.length, 12);
  const logins = f.calls.filter(c => c.command === 'login');
  assert.equal(new Set(logins.map(c => c.lease)).size, 12);
  assert.deepEqual(logins.map(c => c.route), [...Array(5).fill('CH#1'), ...Array(5).fill('DE#2'), ...Array(2).fill('US#3')]);
  assert.equal(f.calls.filter(c => c.command === 'logout').length, 12);
  f.rows().forEach((row, i) => { const expected = [...before[i]]; expected[6] = 'Yes'; assert.deepEqual(row, expected); });
  assert.equal(f.controller.snapshot().activeOperations.length, 0); assert.equal(f.service.snapshot().refreshing, false);
});

test('security upgrade resumes the same interrupted account without consuming a rotation boundary', async t => {
  let lost = false, f; const emails = [];
  f = await fixture(t, { count: 6, vpn: { refreshMode: 'batch', refreshBatchSize: 5 }, probe: async ({ args }) => {
    if (args[0] === 'login') emails.push(args[1]);
    if (!lost && args[0] === 'ls' && f.writes.length === 1) { lost = true; f.setRoute(null); await f.controller.poll(); }
  } });
  await f.accounts.upgradeAllInsecure(f.send);
  const done = f.events.find(e => e.channel === 'up:upgradeAllDone').data;
  assert.equal(done.upgraded, 6); assert.equal(done.failed, 0); assert.equal(f.writes.length, 6);
  assert.equal(emails.length, 7); assert.equal(emails[1], emails[2]);
  assert.equal(f.connects(), 2); // one repair and the scheduled boundary before account six
});

test('security upgrade cancellation retains completed rows and later recovery cannot restart it', async t => {
  let f, lost = false;
  const options = { count: 3, vpn: { refreshMode: 'batch', refreshBatchSize: 5 }, probe: async ({ args }) => {
    if (!lost && args[0] === 'ls' && f.writes.length === 1) {
      lost = true; options.connectError = true; f.setRoute(null); await f.controller.poll();
    }
  } };
  f = await fixture(t, options); const work = f.accounts.upgradeAllInsecure(f.send);
  for (let i = 0; i < 200 && !f.controller.snapshot().retryWaiting; i++) await turn();
  assert.equal(f.controller.snapshot().retryWaiting, true);
  f.accounts.cancelRefreshAccounts(); await work;
  const done = f.events.filter(e => e.channel === 'up:upgradeAllDone');
  assert.equal(done.length, 1); assert.equal(done[0].data.canceled, true); assert.equal(done[0].data.upgraded, 1);
  assert.deepEqual(f.rows().map(row => row[6]), ['Yes', 'No', 'No']);
  const count = f.calls.length; options.connectError = false; f.setRoute('CH#1');
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.calls.length, count);
});

test('security upgrade does not repeat an upgrade committed before a cleanup interruption', async t => {
  let f, lost = false;
  f = await fixture(t, { count: 2, vpn: { refreshMode: 'batch', refreshBatchSize: 5 }, onEvent: (channel, message) => {
    if (!lost && channel === 'up:refreshLog' && message.includes('Security Upgrade: Yes')) { lost = true; f.setRoute(null); f.controller.reportTunnelLoss(); }
  } });
  await f.accounts.upgradeAllInsecure(f.send);
  assert.equal(f.writes.length, 2); assert.equal(f.calls.filter(c => c.command === 'login').length, 2);
  assert.equal(f.events.find(e => e.channel === 'up:upgradeAllDone').data.upgraded, 2);
});

test('security upgrade preserves quoted fields and skips accounts already upgraded', async t => {
  const f = await fixture(t, { count: 2, vpn: { refreshMode: 'batch', refreshBatchSize: 5 } });
  f.setCsv(f.csv().replace('No,keep-0', 'No,"keep, quoted"').replace('No,keep-1', 'Yes,keep-1'));
  await f.accounts.upgradeAllInsecure(f.send);
  assert.equal(f.writes.length, 1); assert.equal(f.rows()[0][7], 'keep, quoted');
  assert.equal(f.events.find(e => e.channel === 'up:upgradeAllDone').data.total, 1);
});

test('an empty security-upgrade selection completes without acquiring work or changing the route', async t => {
  const f = await fixture(t, { count: 1 });
  f.setCsv(f.csv().split('\n')[0] + '\n');
  await f.accounts.upgradeAllInsecure(f.send);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
  assert.equal(f.service.snapshot().refreshing, false);
  assert.equal(f.events.filter(e => e.channel === 'up:upgradeAllDone').length, 1);
  assert.equal(f.events.find(e => e.channel === 'up:upgradeAllDone').data.total, 0);
});

test('a temporary failed status poll during a probe preserves the account lease and completes without recovery', async t => {
  let checked = false, f;
  const options = { count: 2, vpn: { refreshMode: 'batch', refreshBatchSize: 100 }, probe: async ({ args, network }) => {
    if (checked || args[0] !== 'ls') return; checked = true; options.statusError = true;
    await f.controller.poll(); assert.equal(network.currentSignal().aborted, false); network.checkpoint();
    assert.equal(f.controller.snapshot().state, 'checking'); options.statusError = false;
    await f.controller.poll();
  } };
  f = await fixture(t, options); await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().counts.alive, 2); assert.equal(f.done().counts.vpnErrors, 0); assert.equal(f.connects(), 0); assert.equal(f.writes.length, 2);
});
test('status uncertainty between accounts preserves the group schedule and reuses a recovered connection', async t => {
  let checked = false, f;
  const options = { vpn: { refreshMode: 'batch', refreshBatchSize: 100 }, probe: async ({ args }) => {
    if (checked || args[0] !== 'df') return; checked = true; options.statusError = true; await f.controller.poll();
  }, onEvent: (channel, data) => {
    if (channel === 'up:refreshProgress' && data.current === 2 && data.phase === 'vpn-wait') options.statusError = false;
  } };
  f = await fixture(t, options); await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().total, 3); assert.equal(f.done().counts.alive, 3); assert.equal(f.connects(), 0); assert.equal(f.writes.length, 3);
});
test('a disconnected account probe automatically resumes its same account and retains the original rotation schedule', async t => {
  let lost = false, f; const probes = [];
  f = await fixture(t, { probe: async ({ args }) => {
    if (args[0] !== 'ls') return;
    probes.push(args[args.indexOf('-u') + 1]);
    if (!lost && probes.length === 2) {
      lost = true; assert.equal(f.writes.length, 1); f.setRoute(null); await f.controller.poll();
    }
  } });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().total, 3); assert.equal(f.done().error, undefined); assert.equal(f.done().counts.alive, 3);
  assert.equal(f.done().counts.error, 0); assert.equal(f.done().counts.vpnErrors, 1); assert.equal(f.writes.length, 3);
  assert.equal(probes.length, 4); assert.equal(probes[1], probes[2]);
  assert.deepEqual(f.calls.filter(call => call.command === 'connect').map(call => call.target.server), ['DE#2', 'US#3', 'CH#1']);
  assert.equal(f.events.filter(event => event.channel === 'up:refreshDone').length, 1);
});
test('persistent status uncertainty pauses the probe after grace and resumes automatically without marking an account dead', async t => {
  let time = 0, sequence = 0; const timers = new Map(); let interrupted = false, f;
  const options = { count: 2, vpn: { refreshMode: 'batch', refreshBatchSize: 100 }, controllerOptions: {
    now: () => time, statusGraceMs: 100,
    retryTimers: { setTimeout(fn, ms) { timers.set(++sequence, { fn, at: time + ms }); return sequence; }, clearTimeout(id) { timers.delete(id); } },
  }, probe: async ({ args, network }) => {
    if (interrupted || args[0] !== 'ls') return; interrupted = true; options.statusError = true;
    await f.controller.poll(); assert.equal(network.currentSignal().aborted, false);
    time = 100; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    assert.equal(network.currentSignal().reason.code, 'VPN_STATUS_UNAVAILABLE');
    options.statusError = false; f.setRoute(null);
  } };
  f = await fixture(t, options); await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().counts.alive, 2); assert.equal(f.done().counts.dead, 0); assert.equal(f.done().counts.error, 0);
  assert.equal(f.done().counts.vpnErrors, 1); assert.equal(f.writes.length, 2); assert.equal(f.connects(), 1);
});
test('an interruption after a saved result cannot repeat the completed account or count it twice', async t => {
  let lost = false, f;
  f = await fixture(t, { vpn: { refreshMode: 'batch', refreshBatchSize: 100 }, onEvent: (channel, message) => {
    if (!lost && channel === 'up:refreshLog' && message.includes('→ Active')) {
      lost = true; f.setRoute(null); f.controller.reportTunnelLoss();
    }
  } });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.writes.length, 3); assert.equal(f.done().total, 3); assert.equal(f.done().counts.alive, 3);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 3); assert.equal(f.connects(), 1);
});
test('canceling an interrupted batch cancels its recovery and cannot restart accounts when the VPN later becomes available', async t => {
  let lost = false, f;
  const options = { probe: async ({ args }) => {
    if (!lost && args[0] === 'ls' && f.writes.length === 1) {
      lost = true; options.connectError = true; f.setRoute(null); await f.controller.poll();
    }
  } };
  f = await fixture(t, options); const work = f.accounts.refreshAccounts('all', f.send);
  for (let i = 0; i < 200 && !f.controller.snapshot().retryWaiting; i++) await turn();
  assert.equal(f.controller.snapshot().retryWaiting, true); f.accounts.cancelRefreshAccounts(); await work;
  assert.equal(f.done().canceled, true); assert.equal(f.done().total, 1); assert.equal(f.writes.length, 1);
  const calls = f.calls.length; options.connectError = false; f.setRoute('CH#1'); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.calls.length, calls);
});

test('rotation off, disabled, every-account, and every-N use the intended account boundaries', async t => {
  for (const [vpn, switches] of [[{ refreshMode: 'off' }, 0], [{ enabled: false }, 0], [{}, 4], [{ refreshMode: 'batch', refreshBatchSize: 2 }, 2]]) {
    const f = await fixture(t, { count: 5, vpn });
    await f.accounts.refreshAccounts('all', f.send);
    assert.equal(f.connects(), switches); assert.equal(f.done().total, 5); assert.equal(f.done().error, undefined);
    assert.equal(f.done().counts.alive, 5); assert.ok(f.rows().every(row => row[7].startsWith('keep-')));
    assert.ok(!JSON.stringify(f.events).includes('private-password'));
  }
});

test('header, Accounts IPC and both dormant refresh modes agree on actionable CSV rows', async t => {
  const selected = [];
  const f = await fixture(t, { vpn: { refreshMode: 'off' }, probe: ({ args }) => {
    if (args[0] === 'ls') selected.push(args[args.indexOf('-u') + 1]);
  } });
  const recent = new Date().toISOString();
  const csv = 'Email,Password,Used,Created,Last Login,Status,Security\n' + [
    ['old', 'secret', '2020-01-01', 'Active'],
    ['missing-login', 'secret', '', 'Active'],
    ['invalid-login', 'secret', 'invalid', 'Active'],
    ['blank-status', 'secret', recent, ''],
    ['spaces-status', 'secret', recent, '   '],
    ['unknown-status', '"secret,quoted"', recent, 'Unknown'],
    ['recent', 'secret', recent, 'Active'],
    ['suspended', 'secret', '2020-01-01', 'Suspended'],
    ['terminated', 'secret', '', 'Terminated'],
    ['over-quota', 'secret', 'invalid', 'Over Quota'],
    ['no-password', '', '2020-01-01', 'Active'],
    ['', 'secret', '', 'Active'],
  ].map(([name, password, login, status]) => `${name ? name + '@example.test' : ''},${password},0,2019-01-01,${login},${status},No\n`).join('');
  const expected = ['old', 'missing-login', 'invalid-login', 'blank-status', 'spaces-status', 'unknown-status']
    .map(name => name + '@example.test').sort();
  f.setCsv(csv);
  assert.deepEqual(f.accounts.checkAccountsHealth(), { total: 11, refreshCount: 6, thresholdDays: 90 });

  // Exercise the real Accounts IPC mapping, not a second copy of its rules.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const readerSource = main.slice(main.indexOf("ipcMain.handle('read-accounts-file'"), main.indexOf("ipcMain.handle('read-mediainfo'"));
  let readAccounts;
  vm.runInNewContext(readerSource, { ...refreshPolicy, loadConfig: () => ({}), getAccountCsv: () => 'accounts.csv',
    fs: { existsSync: () => true, readFileSync: () => f.csv() }, ipcMain: { handle: (_, handler) => { readAccounts = handler; } } });
  const displayed = readAccounts();
  assert.deepEqual(Array.from(displayed.filter(a => a.needsRefresh), a => a.email).sort(), expected);
  assert.equal(displayed.find(a => a.email === 'old@example.test').status, 'Dormant');
  assert.equal(displayed.find(a => a.email === 'blank-status@example.test').status, 'Unknown');
  assert.equal(f.csv(), csv); // Reading the UI never normalizes the recorded CSV.

  for (const mode of ['inactive', 'dormantBatch']) {
    selected.length = 0; f.setCsv(csv);
    await f.accounts.refreshAccounts(mode, f.send);
    assert.equal(f.done().error, undefined);
    assert.equal(f.done().planned, 6);
    assert.deepEqual([...selected].sort(), expected);
    assert.equal(f.accounts.checkAccountsHealth().refreshCount, 0);
    assert.equal(readAccounts().some(a => a.needsRefresh), false);
  }
});

test('custom refresh threshold includes the exact cutoff, with missing and invalid dates due immediately', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const account = { email: 'fixture@example.test', password: 'secret', status: 'Active' };
  const due = lastLogin => refreshPolicy.needsAccountRefresh({ ...account, lastLogin }, 30, now);
  assert.equal(due(new Date(now - 30 * 86400000).toISOString()), true);
  assert.equal(due(new Date(now - 30 * 86400000 + 1).toISOString()), false);
  assert.equal(due(new Date(now + 86400000).toISOString()), false);
  assert.equal(due(''), true);
  assert.equal(due('invalid'), true);
  assert.equal(refreshPolicy.refreshThresholdDays({ inactiveDays: 30 }), 30);
  assert.equal(refreshPolicy.refreshThresholdDays({}), 90);
});

test('oldest dormant batch includes unknowns, respects its limit and clears only completed reminders', async t => {
  const selected = [];
  const f = await fixture(t, { dormantRefreshCount: 2, inactiveDays: 30, vpn: { refreshMode: 'off' }, probe: ({ args }) => {
    if (args[0] === 'ls') selected.push(args[args.indexOf('-u') + 1]);
  } });
  f.setCsv('Email,Password,Used,Created,Last Login,Status,Security\n' +
    'unknown@example.test,secret,0,2018-01-01,,,No\n' +
    'old@example.test,secret,0,2019-01-01,2020-01-01,Active,No\n' +
    'newer@example.test,secret,0,2019-01-01,2021-01-01,Active,No\n' +
    'terminated@example.test,secret,0,2010-01-01,,Terminated,No\n');
  assert.equal(f.accounts.checkAccountsHealth().refreshCount, 3);
  assert.equal(f.accounts.checkAccountsHealth().thresholdDays, 30);
  await f.accounts.refreshAccounts('dormantBatch', f.send);
  assert.deepEqual(selected, ['old@example.test', 'unknown@example.test']);
  assert.equal(f.done().total, 2);
  assert.equal(f.accounts.checkAccountsHealth().refreshCount, 1);
});

test('unverified unknown accounts keep their reminder, while an empty log has no accounts', async t => {
  const f = await fixture(t, { count: 1, status: '', vpn: { refreshMode: 'off' },
    probe: () => { throw new Error('TLS connection timed out'); } });
  await f.accounts.refreshAccounts('inactive', f.send);
  assert.equal(f.done().planned, 1);
  assert.equal(f.accounts.checkAccountsHealth().refreshCount, 1);
  assert.equal(f.rows()[0][5], '');
  f.setCsv('Email,Password,Used,Created,Last Login,Status,Security\n');
  assert.deepEqual(f.accounts.checkAccountsHealth(), { total: 0, refreshCount: 0, thresholdDays: 90 });
});

test('a disconnected rotating batch establishes a verified first route before any account probe', async t => {
  const f = await fixture(t, { disconnected: true, count: 1 });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.connects(), 1); assert.equal(f.calls[0].command, 'connect'); assert.equal(f.done().counts.alive, 1);
});

test('fallback, storage checks, and MEGAcmd logout share one lease and route per account', async t => {
  const f = await fixture(t, { count: 2, order: ['megatools', 'megacmd', 'rclone'], probe: ({ tool }) => {
    if (tool === 'megatools') throw new Error('TLS connection timed out');
  } });
  await f.accounts.refreshAccounts('all', f.send);
  const leases = new Map();
  for (const call of f.calls.filter(call => call.lease)) {
    if (!leases.has(call.lease)) leases.set(call.lease, new Set()); leases.get(call.lease).add(call.route);
  }
  assert.equal(leases.size, 2); assert.ok([...leases.values()].every(routes => routes.size === 1));
  assert.equal(f.calls.filter(call => call.command === 'logout').length, 2);
  assert.ok(f.rows().every(row => row[6] === 'Yes')); assert.equal(f.done().counts.alive, 2);
});

test('transport, credential, throttle, and unverified failures preserve status, login and usage', async t => {
  for (const [message, kind] of [['Connection blocked by firewall', 'transport'], ['invalid email or password', 'authentication'],
    ['Too many requests (429)', 'rateLimited'], ['API_ERATELIMIT', 'rateLimited'], ['API_EAGAIN', 'transport'],
    ['tool exited with code 1', 'unverified']]) {
    const f = await fixture(t, { vpn: { refreshMode: 'off' }, probe: () => { throw new Error(message); } });
    const previous = f.csv(); await f.accounts.refreshAccounts('all', f.send);
    assert.equal(f.csv(), previous); assert.equal(f.done().counts[kind], 3); assert.equal(f.done().counts.dead, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('only specific account responses change suspended/terminated badges, never last login', async t => {
  for (const [message, status, counter] of [['Login failed: API_EBLOCKED', 'Suspended', 'suspended'], ['Account has been deleted', 'Terminated', 'dead'],
    ['Storage quota exceeded', 'Over Quota', 'overStorage']]) {
    const f = await fixture(t, { vpn: { refreshMode: 'off' }, probe: () => { throw new Error(message); } });
    await f.accounts.refreshAccounts('all', f.send);
    assert.ok(f.rows().every(row => row[5] === status && row[4].startsWith('2021') && row[2] === '7'));
    assert.equal(f.done().counts[counter], 3);
  }
  assert.equal(classifyRefreshFailure({ df: { message: 'API_EBLOCKED', refreshStage: 'storage' } }).status, undefined);
  assert.equal(classifyRefreshFailure({ ls: new Error('API_EBLOCKED') }).status, undefined);
  assert.equal(classifyRefreshFailure({ login: new Error('resource does not exist (API_ENOENT)') }).status, undefined);
});

test('an incomplete storage probe does not stamp a successful refresh', async t => {
  for (const storageOutput of ['unknown storage output', 'Used: 21.5 GB', 'Used: 23,000,000,000', 'Used: -1']) {
    const f = await fixture(t, { storageOutput, count: 1 }); const original = f.csv();
    await f.accounts.refreshAccounts('all', f.send);
    assert.equal(f.csv(), original); assert.equal(f.done().counts.unverified, 1);
  }
});

test('failed switch and exhausted candidates keep the next account waiting and retain completed results', async t => {
  for (const options of [{ connectError: true }]) {
    const f = await fixture(t, options);
    const work = f.accounts.refreshAccounts('all', f.send);
    for (let i = 0; i < 100 && f.controller.snapshot().state !== 'waiting'; i++) await turn();
    assert.equal(f.controller.snapshot().state, 'waiting'); assert.equal(f.done(), undefined);
    assert.equal(f.rows().filter(row => !row[4].startsWith('2021')).length, 1);
    assert.equal(f.calls.filter(call => call.command === 'ls').length, 1);
    f.accounts.cancelRefreshAccounts(); await work;
    assert.equal(f.done().total, 1); assert.equal(f.done().canceled, true); assert.equal(f.done().counts.vpnErrors, 0);
  }
});
test('a one-server pool reuses its connected route and completes the refresh instead of exhausting itself', async t => {
  const f = await fixture(t, { vpn: { preferredServers: ['CH#1'] } });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().total, 3); assert.equal(f.done().counts.alive, 3); assert.equal(f.done().counts.vpnErrors, 0);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 3);
  assert.equal(f.calls.filter(call => call.command === 'connect').length, 0);
});
test('refresh resumes the same account after one failed candidate without repeating CSV writes or earlier probes', async t => {
  const f = await fixture(t, { failConnections: 1 });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.done().total, 3); assert.equal(f.done().counts.alive, 3); assert.equal(f.done().counts.vpnErrors, 0);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 3);
  assert.equal(f.rows().filter(row => !row[4].startsWith('2021')).length, 3);
  assert.deepEqual(f.calls.filter(call => call.command === 'connect').map(call => call.target.server), ['DE#2', 'US#3', 'CH#1']);
});
test('refresh holds completed CSV rows through round exhaustion, then resumes all remaining accounts after Retry', async t => {
  const options = { connectError: true, vpn: { connectionRetry: { initialDelayMs: 0, roundRetryDelayMs: 1000, failedServerCooldownMs: 0 } } };
  const f = await fixture(t, options), work = f.accounts.refreshAccounts('all', f.send);
  for (let i = 0; i < 100 && f.controller.snapshot().state !== 'waiting'; i++) await turn();
  assert.equal(f.controller.snapshot().state, 'waiting'); assert.equal(f.done(), undefined);
  assert.equal(f.rows().filter(row => !row[4].startsWith('2021')).length, 1);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 1);
  options.connectError = false; assert.equal(f.service.retryConnection().ok, true); await work;
  assert.equal(f.done().total, 3); assert.equal(f.done().counts.alive, 3); assert.equal(f.done().counts.vpnErrors, 0);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 3);
});

test('rotation waits behind a live transfer; cancellation removes it without undoing prior results', async t => {
  const waiting = deferred(); let holding;
  const f = await fixture(t, { onEvent: (channel, data) => {
    if (channel === 'up:refreshProgress' && data.phase === 'vpn-wait') waiting.resolve();
    if (channel === 'up:refreshLog' && data.includes('→ Active')) holding = f.controller.acquire({ kind: 'download' });
  } });
  const work = f.accounts.refreshAccounts('all', f.send);
  await waiting.promise; const lease = await holding;
  assert.equal(f.connects(), 0); assert.equal(f.controller.snapshot().pendingSwitches, 1);
  f.accounts.cancelRefreshAccounts(); await work;
  assert.equal(f.done().canceled, true); assert.equal(f.done().total, 1);
  lease.release(); await turn(); assert.equal(f.connects(), 0);
  assert.equal(f.controller.snapshot().waitingOperations.length, 0);
});

test('a refresh waiting for the shared account session is cancelable and cannot probe later', async t => {
  const f = await fixture(t, { vpn: { refreshMode: 'off' } });
  const lease = await f.controller.acquire({ kind: 'upload', resources: ['megacmd-session'] });
  const work = f.accounts.refreshAccounts('all', f.send); await turn();
  f.accounts.cancelRefreshAccounts(); await work; lease.release(); await turn();
  assert.equal(f.done().canceled, true); assert.equal(f.done().total, 0); assert.equal(f.calls.length, 0);
});

test('single refresh preserves failed login timestamps and canceling one queued row leaves other rows runnable', async t => {
  const f = await fixture(t, { probe: () => { throw new Error('invalid email or password'); } });
  const original = f.csv();
  await f.accounts.refreshSingleAccount('a0@example.test', 'private-password', f.send);
  assert.equal(f.csv(), original);
  const result = f.events.find(event => event.channel === 'up:refreshSingleDone').data;
  assert.equal(result.lastLogin, '2021-01-01'); assert.match(result.error, /Authentication failed/);
  const holding = await f.controller.acquire({ kind: 'upload', resources: ['megacmd-session'] });
  const one = f.accounts.refreshSingleAccount('a1@example.test', 'private-password', f.send);
  const two = f.accounts.refreshSingleAccount('a2@example.test', 'private-password', f.send);
  f.accounts.cancelSingleAccountRefresh('a1@example.test'); await one;
  holding.release(); await two;
  assert.equal(f.events.filter(event => event.channel === 'up:refreshSingleDone').length, 3);
  assert.equal(f.events.find(event => event.data.email === 'a1@example.test').data.canceled, true);
  assert.equal(f.connects(), 0);
});

test('cancellation during an active storage probe stops the batch before committing that row', async t => {
  const entered = deferred(), finish = deferred();
  const f = await fixture(t, { probe: async ({ args, network }) => {
    if (args[0] === 'df') { entered.resolve(); await finish.promise; network.checkpoint(); }
  } });
  const original = f.csv(), work = f.accounts.refreshAccounts('all', f.send);
  await entered.promise; f.accounts.cancelRefreshAccounts(); finish.resolve(); await work;
  assert.equal(f.csv(), original); assert.equal(f.done().canceled, true); assert.equal(f.done().total, 0);
});

test('rotation preferences are frozen for a batch while unrelated application settings remain savable', async t => {
  const f = await fixture(t);
  const plan = f.service.beginRefresh();
  assert.equal((await f.service.saveSettings({ refreshMode: 'off' })).error.code, 'BUSY');
  await f.service.saveApplicationConfig({ defaultTab: 'settings' });
  assert.equal(f.service.snapshot().preferences.refreshMode, 'every-account');
  plan.close(); assert.equal((await f.service.saveSettings({ refreshMode: 'off' })).ok, true);
});

test('selection at the safe boundary excludes the route established by a preceding manual request', async t => {
  const f = await fixture(t);
  const lease = await f.controller.acquire({ kind: 'download' });
  const manual = f.controller.requestSwitch({ target: { server: 'DE#2' } });
  const plan = f.service.beginRefresh(), rotate = plan.beforeAccount(1);
  lease.release(); await manual; await rotate; plan.close();
  assert.deepEqual(f.calls.filter(call => call.command === 'connect').map(call => call.target.server), ['DE#2', 'CH#1']);
});

test('VPN-bound probes cannot use a disconnected manual route, and queued cancellation wins', async t => {
  const f = await fixture(t, { disconnected: true, vpn: { refreshMode: 'off' } });
  const abort = new AbortController(); let ran = false;
  const work = f.network.run('account-refresh', () => { ran = true; }, { requireVpn: true, signal: abort.signal });
  const rejected = assert.rejects(work, error => error.code === 'CANCELED');
  await turn(); assert.equal(ran, false); abort.abort(); await rejected;
  assert.equal(f.controller.snapshot().waitingOperations.length, 0);
});

test('canceling while a later account waits for VPN recovery keeps completed results and prevents a restart', async t => {
  let completed = false, lost = false;
  const f = await fixture(t, { vpn: { refreshMode: 'off' }, onEvent: (channel, data) => {
    if (channel === 'up:refreshLog' && data.includes('→ Active')) completed = true;
  } });
  const unsubscribe = f.controller.onChange(state => {
    if (completed && !lost && !state.activeOperations.length) {
      lost = true; f.controller.reportTunnelLoss();
    }
  });
  t.after(unsubscribe);
  const work = f.accounts.refreshAccounts('all', f.send); await turn();
  assert.equal(f.controller.snapshot().waitingOperations.length, 1);
  f.accounts.cancelRefreshAccounts(); await work;
  await f.controller.poll(true); await turn();
  assert.equal(f.done().canceled, true); assert.equal(f.done().total, 1);
  assert.equal(f.calls.filter(call => call.command === 'ls').length, 1);
  assert.equal(f.rows().filter(row => !row[4].startsWith('2021')).length, 1);
});

test('completed writes preserve quoted passwords and extra CSV fields from the latest row', async t => {
  const f = await fixture(t, { count: 1, vpn: { refreshMode: 'off' } });
  f.setCsv(f.csv().replace('private-password', '"private,password"').replace('keep-0', '"keep, ""quotes"""'));
  await f.accounts.refreshSingleAccount('a0@example.test', 'private,password', f.send);
  assert.equal(f.rows()[0][1], 'private,password'); assert.equal(f.rows()[0][7], 'keep, "quotes"');
  assert.equal(f.rows()[0][5], 'Active');
});

test('a complete over-storage probe records usage and last login with the quota badge', async t => {
  const f = await fixture(t, { count: 1, usedBytes: 23 * 1024 ** 3 });
  await f.accounts.refreshAccounts('all', f.send);
  assert.equal(f.rows()[0][2], '23.0000'); assert.equal(f.rows()[0][5], 'Over Quota');
  assert.ok(!f.rows()[0][4].startsWith('2021')); assert.equal(f.done().counts.overStorage, 1);
});
