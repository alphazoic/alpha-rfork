'use strict';

const { ProtonVpnError, normalizeTarget, SERVER_DIRECTORY_URL } = require('./protonvpn');
const { VpnControllerError } = require('./vpn-controller');
const { DEFAULT_VPN_SETTINGS, normalizeVpnSettings, controllerSettings, VpnSettingsError, legacySelection } = require('./vpn-settings');
const { DEFAULT_SELECTION_POLICY, parseCatalog, describePool, normalizeSelectionPolicy, VpnCatalogError } = require('./vpn-catalog');
const { BUNDLED_CATALOG } = require('./vpn-catalog-store');
const { readFileSync } = require('node:fs');

function userError(error) {
  if (error instanceof ProtonVpnError || error instanceof VpnControllerError || error instanceof VpnSettingsError || error instanceof VpnCatalogError) {
    return { code: error.code, message: error.message, action: error.action || '',
      ...(error instanceof ProtonVpnError ? { operation: error.operation, exitCode: error.exitCode,
        ...(error.connection ? { connection: structuredClone(error.connection) } : {}) } : {}) };
  }
  return { code: 'SETTINGS_FAILED', message: 'The VPN settings or command could not be completed.', action: '' };
}

function createVpnService({ controller, adapter, loadConfig, saveConfig, catalogStore = null, platform = process.platform, now = Date.now }) {
  let preferences = structuredClone(DEFAULT_VPN_SETTINGS), diagnostics = null, serviceError = null;
  let saving = false, checking = false, stagedConfig = null, sequence = 0, revision = 0, disposed = false;
  const commands = new Map(), listeners = new Set(), history = [], refreshSessions = new Set(), transferSessions = new Set();
  let recoveryTicket = null;
  let bundledCatalog = null;
  let catalogCache = null, catalogSummary = null;
  function readCatalog(reload = false) {
    if (!catalogCache || reload) {
      const loaded = catalogStore ? catalogStore.load() : { catalog: (bundledCatalog ||= parseCatalog(readFileSync(BUNDLED_CATALOG, 'utf8'))), source: 'bundled' };
      setCatalog(loaded);
    }
    return catalogCache;
  }
  function setCatalog({ catalog, source }) {
    catalogCache = catalog;
    const report = catalog.report;
    catalogSummary = { source, servers: report.servers, countries: report.countries, cities: report.cities,
      excludedTor: report.excludedTor.length, duplicateRows: report.duplicateRows.length };
  }
  controller.setConnectionPolicy(() => {
    assertSupported();
    const catalog = readCatalog();
    return { catalog, selection: structuredClone(preferences.serverSelection), retry: { ...preferences.connectionRetry } };
  });
  function snapshot() {
    return {
      revision, supported: platform === 'linux', preferences: structuredClone(preferences),
      controller: controller.snapshot(), diagnostics: diagnostics && structuredClone(diagnostics),
      serviceError, saving, checking,
      catalog: catalogSummary && { ...catalogSummary },
      commands: [...commands.values()].map(command => ({ id: command.id, action: command.action, preparing: command.preparing })),
      history: [...controller.snapshot().history, ...history].sort((a, b) => a.time - b.time).slice(-100),
      serverDirectoryUrl: SERVER_DIRECTORY_URL,
      availability: { refreshRotation: platform === 'linux', downloadRecovery: platform === 'linux', uploadRecovery: platform === 'linux' },
      refreshing: refreshSessions.size > 0,
      transferring: transferSessions.size > 0,
    };
  }
  function emit() { revision++; const state = snapshot(); for (const listener of listeners) listener(state); }
  function record(action, error = null) {
    const { action: help, ...details } = error ? userError(error) : {};
    history.push({ time: now(), action, ...details, ...(help ? { help } : {}) });
    if (history.length > 100) history.shift(); emit();
  }
  const unsubscribe = controller.onChange(emit);
  function assertSupported() {
    if (platform !== 'linux') throw new ProtonVpnError('UNSUPPORTED_PLATFORM');
    if (disposed) throw new VpnControllerError('DISPOSED');
  }
  function assertIdle() {
    if (saving || checking || commands.size || controller.snapshot().connectionCommandActive) throw new VpnControllerError('BUSY');
  }

  async function restore() {
    if (platform !== 'linux') return snapshot();
    try {
      const saved = loadConfig().vpn || {};
      preferences = normalizeVpnSettings(saved);
      if (!saved.serverSelectionVersion && (preferences.preferredServers.length || preferences.preferredCountries.length) &&
          JSON.stringify(preferences.serverSelection) === JSON.stringify(DEFAULT_SELECTION_POLICY)) preferences.serverSelection = legacySelection(preferences);
      if (preferences.enabled) await controller.configure(controllerSettings(preferences));
    } catch (error) {
      serviceError = userError(error);
      if (loadConfig().vpn?.enabled === true) {
        // Invalid enabled policy must not silently resume work on a direct route.
        preferences = { ...structuredClone(DEFAULT_VPN_SETTINGS), enabled: true, required: true };
        await controller.configure(controllerSettings(preferences));
      }
    }
    emit(); return snapshot();
  }

  async function diagnose() {
    assertSupported(); assertIdle(); checking = true; serviceError = null; emit();
    try {
      diagnostics = await adapter.diagnose();
      if (controller.snapshot().settings.enabled && diagnostics.ready) await controller.poll(true);
      record('setup-checked');
      return { ok: true, state: snapshot() };
    } catch (error) {
      serviceError = userError(error); return { ok: false, error: serviceError, state: snapshot() };
    } finally { checking = false; emit(); }
  }

  async function saveApplicationConfig(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new VpnSettingsError('Settings must be an object.');
    if (saving) throw new VpnControllerError('BUSY');
    const previousConfig = loadConfig();
    const nextPreferences = Object.hasOwn(data, 'vpn') ? normalizeVpnSettings(data.vpn, preferences) : preferences;
    if (Object.hasOwn(data, 'vpn') &&
        JSON.stringify([nextPreferences.preferredServers, nextPreferences.preferredCountries]) !== JSON.stringify([preferences.preferredServers, preferences.preferredCountries]) &&
        (!Object.hasOwn(data.vpn, 'serverSelection') || ((nextPreferences.preferredServers.length || nextPreferences.preferredCountries.length) &&
          JSON.stringify(data.vpn.serverSelection) === JSON.stringify(preferences.serverSelection)))) {
      nextPreferences.serverSelection = legacySelection(nextPreferences);
    }
    if (platform !== 'linux' && nextPreferences.enabled) throw new ProtonVpnError('UNSUPPORTED_PLATFORM');
    const runtimeChange = JSON.stringify(controllerSettings(nextPreferences)) !== JSON.stringify(controller.snapshot().settings);
    const proxyChange = Object.hasOwn(data, 'proxy') && data.proxy !== previousConfig.proxy;
    if ((refreshSessions.size || transferSessions.size) && (runtimeChange || proxyChange || JSON.stringify(nextPreferences) !== JSON.stringify(preferences))) {
      throw new VpnControllerError('BUSY');
    }
    if ((runtimeChange || Object.hasOwn(data, 'vpn')) && (checking || commands.size)) throw new VpnControllerError('BUSY');
    saving = true; serviceError = null;
    stagedConfig = { ...previousConfig, ...data, ...((Object.hasOwn(data, 'vpn') || previousConfig.vpn) ? { vpn: nextPreferences } : {}) };
    emit();
    try {
      if (nextPreferences.enabled && !preferences.enabled) {
        diagnostics = await adapter.diagnose();
        if (!diagnostics.ready) {
          const issue = diagnostics.diagnostics[0];
          throw new ProtonVpnError(issue?.code || 'UNKNOWN_OUTPUT', 'inspect');
        }
      }
      const commit = () => {
        if (controller.snapshot().disposed) throw new VpnControllerError('DISPOSED');
        if (nextPreferences.enabled && nextPreferences.required && !controller.snapshot().protectionVerified) {
          throw new VpnControllerError('PROTECTION_UNVERIFIED');
        }
        // Synchronous persistence happens before configuration admits any queued work.
        saveConfig(stagedConfig); preferences = nextPreferences;
      };
      if (!nextPreferences.enabled && preferences.enabled) {
        // Disabling cancels waiting work, never starts it later on a direct route.
        controller.cancelWaitingOperations();
      }
      if (runtimeChange) await controller.configure(controllerSettings(nextPreferences), { commit });
      else commit();
      record('preferences-saved'); return true;
    } catch (error) { serviceError = userError(error); record('settings-failed', error); throw error; }
    finally { saving = false; stagedConfig = null; emit(); }
  }

  async function saveSettings(input) {
    try { await saveApplicationConfig({ vpn: input }); return { ok: true, state: snapshot() }; }
    catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }

  async function command(input) {
    let entry;
    try {
      assertSupported(); assertIdle();
      if (!input || !['connect', 'switch', 'disconnect'].includes(input.action) ||
        Object.keys(input).some(key => !['action', 'target', 'usePool'].includes(key)) ||
        input.usePool !== undefined && typeof input.usePool !== 'boolean') throw new VpnSettingsError('Choose a valid VPN command.');
      if (!controller.snapshot().settings.enabled) throw new VpnControllerError('DISABLED');
      if (input.action === 'disconnect' && (refreshSessions.size || transferSessions.size)) throw new VpnControllerError('DISCONNECT_BUSY');
      entry = { id: ++sequence, action: input.action, preparing: true, abort: new AbortController() };
      commands.set(entry.id, entry); serviceError = null; emit();
      let target = normalizeTarget(input.target || {});
      if (input.action === 'disconnect' && Object.keys(target).length) throw new VpnSettingsError('Disconnect does not accept a server selection.');
      // Discovery belongs to the adapter inside the queued recovery job. A
      // temporary help/status failure must not escape before retries begin.
      if (entry.abort.signal.aborted) throw new VpnControllerError('CANCELED');
      entry.preparing = false;
      const promise = controller.requestSwitch({ action: input.action === 'disconnect' ? 'disconnect' : 'connect', target,
        fastest: input.action === 'connect' && !Object.keys(target).length && !input.usePool,
        signal: entry.abort.signal });
      record('command-queued');
      promise.then(() => {
        record('command-complete');
      }).catch(error => { serviceError = userError(error); record('command-failed', error); })
        .finally(() => { commands.delete(entry.id); emit(); });
      return { ok: true, requestId: entry.id, state: snapshot() };
    } catch (error) {
      if (entry) commands.delete(entry.id);
      serviceError = userError(error); emit(); return { ok: false, error: serviceError, state: snapshot() };
    }
  }

  function cancelCommand(id) {
    if (id === undefined && controller.cancelConnectionRequest()) {
      record('command-canceled'); return { ok: true, state: snapshot() };
    }
    const entry = commands.get(id);
    if (!entry) return { ok: false, error: { code: 'NO_COMMAND', message: 'No matching VPN command is waiting or running.' }, state: snapshot() };
    controller.suppressAutomaticRecovery();
    entry.abort.abort(new VpnControllerError('CANCELED')); record('command-canceled');
    return { ok: true, state: snapshot() };
  }
  function retryConnection(input = {}) {
    try {
      assertSupported();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'selection')) throw new VpnSettingsError('Choose valid connection retry options.');
      if (!controller.retryWaitingSwitch(input)) throw new VpnSettingsError('No VPN request is waiting to retry, or a CLI process still needs attention.');
      return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }
  function catalogEditable() {
    assertSupported();
    const route = controller.snapshot();
    if (saving || checking || (!route.retryWaiting && (commands.size || route.connectionCommandActive || refreshSessions.size || transferSessions.size))) throw new VpnControllerError('BUSY');
  }
  function getCatalog() {
    try {
      assertSupported(); const catalog = readCatalog();
      const locations = describePool(catalog).countries;
      return { ok: true, catalog: { ...catalogSummary, locations }, state: snapshot() };
    } catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }
  function searchCatalog(input = {}) {
    try {
      assertSupported();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'query') ||
          typeof input.query !== 'string' || input.query.length > 100) throw new VpnSettingsError('Use a local catalog search of at most 100 characters.');
      const query = input.query.trim().toLowerCase();
      const matches = readCatalog().records.filter(record => `${record.id} ${record.country} ${record.city}`.toLowerCase().includes(query));
      return { ok: true, total: matches.length, results: matches.slice(0, 100) };
    } catch (error) { return { ok: false, error: userError(error) }; }
  }
  function previewPool(selection) {
    try {
      assertSupported(); const catalog = readCatalog(), pool = describePool(catalog, selection);
      pool.fallbackServers = pool.policy.fallbackToAll && pool.policy.mode !== 'all' ? describePool(catalog, { ...pool.policy, mode: 'all' }).servers - pool.servers : 0;
      return { ok: true, pool };
    }
    catch (error) { return { ok: false, error: userError(error) }; }
  }
  function manageCatalog(action, file) {
    try {
      catalogEditable();
      if (!['reload', 'import', 'reset'].includes(action)) throw new VpnSettingsError('Choose a valid local catalog action.');
      let loaded;
      if (action === 'reload') {
        // A failed reload invalidates the cache; never keep using stale data
        // after the user explicitly asks to read the current saved file.
        catalogCache = null; catalogSummary = null; readCatalog(true);
      } else {
        if (!catalogStore || typeof catalogStore[action === 'import' ? 'importFile' : 'reset'] !== 'function') throw new VpnSettingsError('Local catalog storage is unavailable.');
        loaded = action === 'import' ? catalogStore.importFile(file) : catalogStore.reset(); setCatalog(loaded);
      }
      record('catalog-' + action); return getCatalog();
    } catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }
  function changeWaitingPool(selection) {
    try {
      assertSupported();
      if (saving || checking) throw new VpnControllerError('BUSY');
      selection = normalizeSelectionPolicy(selection);
      if (!describePool(readCatalog(), selection).servers && (!selection.fallbackToAll || !describePool(readCatalog(), { ...selection, mode: 'all' }).servers)) {
        throw new VpnSettingsError('This pool has no catalog servers. Select another pool or import a local list first.');
      }
      const next = normalizeVpnSettings({ serverSelection: selection, preferredServers: [], preferredCountries: [] }, preferences);
      const accepted = controller.retryWaitingSwitch({ selection, commit() {
        saveConfig({ ...loadConfig(), vpn: next }); preferences = next;
      } });
      if (!accepted) throw new VpnSettingsError('The VPN request is no longer waiting, or its CLI process needs attention.');
      serviceError = null; record('waiting-pool-changed'); return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }
  function editWaitingPool(action) {
    try {
      assertSupported();
      if (!['begin', 'discard'].includes(action) || !controller.editWaitingPool(action)) throw new VpnSettingsError('No editable VPN request is waiting.');
      return { ok: true, state: snapshot() };
    } catch (error) { return { ok: false, error: userError(error), state: snapshot() }; }
  }
  function beginRefresh({ signal } = {}) {
    const policy = structuredClone(preferences);
    const rotating = platform === 'linux' && policy.enabled && policy.refreshMode !== 'off';
    const releaseWork = rotating ? controller.retainVpnWork({ signal }) : () => {};
    const token = {}; refreshSessions.add(token); emit();
    return {
      requireVpn: rotating,
      close() { releaseWork(); refreshSessions.delete(token); emit(); },
      async recover({ signal, onWaiting = () => {} } = {}) {
        if (!rotating) return;
        if (signal?.aborted) throw new VpnControllerError('CANCELED');
        const current = controller.snapshot();
        if (current.state === 'connected' && !current.connectionCommandActive && !current.pendingSwitches) return;
        const unwatch = controller.onChange(onWaiting); onWaiting(current);
        try {
          await controller.requestSwitch({ recovery: true, budgeted: false, interruptWork: false,
            reuseCurrent: true, automatic: true, signal });
        } finally { unwatch(); }
      },
      async beforeAccount(index, { signal, onWaiting = () => {} } = {}) {
        if (!rotating) return;
        assertSupported();
        if (signal?.aborted) throw new VpnControllerError('CANCELED');
        const current = controller.snapshot();
        const connected = current.state === 'connected' && current.status.state === 'connected';
        const boundary = index > 0 && (policy.refreshMode === 'every-account' || index % policy.refreshBatchSize === 0);
        if (!boundary && connected) return;
        const entry = { id: ++sequence, action: 'refresh-rotation', preparing: true, abort: new AbortController() };
        const cancel = () => entry.abort.abort(signal.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        commands.set(entry.id, entry); serviceError = null; emit();
        const unwatch = controller.onChange(next => onWaiting(next));
        try {
          onWaiting(controller.snapshot());
          entry.preparing = false;
          record('refresh-rotation-queued');
          await controller.requestSwitch(boundary ? { signal: entry.abort.signal } : {
            signal: entry.abort.signal, recovery: true, budgeted: false, interruptWork: false, reuseCurrent: true, automatic: true,
          });
          if (entry.abort.signal.aborted) throw new VpnControllerError('CANCELED');
          record('refresh-rotation-complete');
        } catch (error) {
          serviceError = userError(error); record('refresh-rotation-failed', error); throw error;
        } finally {
          signal?.removeEventListener('abort', cancel); unwatch(); commands.delete(entry.id); emit();
        }
      },
    };
  }
  function beginDownload(kind = 'download', { signal } = {}) {
    const policy = structuredClone(preferences), token = {};
    const enabled = platform === 'linux' && policy.enabled;
    const releaseWork = kind === 'download' && enabled && (policy.downloadRecoveryEnabled || policy.autoRecover)
      ? controller.retainVpnWork({ signal }) : () => {};
    transferSessions.add(token); emit();
    return {
      policy: { ...policy, enabled },
      state: () => controller.snapshot(),
      close() { releaseWork(); transferSessions.delete(token); emit(); },
      onRouteChange: listener => controller.onChange(listener),
      guard: signal => controller.acquire({ kind: 'download-stream', requireVpn: enabled && (policy.downloadRecoveryEnabled || policy.autoRecover), signal }),
      waitForRoute: async signal => { const lease = await controller.acquire({ kind, requireVpn: true, signal }); lease.release(); },
      recover: (signal, reason, onWaiting, routeGeneration) => recoverTransfer({ signal, reason, onWaiting, routeGeneration, kind }),
    };
  }
  function recoverTransfer({ signal, reason = 'speed', onWaiting = () => {}, routeGeneration, kind = 'download' } = {}) {
    const source = kind === 'upload' ? 'upload' : 'download';
    assertSupported();
    if (signal?.aborted) return Promise.reject(new VpnControllerError('CANCELED'));
    const current = controller.snapshot();
    // An alarm can arrive after another workflow already finished switching.
    // Its measurement belonged to the old connection; reuse the new one.
    if (routeGeneration !== undefined && routeGeneration !== current.connectionGeneration &&
        current.state === 'connected' && current.status.state === 'connected') return Promise.resolve(current);
    // A fast CLI-only reconnect can finish before transport cleanup. Reuse its
    // connected status instead of starting a second recovery for the same loss.
    if (reason === 'loss' && current.state === 'connected' && current.status.state === 'connected') return Promise.resolve(current);
    // The controller's existing tunnel-loss recovery may already own the queue.
    if ((!recoveryTicket || recoveryTicket.abort.signal.aborted) &&
        (current.connectionCommandActive || current.pendingSwitches || current.state === 'recovering')) {
      return (async () => {
        const unwatch = controller.onChange(onWaiting); onWaiting(current);
        try { const lease = await controller.acquire({ kind: source, requireVpn: true, signal }); lease.release(); }
        finally { unwatch(); }
      })();
    }
    if (!recoveryTicket || recoveryTicket.abort.signal.aborted) {
      const ticket = { id: ++sequence, action: 'transfer-recovery', preparing: false, abort: new AbortController(), subscribers: new Set() };
      recoveryTicket = ticket; commands.set(ticket.id, ticket); serviceError = null;
      record(source + (reason === 'speed' ? '-speed-recovery' : '-loss-recovery'));
      const promise = controller.requestSwitch({ recovery: true, budgeted: reason === 'speed', interruptWork: false,
        reuseCurrent: reason === 'loss', automatic: true,
        signal: ticket.abort.signal });
      const settle = (error, result) => {
        ticket.settled = true; ticket.error = error; ticket.result = result;
        if (error) {
          if (error.code === 'RECOVERY_LIMIT' && !ticket.abort.signal.aborted) controller.holdForRecovery(error);
          serviceError = userError(error); record(source + '-recovery-failed', error);
        }
        else record(source + '-recovery-complete');
        for (const subscriber of [...ticket.subscribers]) subscriber.finish(error, result);
        commands.delete(ticket.id); if (recoveryTicket === ticket) recoveryTicket = null; emit();
      };
      promise.then(result => settle(null, result), error => settle(error));
    }
    const ticket = recoveryTicket;
    return new Promise((resolve, reject) => {
      const unwatch = controller.onChange(onWaiting);
      const subscriber = { finish(error, result) {
        signal?.removeEventListener('abort', cancel); unwatch(); ticket.subscribers.delete(subscriber);
        if (error) reject(error); else resolve(result);
      } };
      const cancel = () => {
        subscriber.finish(new VpnControllerError('CANCELED'));
        if (!ticket.subscribers.size && !ticket.settled) ticket.abort.abort(new VpnControllerError('CANCELED'));
      };
      ticket.subscribers.add(subscriber); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      else if (ticket.settled) subscriber.finish(ticket.error, ticket.result);
      else onWaiting(controller.snapshot());
    });
  }
  function dispose() {
    disposed = true; unsubscribe(); for (const entry of commands.values()) entry.abort.abort(); listeners.clear();
  }
  return { restore, snapshot, diagnose, saveSettings, saveApplicationConfig, command, cancelCommand, retryConnection,
    getCatalog, searchCatalog, previewPool, manageCatalog, changeWaitingPool, editWaitingPool, beginRefresh, beginDownload,
    beginUpload: () => beginDownload('upload'), recoverTransfer, dispose,
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
module.exports = { createVpnService, userError };
