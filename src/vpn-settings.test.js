'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_VPN_SETTINGS, normalizeVpnSettings, controllerSettings } = require('./vpn-settings');

test('VPN settings have safe independent defaults and normalized preferred pools', () => {
  const a = normalizeVpnSettings(), b = normalizeVpnSettings(); a.preferredServers.push('CH#1');
  assert.equal(b.enabled, false); assert.equal(b.required, true); assert.equal(b.autoRecover, false);
  assert.deepEqual(b.preferredServers, []); assert.deepEqual(DEFAULT_VPN_SETTINGS.preferredServers, []);
  const settings = normalizeVpnSettings({ preferredServers: ['ch#1', 'CH#1', 'de#2'], preferredCountries: ['de', 'DE', 'United States'] });
  assert.deepEqual(settings.preferredServers, ['CH#1', 'DE#2']); assert.deepEqual(settings.preferredCountries, ['DE', 'United States']);
});
test('VPN settings reject malformed values, unknown capabilities, and incomplete automation', () => {
  for (const input of [null, [], { enabled: 'yes' }, { preferredServers: ['--help'] }, { preferredCountries: 'US' },
    { preferredCountries: ['US;echo'] }, { recoveryCooldownMs: -1 }, { maxRecoverySwitches: 0 }, { downloadThresholdBps: NaN },
    { protectionVerified: true }, { refreshMode: 'invalid' }, { uploadRecoveryEnabled: 'yes' }]) {
    assert.throws(() => normalizeVpnSettings(input), error => error.code === 'INVALID_SETTINGS');
  }
});
test('partial saves preserve previous preferences and controller projection contains only supported keys', () => {
  const old = normalizeVpnSettings({ preferredServers: ['CH#1'], downloadThresholdBps: 900000 });
  const next = normalizeVpnSettings({ uploadRecoveryEnabled: true }, old);
  assert.deepEqual(next.preferredServers, ['CH#1']); assert.equal(next.downloadThresholdBps, 900000);
  assert.equal(controllerSettings(next).preferredServers, undefined);
});

test('legacy IP-verification preferences are discarded rather than restoring external checks', () => {
  const current = normalizeVpnSettings({ verifyNewIp: true, enabled: true, required: false });
  assert.equal(Object.hasOwn(current, 'verifyNewIp'), false);
  assert.equal(Object.hasOwn(DEFAULT_VPN_SETTINGS, 'verifyNewIp'), false);
  assert.equal(current.enabled, true);
});

test('catalog policy round-trips, supports partial edits and preserves legacy pools', () => {
  const initial = normalizeVpnSettings({ preferredServers: ['DE#1'], serverSelection: { mode: 'cities',
    cities: [{ country: 'Canada', city: 'London' }], excludeServers: ['ca#2'], order: 'file-order' } });
  const saved = normalizeVpnSettings({ serverSelection: { recentLimit: 3 } }, initial);
  assert.deepEqual(saved.preferredServers, ['DE#1']); assert.equal(saved.serverSelection.mode, 'cities');
  assert.equal(saved.serverSelection.recentLimit, 3); assert.deepEqual(saved.serverSelection.excludeServers, ['CA#2']);
  const restored = normalizeVpnSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored, saved); assert.equal(controllerSettings(saved).serverSelection, undefined);
  saved.serverSelection.cities.push({ country: 'UK', city: 'London' });
  assert.equal(initial.serverSelection.cities.length, 1); assert.deepEqual(normalizeVpnSettings().serverSelection.cities, []);
  assert.throws(() => normalizeVpnSettings({ serverSelection: { order: 'fastest' } }), error => error.code === 'INVALID_SETTINGS');
  assert.throws(() => normalizeVpnSettings({ serverSelection: null }), error => error.code === 'INVALID_SETTINGS');
});

test('retry policy is persistent, independently defaulted and validated on partial saves', () => {
  const initial = normalizeVpnSettings({ connectionRetry: { maxCandidates: 20, attemptTimeoutMs: 120000 } });
  const saved = normalizeVpnSettings({ connectionRetry: { roundTimeoutMs: 600000 } }, initial);
  assert.equal(saved.connectionRetry.maxCandidates, 20); assert.equal(saved.connectionRetry.attemptTimeoutMs, 120000);
  assert.equal(saved.connectionRetry.roundTimeoutMs, 600000);
  assert.equal(initial.connectionRetry.roundTimeoutMs, 300000);
  assert.deepEqual(normalizeVpnSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.equal(normalizeVpnSettings().connectionRetry.maxCandidates, 10);
  assert.equal(normalizeVpnSettings().connectionRetry.initialDelayMs, 1000);
  assert.equal(normalizeVpnSettings().connectionRetry.maxDelayMs, 60000);
  const legacyTiming = normalizeVpnSettings({ connectionRetry: { initialDelayMs: 1500, maxDelayMs: 10000 } });
  assert.equal(legacyTiming.connectionRetry.initialDelayMs, 1500); assert.equal(legacyTiming.connectionRetry.maxDelayMs, 10000);
  assert.equal(controllerSettings(saved).connectionRetry, undefined);
  for (const value of [null, { maxCandidates: 0 }, { initialDelayMs: 60001 }, { timeoutInProton: 120000 }]) {
    assert.throws(() => normalizeVpnSettings({ connectionRetry: value }), error => error.code === 'INVALID_SETTINGS');
  }
});
