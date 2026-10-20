'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCatalogStore } = require('./vpn-catalog-store');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { ProtonVpnError } = require('./protonvpn');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(5); } throw new Error('Control condition timed out'); }
const CSV = 'Switzerland,Zurich,CH#1\nGermany,Berlin,DE#2\nUnited States,Atlanta,US#3\nFrance,Paris,FR#13-TOR,\n';
async function fixture(t, enabled = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-vpn-controls-'));
  const store = createCatalogStore({ directory }), source = path.join(directory, 'source.txt'); fs.writeFileSync(source, CSV);
  let status = { state: 'connected', server: { id: 'CH#1' } }, fail = null, writeFail = false;
  let config = { unrelated: 'preserved', vpn: { enabled, required: false, refreshMode: 'every-account',
    preferredServers: ['CH#1', 'DE#2', 'US#3'], connectionRetry: { initialDelayMs: 0, maxCandidates: 1, failedServerCooldownMs: 0, roundRetryDelayMs: 25 } } };
  const calls = [], caps = { commands: { connect: true, disconnect: true, status: true }, selectors: { server: true, country: true, city: true } };
  const adapter = {
    async inspect() { calls.push('inspect'); return caps; },
    async diagnose() { calls.push('diagnose'); return { ready: true, capabilities: caps, diagnostics: [] }; },
    async getStatus() { calls.push('status'); return structuredClone(status); },
    async connect(target) {
      calls.push(target); status = { state: 'disconnected', server: null };
      if (fail) throw Object.assign(new ProtonVpnError(fail, 'connect', 1), { terminationConfirmed: true });
      return status = { state: 'connected', server: { id: target.server || 'US#3' } };
    },
    async disconnect() { calls.push('disconnect'); return status = { state: 'disconnected', server: null }; },
  };
  const controller = createVpnController({ adapter });
  const service = createVpnService({ controller, adapter, catalogStore: store, platform: 'linux', loadConfig: () => structuredClone(config),
    saveConfig(next) { if (writeFail) throw new Error('secret write failure'); config = structuredClone(next); } });
  t.after(async () => { service.dispose(); controller.dispose(); await sleep(1); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.restore();
  return { directory, source, store, service, controller, calls, config: () => config,
    setStatus: value => { status = value; },
    fail: value => { fail = value; }, writeFail: value => { writeFail = value; },
    connectCount: () => calls.filter(call => typeof call === 'object').length };
}
test('catalog discovery/search/preview are local and inert even with VPN control disabled', async t => {
  const f = await fixture(t);
  assert.equal(f.service.snapshot().catalog, null);
  const result = f.service.getCatalog(); assert.equal(result.ok, true); assert.equal(result.catalog.servers, 16821);
  assert.equal(result.catalog.excludedTor, 7); assert.equal(result.catalog.locations.length, 144);
  assert.equal(f.service.searchCatalog({ query: 'Berlin' }).ok, true);
  const preview = f.service.previewPool({ mode: 'countries', countries: ['Germany'] });
  assert.ok(preview.pool.servers > 0); assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(path.join(f.directory, 'vpn-servers.csv')), false);
});
test('native-file import, reload and reset preserve the source and expose import reports', async t => {
  const f = await fixture(t);
  const imported = f.service.manageCatalog('import', f.source);
  assert.equal(imported.ok, true); assert.equal(imported.catalog.source, 'imported'); assert.equal(imported.catalog.servers, 3);
  assert.equal(imported.catalog.excludedTor, 1); assert.equal(fs.readFileSync(f.source, 'utf8'), CSV);
  assert.equal(f.service.manageCatalog('reload').catalog.servers, 3);
  assert.equal(f.service.manageCatalog('reset').catalog.servers, 16821);
  assert.deepEqual(f.calls, []); assert.equal(fs.readFileSync(f.source, 'utf8'), CSV);
});
test('invalid imports preserve the current catalog, while failed reload invalidates cached records', async t => {
  const f = await fixture(t); f.service.manageCatalog('import', f.source);
  const invalid = path.join(f.directory, 'secret-invalid.txt'); fs.writeFileSync(invalid, 'private invalid text');
  assert.equal(f.service.manageCatalog('import', invalid).ok, false);
  assert.equal(f.service.getCatalog().catalog.servers, 3);
  fs.writeFileSync(path.join(f.directory, 'vpn-servers.csv'), 'broken saved file');
  assert.equal(f.service.manageCatalog('reload').ok, false);
  assert.equal(f.service.getCatalog().ok, false); assert.equal(f.service.searchCatalog({ query: '' }).ok, false);
  assert.equal(f.service.manageCatalog('reset').ok, true); assert.deepEqual(f.calls, []);
});
test('search is bounded, validates input and returns no unrelated data', async t => {
  const f = await fixture(t);
  const search = f.service.searchCatalog({ query: '' }); assert.equal(search.results.length, 100); assert.equal(search.total, 16821);
  assert.deepEqual(Object.keys(search.results[0]).sort(), ['city', 'country', 'id']);
  for (const query of [null, [], { query: 'x'.repeat(101) }, { query: '', file: '/private' }]) assert.equal(f.service.searchCatalog(query).ok, false);
  assert.equal(f.service.previewPool({ mode: 'fastest' }).ok, false); assert.deepEqual(f.calls, []);
});
test('catalog replacement is refused during active workflows and accepted while recovery is held', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source);
  const plan = f.service.beginRefresh();
  assert.equal(f.service.manageCatalog('reset').error.code, 'BUSY');
  f.fail('AUTH_REQUIRED'); const work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.service.manageCatalog('reload').ok, true);
  f.service.cancelCommand(f.service.snapshot().commands[0].id); await assert.rejects(work); plan.close();
});
test('pool editing pauses automatic retry timers; discard resumes the same job', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source); f.fail('CONNECTION_FAILED');
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.service.editWaitingPool('begin').ok, true); const count = f.connectCount();
  await sleep(70); assert.equal(f.connectCount(), count); assert.equal(f.controller.snapshot().poolEditing, true);
  assert.equal(f.controller.snapshot().connectionProgress.nextRetryAt, null);
  f.fail(null); assert.equal(f.service.editWaitingPool('discard').ok, true);
  await work; plan.close(); assert.equal(f.connectCount(), count + 1);
});
test('Apply pool and retry commits the exact selection before the waiting job resumes', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source); f.fail('AUTH_REQUIRED');
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting); f.service.editWaitingPool('begin');
  f.fail(null);
  const result = f.service.changeWaitingPool({ mode: 'servers', servers: ['US#3'], recentLimit: 0 });
  assert.equal(result.ok, true); assert.equal(f.config().unrelated, 'preserved');
  assert.equal(f.config().vpn.serverSelection.mode, 'servers'); assert.deepEqual(f.config().vpn.preferredServers, []);
  await work; plan.close(); assert.equal(f.controller.snapshot().status.server.id, 'US#3');
  assert.equal(f.controller.snapshot().poolEditing, false);
});
test('a failed pool save cannot wake the request or change its selection', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source); f.fail('AUTH_REQUIRED');
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting); f.service.editWaitingPool('begin');
  const old = f.config(); f.writeFail(true);
  const result = f.service.changeWaitingPool({ mode: 'servers', servers: ['US#3'] });
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('secret write'));
  assert.deepEqual(f.config(), old); assert.equal(f.controller.snapshot().poolEditing, true); assert.equal(f.connectCount(), 1);
  f.writeFail(false); f.service.cancelCommand(f.service.snapshot().commands[0].id); await assert.rejects(work); plan.close();
});
test('invalid or unavailable pool changes preserve the waiting job', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source); f.fail('AUTH_REQUIRED');
  const plan = f.service.beginRefresh(), work = plan.beforeAccount(1); work.catch(() => {});
  await until(() => f.controller.snapshot().retryWaiting);
  for (const pool of [null, { mode: 'servers', servers: ['DE#999999'] }, { mode: 'servers', servers: ['--help'] }]) assert.equal(f.service.changeWaitingPool(pool).ok, false);
  assert.equal(f.connectCount(), 1); assert.equal(f.controller.snapshot().retryWaiting, true);
  f.service.cancelCommand(f.service.snapshot().commands[0].id); await assert.rejects(work); plan.close();
});
test('native fastest and catalog Connect are distinct choices', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source);
  assert.equal((await f.service.command({ action: 'connect' })).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.deepEqual(f.calls.find(call => typeof call === 'object'), {});
  assert.equal((await f.service.command({ action: 'connect', usePool: true })).ok, true);
  await until(() => !f.service.snapshot().commands.length);
  assert.ok(f.calls.filter(call => typeof call === 'object')[1].server);
  assert.equal((await f.service.command({ action: 'connect', usePool: 'yes' })).ok, false);
});
test('Cancel can stop a controller-owned automatic reconnect with no manual command entry', async t => {
  const f = await fixture(t, true); f.service.manageCatalog('import', f.source);
  await f.service.saveSettings({ autoRecover: true }); f.fail('AUTH_REQUIRED');
  f.setStatus({ state: 'disconnected', server: null });
  f.controller.reportTunnelLoss(); await until(() => f.controller.snapshot().retryWaiting);
  assert.equal(f.service.snapshot().commands.length, 0);
  assert.equal(f.service.cancelCommand().ok, true); await until(() => !f.controller.snapshot().connectionCommandActive);
  const count = f.connectCount(); await sleep(50); assert.equal(f.connectCount(), count);
});
test('all new control APIs avoid external requests, DNS and shell commands', async t => {
  const deny = () => { throw new Error('Unexpected network or subprocess'); };
  for (const [module, names] of [[require('node:http'), ['request', 'get']], [require('node:https'), ['request', 'get']],
    [require('node:dns'), ['lookup', 'resolve']], [require('node:child_process'), ['spawn', 'exec', 'execFile']]]) {
    for (const name of names) { const original = module[name]; module[name] = deny; t.after(() => { module[name] = original; }); }
  }
  const original = globalThis.fetch; globalThis.fetch = deny; t.after(() => { globalThis.fetch = original; });
  const f = await fixture(t); f.service.getCatalog(); f.service.searchCatalog({ query: 'https://must-not-be-contacted.invalid' });
  f.service.previewPool({ mode: 'countries', countries: ['DE'] }); f.service.manageCatalog('import', f.source);
  f.service.manageCatalog('reload'); f.service.manageCatalog('reset'); assert.deepEqual(f.calls, []);
});
