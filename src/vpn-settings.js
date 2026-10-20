'use strict';

const { normalizeTarget } = require('./protonvpn');
const { normalizeSettings } = require('./vpn-controller');
const { DEFAULT_SELECTION_POLICY, normalizeSelectionPolicy } = require('./vpn-catalog');
const { DEFAULT_RETRY_SETTINGS, normalizeRetrySettings } = require('./vpn-retry');
const DEFAULT_VPN_SETTINGS = {
  ...normalizeSettings(), preferredServers: [], preferredCountries: [],
  // Catalog policy is shared by controls and workflows. Legacy lists remain
  // readable for migration; catalog edits persist an explicit selection.
  serverSelection: structuredClone(DEFAULT_SELECTION_POLICY),
  serverSelectionVersion: 1,
  connectionRetry: { ...DEFAULT_RETRY_SETTINGS },
  refreshMode: 'off', refreshBatchSize: 5,
  downloadRecoveryEnabled: false, downloadThresholdBps: 2000000, downloadDurationMs: 90000,
  uploadRecoveryEnabled: false, uploadThresholdBps: 500000, uploadDurationMs: 120000,
  warmupMs: 30000, averagingMs: 30000,
};
const CONTROLLER_KEYS = Object.keys(normalizeSettings());
class VpnSettingsError extends Error {
  constructor(message) { super(message); this.name = 'VpnSettingsError'; this.code = 'INVALID_SETTINGS'; }
}
function normalizeVpnSettings(input = {}, previous = DEFAULT_VPN_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VpnSettingsError('VPN settings must be an object.');
  const result = { ...structuredClone(DEFAULT_VPN_SETTINGS), ...structuredClone(previous) };
  try { result.serverSelection = normalizeSelectionPolicy(result.serverSelection); }
  catch { throw new VpnSettingsError('Choose valid catalog filters and a supported server order.'); }
  try { result.connectionRetry = normalizeRetrySettings(result.connectionRetry); }
  catch { throw new VpnSettingsError('Choose valid VPN retry limits and durations.'); }
  delete result.verifyNewIp;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'verifyNewIp') continue; // Discard the removed preference in older profiles.
    if (!Object.hasOwn(DEFAULT_VPN_SETTINGS, key)) throw new VpnSettingsError('Unknown VPN setting.');
    if (key === 'connectionRetry') {
      try { result[key] = normalizeRetrySettings(value, result[key]); }
      catch { throw new VpnSettingsError('Choose valid VPN retry limits and durations.'); }
    } else if (key === 'serverSelectionVersion') {
      if (value !== 1) throw new VpnSettingsError('The saved catalog selection version is unsupported.');
      result[key] = value;
    } else if (key === 'serverSelection') {
      try { result[key] = normalizeSelectionPolicy(value, result[key]); }
      catch { throw new VpnSettingsError('Choose valid catalog filters and a supported server order.'); }
    } else if (key === 'preferredServers' || key === 'preferredCountries') {
      if (!Array.isArray(value) || value.length > 100) throw new VpnSettingsError('Use at most 100 preferred servers or countries.');
      const targetKey = key === 'preferredServers' ? 'server' : 'country';
      try { result[key] = [...new Set(value.map(item => normalizeTarget({ [targetKey]: item })[targetKey]))]; }
      catch { throw new VpnSettingsError('Use valid Proton server IDs and country names or codes.'); }
    } else if (typeof DEFAULT_VPN_SETTINGS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new VpnSettingsError('VPN toggles must be on or off.');
      result[key] = value;
    } else if (key === 'refreshMode') {
      if (!['off', 'every-account', 'batch'].includes(value)) throw new VpnSettingsError('Choose a valid account rotation policy.');
      result[key] = value;
    } else {
      const max = key.endsWith('Bps') ? 10000000000 : key === 'refreshBatchSize' ? 1000 : 2147483647;
      if (!Number.isSafeInteger(value) || value < (['recoveryCooldownMs', 'warmupMs'].includes(key) ? 0 : 1) || value > max) {
        throw new VpnSettingsError('VPN thresholds and durations must be within their allowed ranges.');
      }
      result[key] = value;
    }
  }
  try { normalizeSettings(controllerSettings(result)); }
  catch { throw new VpnSettingsError('VPN controller settings are invalid.'); }
  if (!Object.hasOwn(input, 'serverSelection') && (Object.hasOwn(input, 'preferredServers') || Object.hasOwn(input, 'preferredCountries'))) {
    result.serverSelection = legacySelection(result);
  }
  return result;
}
function controllerSettings(settings) { return Object.fromEntries(CONTROLLER_KEYS.map(key => [key, settings[key]])); }
function legacySelection(settings) {
  const servers = settings.preferredServers || [], countries = settings.preferredCountries || [];
  return normalizeSelectionPolicy({ mode: servers.length ? countries.length ? 'mixed' : 'servers' : countries.length ? 'countries' : 'all',
    servers, countries, order: 'file-order', recentLimit: 0 });
}
module.exports = { DEFAULT_VPN_SETTINGS, normalizeVpnSettings, controllerSettings, VpnSettingsError, legacySelection };
