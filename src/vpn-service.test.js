'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { createNetworkOperations } = require('./network-operations');
const { normalizeVpnSettings } = require('./vpn-settings');
const { normalizeTarget, ProtonVpnError } = require('./protonvpn');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  let config = { theme: { name: 'existing' }, dataDir: '/tmp/m3-data', proxy: 'https://worker.test', ...options.config };
  let status = { state: 'connected', server: { id: 'CH#1', location: 'Switzerland' } };
  const calls = [];
  const capabilities = { commands: { connect: true, disconnect: true, status: true }, selectors: { server: true, country: true, random: true } };
  const adapter = {
    async diagnose() { calls.push('diagnose'); return { ready: true, installed: true, version: '1.0.5', authentication: 'signed-in', status, capabilities, diagnostics: [] }; },
    async inspect() { calls.push('inspect'); return capabilities; },
    async selectPreferredTarget(pool) { return { server: pool.servers.find(id => !pool.excludeServers.includes(id)) }; },
    async getStatus() { calls.push('status'); return status; },
    async connect(target) { calls.push(['connect', target]); status = { ...status, state: 'connected', server: { ...status.server, id: target.server || 'DE#2' } }; return status; },
    async disconnect() { calls.push('disconnect'); status = { state: 'disconnected', server: null }; return status; },
    ...options.adapter,
  };
  const controller = createVpnController({ adapter });
  const service = createVpnService({ controller, adapter, loadConfig: () => structuredClone(config),
    catalogStore: require('../scripts/vpn-test-catalog.cjs'),
    saveConfig: next => { if (options.failWrite) throw new Error('secret filesystem details'); config = structuredClone(next); }, platform: options.platform || 'linux' });
  t.after(() => { service.dispose(); controller.dispose(); });
  return { service, controller, calls, adapter, config: () => config, network: createNetworkOperations(controller) };
}
test('disabled restore is inert and non-Linux surfaces remain unsupported', async t => {
  const a = fixture(t); await a.service.restore(); assert.deepEqual(a.calls, []);
  assert.equal(a.service.snapshot().preferences.enabled, false);
  const b = fixture(t, { platform: 'darwin' }); await b.service.restore(); assert.equal(b.service.snapshot().supported, false);
  assert.equal((await b.service.command({ action: 'connect' })).error.code, 'UNSUPPORTED_PLATFORM'); assert.deepEqual(b.calls, []);
});
test('VPN and application saves preserve unrelated settings and survive a new service restore', async t => {
  const a = fixture(t); await a.service.restore();
  assert.equal((await a.service.saveSettings({ preferredServers: ['de#2'] })).ok, true);
  await a.service.saveApplicationConfig({ defaultTab: 'upload', theme: { name: 'changed' } });
  assert.equal(a.config().dataDir, '/tmp/m3-data'); assert.deepEqual(a.config().vpn.preferredServers, ['DE#2']);
  assert.equal(a.config().defaultTab, 'upload');
  const b = fixture(t, { config: a.config() }); await b.service.restore();
  assert.deepEqual(b.service.snapshot().preferences.preferredServers, ['DE#2']); assert.deepEqual(b.calls, []);
});
test('phase 1 default catalog settings migrate once, while a later explicit All selection survives reload', async t => {
  const { DEFAULT_SELECTION_POLICY } = require('./vpn-catalog');
  const a = fixture(t, { config: { vpn: { preferredServers: ['CH#1'], preferredCountries: ['Germany'],
    serverSelection: structuredClone(DEFAULT_SELECTION_POLICY) } } });
  await a.service.restore();
  assert.equal(a.service.snapshot().preferences.serverSelection.mode, 'mixed');
  assert.equal(a.service.snapshot().preferences.serverSelection.recentLimit, 0);
  await a.service.saveSettings({ serverSelection: structuredClone(DEFAULT_SELECTION_POLICY) });
  assert.equal(a.config().vpn.serverSelectionVersion, 1);
  const b = fixture(t, { config: a.config() }); await b.service.restore();
  assert.equal(b.service.snapshot().preferences.serverSelection.mode, 'all');
  assert.deepEqual(b.service.snapshot().preferences.preferredServers, ['CH#1']); assert.deepEqual(b.calls, []);
});
test('catalog policies persist through service saves and reload without invoking Proton', async t => {
  const a = fixture(t); await a.service.restore();
  const saved = await a.service.saveSettings({ serverSelection: { mode: 'countries', countries: ['Canada'],
    excludeCities: [{ country: 'Canada', city: 'Toronto' }], order: 'shuffle', recentLimit: 2 } });
  assert.equal(saved.ok, true);
  await a.service.saveApplicationConfig({ defaultTab: 'settings' });
  const b = fixture(t, { config: a.config() }); await b.service.restore();
  assert.deepEqual(b.service.snapshot().preferences.serverSelection, saved.state.preferences.serverSelection);
  assert.deepEqual(a.calls, []); assert.deepEqual(b.calls, []);
  const rejected = await b.service.saveSettings({ serverSelection: { fallbackToAll: 'yes' } });
  assert.equal(rejected.error.code, 'INVALID_SETTINGS');
  assert.equal(b.config().vpn.serverSelection.fallbackToAll, false);
});
test('retry settings persist with other preferences and invalid updates preserve the saved values', async t => {
  const a = fixture(t); await a.service.restore();
  const saved = await a.service.saveSettings({ connectionRetry: { maxCandidates: 12, attemptTimeoutMs: 120000,
    roundTimeoutMs: 600000, failedServerCooldownMs: 60000 } });
  assert.equal(saved.ok, true);
  await a.service.saveApplicationConfig({ defaultTab: 'settings' });
  const b = fixture(t, { config: a.config() }); await b.service.restore();
  assert.deepEqual(b.service.snapshot().preferences.connectionRetry, saved.state.preferences.connectionRetry);
  assert.equal((await b.service.saveSettings({ connectionRetry: { maxCandidates: 0 } })).error.code, 'INVALID_SETTINGS');
  assert.equal(b.config().vpn.connectionRetry.maxCandidates, 12);
  assert.deepEqual(a.calls, []); assert.deepEqual(b.calls, []);
});
test('manual activation diagnoses CLI then reuses the existing tunnel without connecting', async t => {
  const a = fixture(t); await a.service.restore();
  assert.equal((await a.service.saveSettings({ enabled: true, required: false })).ok, true);
  assert.equal(a.controller.snapshot().state, 'connected'); assert.equal(a.config().vpn.enabled, true);
  assert.ok(!a.calls.some(Array.isArray));
});
test('missing/signed-out/GUI-blocked setup cannot silently enable control or persist changes', async t => {
  for (const code of ['CLI_MISSING', 'AUTH_REQUIRED', 'GUI_CONFLICT']) {
    const a = fixture(t, { adapter: { async diagnose() { return { ready: false, diagnostics: [{ code }] }; } } });
    const result = await a.service.saveSettings({ enabled: true, required: false });
    assert.equal(result.error.code, code); assert.equal(a.controller.snapshot().state, 'disabled'); assert.equal(a.config().vpn, undefined);
  }
});
test('unverified required mode and incomplete automation cannot be activated through IPC settings', async t => {
  const a = fixture(t);
  const result = await a.service.saveSettings({ enabled: true, required: true });
  assert.equal(result.error.code, 'PROTECTION_UNVERIFIED'); assert.equal(a.controller.snapshot().state, 'disabled');
  assert.equal(a.config().vpn, undefined);
  assert.equal((await a.service.saveSettings({ uploadRecoveryEnabled: true })).ok, true);
});
test('write failure rolls back controller policy before waiting work can run', async t => {
  const a = fixture(t, { failWrite: true });
  const result = await a.service.saveSettings({ enabled: true, required: false });
  assert.equal(result.ok, false); assert.equal(a.controller.snapshot().settings.enabled, false); assert.equal(a.config().vpn, undefined);
  assert.ok(!JSON.stringify(result).includes('secret filesystem'));
});
test('busy changes fail cleanly; unrelated application settings can still save', async t => {
  const a = fixture(t); await a.service.saveSettings({ enabled: true, required: false });
  const lease = await a.controller.acquire({ kind: 'upload' });
  assert.equal((await a.service.saveSettings({ recoveryCooldownMs: 60000 })).error.code, 'BUSY');
  await a.service.saveApplicationConfig({ defaultTab: 'settings' }); assert.equal(a.config().defaultTab, 'settings');
  assert.equal(a.config().vpn.recoveryCooldownMs, 300000); lease.release();
});
test('queued commands return immediately with blockers and are cancelable without connecting', async t => {
  const a = fixture(t); await a.service.saveSettings({ enabled: true, required: false });
  const lease = await a.controller.acquire({ kind: 'browser' });
  const result = await a.service.command({ action: 'connect', target: { server: 'DE#2' } });
  assert.equal(result.ok, true); assert.equal(a.service.snapshot().commands.length, 1);
  assert.equal(a.service.snapshot().controller.activeOperations[0].kind, 'browser');
  assert.equal(a.service.cancelCommand(result.requestId).ok, true); await turn(); lease.release(); await turn();
  assert.ok(!a.calls.some(Array.isArray)); assert.equal(a.service.snapshot().commands.length, 0);
});
test('switch selects a different preferred server and normal commands cannot inject shell arguments', async t => {
  const a = fixture(t); await a.service.saveSettings({ enabled: true, required: false, preferredServers: ['CH#1', 'DE#2'] });
  const result = await a.service.command({ action: 'switch' }); assert.equal(result.ok, true);
  await turn(); await turn(); assert.deepEqual(a.calls.find(Array.isArray), ['connect', { server: 'DE#2' }]);
  assert.equal(Object.hasOwn(a.service.snapshot().controller, 'publicIp'), false);
  assert.equal((await a.service.command({ action: 'connect', target: { server: '--help' } })).ok, false);
});
test('disabling cancels held work and leaves the OS connection unchanged', async t => {
  const a = fixture(t); await a.service.saveSettings({ enabled: true, required: false });
  a.controller.reportTunnelLoss(); let started = false;
  const pending = a.network.run('download', async () => { started = true; });
  const rejected = assert.rejects(pending, error => error.code === 'CANCELED');
  assert.equal((await a.service.saveSettings({ enabled: false })).ok, true); await rejected;
  assert.equal(started, false); assert.ok(!a.calls.includes('disconnect'));
});
test('restoring invalid enabled preferences holds work instead of silently disabling protection', async t => {
  const a = fixture(t, { config: { vpn: { enabled: true, arbitrarySetting: 'invalid' } } });
  await a.service.restore(); assert.equal(a.controller.snapshot().state, 'attention');
  assert.equal(a.service.snapshot().preferences.required, true);
  await assert.rejects(a.controller.acquire(), error => error.code === 'PROTECTION_UNVERIFIED');
});

test('connection diagnostics explain the failed attempt while the command stays queued for retry', async t => {
  const failure = new ProtonVpnError('CONNECTION_FAILED', 'connect', 1);
  failure.message = 'Proton’s fastest available connection timed out after 10 seconds (attempt 2 of 2). Proton reports disconnected.';
  failure.action = 'Command: protonvpn connect. CLI exit code: 1. CLI-selected server: KH#3.';
  failure.connection = { selection: 'fastest available', state: 'disconnected', attempt: 2, maxAttempts: 2, timeoutSeconds: 10, server: 'KH#3' };
  failure.terminationConfirmed = true;
  const a = fixture(t, { adapter: { async connect() { throw failure; }, async getStatus() { return { state: 'disconnected', server: null }; } } });
  await a.service.saveSettings({ enabled: true, required: false, connectionRetry: { maxCandidates: 1 } });
  const command = await a.service.command({ action: 'connect', target: {} }); assert.equal(command.ok, true);
  for (let i = 0; i < 40 && a.controller.snapshot().state !== 'waiting'; i++) await turn();
  const state = a.service.snapshot();
  assert.equal(state.serviceError, null); assert.equal(state.commands.length, 1);
  assert.equal(state.controller.state, 'waiting');
  assert.equal(state.controller.connectionProgress.error.protonTimeoutSeconds, 10);
  assert.equal(state.controller.connectionProgress.error.protonSelectedServer, 'KH#3');
  assert.equal(state.controller.status.state, 'disconnected');
  assert.equal(state.controller.connectionProgress.error.exitCode, 1);
  const entry = state.history.find(item => item.action === 'connection-attempt-failed');
  assert.match(entry.message, /fastest available.*10 seconds.*disconnected/);
  a.service.cancelCommand(command.requestId); await turn();
});
