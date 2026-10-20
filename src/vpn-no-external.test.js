'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('VPN lifecycle, legacy profiles, polling, rotation and recovery use CLI status without HTTP', async t => {
  let externalAttempts = 0;
  const deny = () => { externalAttempts++; throw new Error('Unexpected external request'); };
  for (const lib of [http, https]) {
    const originalRequest = lib.request, originalGet = lib.get;
    lib.request = deny; lib.get = deny;
    t.after(() => { lib.request = originalRequest; lib.get = originalGet; });
  }
  const originalFetch = globalThis.fetch; globalThis.fetch = deny; t.after(() => { globalThis.fetch = originalFetch; });
  let current = { state: 'connected', server: { id: 'CH#1' } };
  const calls = [], capabilities = { commands: { connect: true, disconnect: true, status: true }, selectors: { server: true, random: true } };
  const adapter = {
    async getStatus() { calls.push('status'); return structuredClone(current); },
    async diagnose() { calls.push('diagnose'); return { ready: true, capabilities, diagnostics: [] }; },
    async inspect() { return capabilities; },
    async selectPreferredTarget(pool) { return { server: pool.servers.find(server => !pool.excludeServers.includes(server)) }; },
    async connect(target) { calls.push('connect'); current = { state: 'connected', server: { id: target.server || 'US#3' } }; return current; },
    async disconnect() { calls.push('disconnect'); current = { state: 'disconnected', server: null }; return current; },
  };
  let config = { proxy: 'https://must-not-be-contacted.invalid', vpn: { enabled: true, required: false,
    verifyNewIp: true, preferredServers: ['CH#1', 'DE#2'], refreshMode: 'every-account', recoveryCooldownMs: 0 } };
  const controller = createVpnController({ adapter });
  const service = createVpnService({ controller, adapter, catalogStore: require('../scripts/vpn-test-catalog.cjs'), platform: 'linux', loadConfig: () => config, saveConfig: value => { config = value; } });
  t.after(() => { service.dispose(); controller.dispose(); });
  await service.restore(); assert.equal(controller.snapshot().state, 'connected');
  await service.diagnose(); await controller.poll(true);
  for (const action of ['connect', 'switch']) {
    assert.equal((await service.command({ action })).ok, true);
    for (let i = 0; i < 40 && service.snapshot().commands.length; i++) await turn();
    assert.equal(service.snapshot().commands.length, 0); assert.equal(controller.snapshot().state, 'connected');
  }
  const refresh = service.beginRefresh(); await refresh.beforeAccount(1); refresh.close();
  const upload = service.beginUpload(); await upload.recover(undefined, 'speed'); upload.close();
  const download = service.beginDownload(); await download.recover(undefined, 'speed'); download.close();
  const lease = await controller.acquire({ kind: 'upload', requireVpn: true }); lease.checkpoint(); lease.release();
  // Editing a Worker URL cannot trigger a VPN/network verification workflow.
  const beforeSave = calls.length; await service.saveApplicationConfig({ proxy: 'invalid Worker, unrelated to VPN state' });
  assert.equal(calls.length, beforeSave); assert.equal(Object.hasOwn(config.vpn, 'verifyNewIp'), false);
  assert.equal((await service.command({ action: 'disconnect' })).ok, true);
  for (let i = 0; i < 40 && service.snapshot().commands.length; i++) await turn();
  assert.equal(controller.snapshot().state, 'disconnected');
  assert.equal(externalAttempts, 0);
  assert.equal(controller.refreshPublicIp, undefined); assert.equal(service.checkPublicIp, undefined);
  assert.equal(Object.hasOwn(controller.snapshot(), 'publicIp'), false);
});
