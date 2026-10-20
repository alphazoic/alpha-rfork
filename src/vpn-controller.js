'use strict';

const { EventEmitter } = require('events');
const { createProtonVpn, normalizeTarget, ProtonVpnError, toDiagnostic } = require('./protonvpn');
const { createVpnRetryEngine, VpnRetryError, createRecoveryState, retryDelay, normalizeRetrySettings } = require('./vpn-retry');
const { normalizeSelectionPolicy, describePool, VpnCatalogError } = require('./vpn-catalog');

const ERRORS = {
  CANCELED: 'VPN operation canceled.',
  DISPOSED: 'The VPN controller has shut down.',
  DISABLED: 'VPN integration is disabled.',
  BUSY: 'VPN settings cannot change while work or a connection command is active.',
  DISCONNECT_BUSY: 'Stop the active account refresh or transfer before disconnecting Proton VPN.',
  PROTECTION_UNVERIFIED: 'VPN-required mode is unavailable until protection at startup, during switches, and after tunnel loss has been verified.',
  STATUS_UNVERIFIED: 'Proton’s CLI did not confirm a connected VPN.',
  RECOVERY_LIMIT: 'VPN recovery is waiting for the configured speed-switch cooldown or rolling limit.',
  VPN_LOST: 'Proton reports disconnected. Network work is paused for VPN recovery.',
  VPN_STATUS_UNAVAILABLE: 'Proton’s VPN status is temporarily unavailable. Work is waiting for its status to recover.',
  VPN_RECOVERY: 'Network work is paused for VPN recovery.',
  LEASE_INVALID: 'This network operation no longer owns a valid connection lease.',
  RESOURCE_REQUIRED: 'This operation must own the shared MEGAcmd session.',
  VERIFICATION_TIMEOUT: 'VPN verification timed out.',
  COMMAND_FAILED: 'The VPN connection command failed.',
  TRANSPORT_UNCONFIRMED: 'A network transport has not stopped. Connection switching is held until it closes.',
};

class VpnControllerError extends Error {
  constructor(code) {
    super(ERRORS[code] || ERRORS.COMMAND_FAILED);
    this.name = 'VpnControllerError'; this.code = code;
    this.vpnInterrupted = true;
    this.cancelled = code === 'CANCELED' || code === 'DISPOSED';
  }
}

function abortError(signal) {
  return signal?.reason instanceof VpnControllerError ? signal.reason : new VpnControllerError('CANCELED');
}

function safeError(error) {
  // Never forward arbitrary endpoint/tool errors or credentials to history/UI.
  if (error instanceof VpnControllerError) return { code: error.code, message: error.message };
  if (error instanceof ProtonVpnError) return toDiagnostic(error);
  if (error instanceof VpnCatalogError || error instanceof VpnRetryError) return { code: error.code, message: error.message };
  return { code: 'COMMAND_FAILED', message: ERRORS.COMMAND_FAILED };
}

const DEFAULTS = {
  enabled: false, required: true, autoRecover: false, monitorIntervalMs: 5000,
  recoveryCooldownMs: 300000, recoveryWindowMs: 1800000, maxRecoverySwitches: 3,
};

function normalizeSettings(input = {}, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid VPN settings.');
  const settings = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError('Unknown VPN setting.');
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new TypeError('Invalid VPN toggle.');
    } else if (!Number.isSafeInteger(value) || value < (key === 'recoveryCooldownMs' ? 0 : 1) || value > 2147483647) {
      throw new TypeError('Invalid VPN limit.');
    }
    settings[key] = value;
  }
  return settings;
}

function createVpnController({ adapter = createProtonVpn(), verifyProtection = async () => null,
  verificationTimeoutMs = 10000, statusGraceMs = 15000,
  now = Date.now, retryTimers = { setTimeout, clearTimeout }, retryRandom = Math.random,
  retryEngine = createVpnRetryEngine({ adapter, now, random: retryRandom }) } = {}) {
  const events = new EventEmitter();
  let settings = { ...DEFAULTS }, state = 'disabled', disposed = false;
  let status = { state: 'unknown', server: null };
  let protectionVerified = false, lastError = null;
  let activeSwitch = null, pumping = false, pollTimer = null, pollAbort = null, polling = false;
  let connectionProgress = null;
  let connectionPolicy = null;
  let connectionGeneration = 0;
  let lastConfirmed = null;
  let uncertainty = null, graceTimer = null, recoveryNeeded = false, recoverySuppressed = false, automaticRecovery = null;
  const vpnWork = new Set();
  let sequence = 0, configuring = false;
  const leases = new Map(), queue = [], history = [], recoveryTimes = [];
  const outstanding = new Set();
  function connectionRequest() {
    const job = activeSwitch || queue.find(job => job.type === 'switch');
    return job ? { action: job.action, target: { ...job.target }, recovery: job.recovery,
      fastest: job.fastest && !job.fastestAttempted } : null;
  }

  const snapshot = () => ({ state, settings: { ...settings }, status: structuredClone(status),
    protectionVerified, configuring,
    connectionCommandActive: Boolean(activeSwitch), connectionProgress: connectionProgress && structuredClone(connectionProgress),
    connectionRequest: connectionRequest(),
    retryWaiting: Boolean(activeSwitch?.wake), retryBlocked: retryEngine.snapshot().blocked,
    poolEditing: Boolean(activeSwitch?.poolEditing),
    connectionGeneration, lastError: lastError && { ...lastError }, disposed,
    lastConfirmed: structuredClone(lastConfirmed), commandDiagnostics: adapter.getDiagnostics?.() || [],
    statusUncertainty: uncertainty && { ...uncertainty },
    activeOperations: [...leases.values()].map(lease => ({ id: lease.id, kind: lease.kind, resources: [...lease.resources], interrupted: lease.signal.aborted })),
    waitingOperations: queue.filter(job => job.type === 'operation').map(job => ({ kind: job.kind })),
    pendingSwitches: queue.filter(job => job.type === 'switch').length,
    history: history.map(item => ({ ...item })),
  });
  function changed() { events.emit('change', snapshot()); }
  function record(action, error = null) {
    const { action: help, ...details } = error ? safeError(error) : {};
    history.push({ time: now(), action, ...details, ...(help ? { help } : {}) });
    if (history.length > 100) history.shift();
    changed();
  }

  // Bounds verifier callbacks and prevents timed-out callbacks from mutating
  // controller state later. Providers must respect the supplied AbortSignal.
  async function verifiedCall(fn, signal) {
    if (signal?.aborted) throw abortError(signal);
    const controller = new AbortController();
    let timer, listener;
    const aborted = new Promise((_, reject) => {
      listener = () => { controller.abort(signal.reason); reject(abortError(signal)); };
      signal?.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => {
        controller.abort(); reject(new VpnControllerError('VERIFICATION_TIMEOUT'));
      }, verificationTimeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => fn({ signal: controller.signal })), aborted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', listener); }
  }
  async function checkProtection(signal) {
    const evidence = await verifiedCall(verifyProtection, signal);
    protectionVerified = evidence?.verified === true && evidence.startup === true &&
      evidence.switching === true && evidence.tunnelLoss === true;
    if (!protectionVerified) throw new VpnControllerError('PROTECTION_UNVERIFIED');
  }
  async function checkConnection(signal) {
    if (signal?.aborted) throw abortError(signal);
    const current = await adapter.getStatus({ signal });
    if (signal?.aborted) throw abortError(signal);
    if (current.state === 'connected' && status.server?.id && status.server.id !== current.server?.id) connectionGeneration++;
    status = current;
    if (current.state === 'connected' || current.state === 'disconnected') lastConfirmed = { time: now(), status: structuredClone(current) };
    if (current.state !== 'connected') throw new VpnControllerError('STATUS_UNVERIFIED');
    return status;
  }

  function settleSubscriber(job, subscriber, error, result) {
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
    job.subscribers.delete(subscriber);
    if (error) subscriber.reject(error); else subscriber.resolve(result);
  }
  function subscribe(job, signal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const subscriber = { signal, resolve, reject, onAbort: null };
      subscriber.onAbort = () => {
        settleSubscriber(job, subscriber, abortError(signal));
        if (!job.subscribers.size) {
          job.abort.abort(new VpnControllerError('CANCELED'));
          if (!job.started) { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); }
        }
        changed(); updateAutomaticRecovery(); pump();
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener('abort', subscriber.onAbort, { once: true });
      if (signal?.aborted) subscriber.onAbort();
    });
  }
  function completeJob(job, error, result) {
    for (const subscriber of [...job.subscribers]) settleSubscriber(job, subscriber, error, result);
  }
  function canAdmit() {
    if (!settings.enabled) return true;
    if (activeSwitch || configuring) return false;
    if (settings.required) return state === 'connected' && protectionVerified && status.state === 'connected';
    return state === 'connected' || state === 'disconnected';
  }
  function resourcesFree(resources) {
    return [...leases.values()].every(lease => !resources.some(resource => lease.resources.includes(resource)));
  }
  function invalidate(error) {
    for (const lease of leases.values()) lease.abort.abort(error);
  }
  function hasVpnWork() {
    return vpnWork.size > 0 || [...leases.values()].some(lease => (lease.requireVpn || settings.required) && !lease.externalSignal?.aborted) ||
      queue.some(job => job.type === 'operation' && (job.requireVpn || settings.required) && !job.abort.signal.aborted);
  }
  function updateAutomaticRecovery() {
    const wanted = settings.enabled && !disposed && !recoverySuppressed && recoveryNeeded && (settings.autoRecover || hasVpnWork());
    if (!wanted) { automaticRecovery?.abort(); return; }
    if (automaticRecovery && !automaticRecovery.signal.aborted) return;
    const abort = new AbortController(); automaticRecovery = abort;
    const work = requestSwitch({ recovery: true, budgeted: false, interruptWork: false, reuseCurrent: true, automatic: true, signal: abort.signal });
    work.catch(() => {}).finally(() => { if (automaticRecovery === abort) automaticRecovery = null; });
  }
  function suppressAutomaticRecovery() {
    recoverySuppressed = true; automaticRecovery?.abort();
  }
  function retainVpnWork({ signal } = {}) {
    const token = {};
    const close = () => { signal?.removeEventListener('abort', close); vpnWork.delete(token); updateAutomaticRecovery(); };
    if (!disposed && !signal?.aborted) { vpnWork.add(token); signal?.addEventListener('abort', close, { once: true }); updateAutomaticRecovery(); }
    return close;
  }
  function clearUncertainty() {
    retryTimers.clearTimeout(graceTimer); graceTimer = null; uncertainty = null;
  }
  function interruptForStatus() {
    if (!uncertainty || disposed || !settings.enabled) return;
    uncertainty.interrupted = true; recoveryNeeded = true;
    const error = new VpnControllerError('VPN_STATUS_UNAVAILABLE');
    state = 'checking'; lastError = safeError(error);
    if (hasVpnWork() || settings.autoRecover) invalidate(error);
    record('status-unavailable-paused', error); updateAutomaticRecovery();
  }
  function reportStatusUnavailable(error) {
    if (!uncertainty) {
      uncertainty = { since: now(), graceUntil: now() + statusGraceMs, interrupted: false, failures: 0 };
      graceTimer = retryTimers.setTimeout(interruptForStatus, statusGraceMs);
    }
    uncertainty.failures++; uncertainty.nextRetryAt = now() + settings.monitorIntervalMs;
    status = { state: 'unknown', server: null };
    state = 'checking'; lastError = { ...safeError(new VpnControllerError('VPN_STATUS_UNAVAILABLE')), diagnostic: safeError(error) };
    connectionProgress = { phase: 'checking', reason: 'status-unavailable', message: 'Proton status is temporarily unavailable; checking again.',
      nextRetryAt: uncertainty.nextRetryAt, lastConfirmed: structuredClone(lastConfirmed), error: lastError };
    if (now() >= uncertainty.graceUntil && !uncertainty.interrupted) interruptForStatus();
    else record('status-unavailable', error);
  }

  function assertLease(lease, resource = null) {
    if (disposed) throw new VpnControllerError('DISPOSED');
    if (lease.signal.aborted) throw abortError(lease.signal);
    if (!leases.has(lease.id)) throw new VpnControllerError('LEASE_INVALID');
    if (resource && !lease.resources.includes(resource)) throw new VpnControllerError('RESOURCE_REQUIRED');
    const inGrace = state === 'checking' && uncertainty && !uncertainty.interrupted && now() < uncertainty.graceUntil && lastConfirmed?.status.state === 'connected';
    if (inGrace) return;
    if (state === 'checking' && (lease.requireVpn || settings.required)) throw new VpnControllerError('VPN_STATUS_UNAVAILABLE');
    if ((lease.requireVpn && (!settings.enabled || state !== 'connected' || status.state !== 'connected')) ||
        (settings.enabled && settings.required && (!protectionVerified || state !== 'connected' || status.state !== 'connected'))) {
      throw new VpnControllerError('VPN_LOST');
    }
  }

  function acquire({ kind = 'network', resources = [], signal, requireVpn = false } = {}) {
    if (disposed) return Promise.reject(new VpnControllerError('DISPOSED'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (requireVpn && !settings.enabled) return Promise.reject(new VpnControllerError('DISABLED'));
    if (typeof requireVpn !== 'boolean' || !/^[a-z][a-z0-9-]{0,49}$/.test(kind) || !Array.isArray(resources) ||
      resources.some(resource => resource !== 'megacmd-session')) throw new TypeError('Invalid operation lease.');
    if (settings.enabled && settings.required && !protectionVerified) return Promise.reject(new VpnControllerError('PROTECTION_UNVERIFIED'));
    const job = { type: 'operation', kind, requireVpn, resources: [...new Set(resources)], abort: new AbortController(), subscribers: new Set(), started: false };
    queue.push(job);
    const promise = subscribe(job, signal);
    changed(); updateAutomaticRecovery(); pump();
    return promise;
  }

  function release(lease) {
    if (!leases.delete(lease.id)) return;
    lease.externalSignal?.removeEventListener('abort', lease.externalAbort);
    changed(); updateAutomaticRecovery(); pump();
  }

  function requestSwitch({ action = 'connect', target = {}, recovery = false, budgeted = recovery, fastest = false,
    interruptWork = recovery, signal, selectTarget = null, reuseCurrent = false, automatic = false } = {}) {
    if (disposed) return Promise.reject(new VpnControllerError('DISPOSED'));
    if (!settings.enabled) return Promise.reject(new VpnControllerError('DISABLED'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (!['connect', 'disconnect'].includes(action) || [recovery, budgeted, fastest, interruptWork, reuseCurrent, automatic].some(value => typeof value !== 'boolean')) {
      throw new TypeError('Invalid connection request.');
    }
    target = normalizeTarget(target);
    if (action === 'disconnect' && (recovery || Object.keys(target).length)) throw new TypeError('Invalid disconnect request.');
    if (settings.required && !protectionVerified) return Promise.reject(new VpnControllerError('PROTECTION_UNVERIFIED'));
    if (selectTarget !== null && (typeof selectTarget !== 'function' || action !== 'connect')) throw new TypeError('Invalid target provider.');
    if (!automatic) {
      if (action === 'disconnect') suppressAutomaticRecovery();
      else recoverySuppressed = false;
    }
    const key = JSON.stringify([action, target.server || null, target.country || null, target.city || null, Boolean(target.random), recovery,
      selectTarget ? ++sequence : null, interruptWork, budgeted, fastest, reuseCurrent]);
    let job = [activeSwitch, ...queue].find(item => item?.type === 'switch' && item.key === key && !item.abort.signal.aborted);
    if (!job) {
      job = { type: 'switch', key, action, target, selectTarget, recovery, budgeted, fastest, reuseCurrent,
        abort: new AbortController(), subscribers: new Set(), started: false };
      if (recovery && interruptWork) {
        queue.unshift(job);
        state = 'recovering';
        invalidate(new VpnControllerError('VPN_RECOVERY'));
      } else queue.push(job);
    }
    const promise = subscribe(job, signal);
    changed(); pump();
    return promise;
  }

  function setConnectionPolicy(provider) {
    if (activeSwitch || queue.some(job => job.type === 'switch')) throw new VpnControllerError('BUSY');
    if (typeof provider !== 'function') throw new TypeError('A local connection policy provider is required.');
    connectionPolicy = provider;
  }
  function retryWaitingSwitch({ selection, commit } = {}) {
    const job = activeSwitch;
    if (!job?.wake || retryEngine.snapshot().blocked) return false;
    const nextSelection = selection ? normalizeSelectionPolicy(selection) : null;
    commit?.();
    if (nextSelection) {
      job.selectionOverride = nextSelection;
      job.excludeServers = []; job.initialStatusCaptured = false;
      if (job.recoveryState) job.recoveryState.pending = null;
    }
    if (job.recoveryState) job.recoveryState.nextAttemptAt = 0;
    job.wake(); return true;
  }
  function cancelConnectionRequest() {
    const job = activeSwitch || queue.find(item => item.type === 'switch');
    if (!job) return false;
    suppressAutomaticRecovery();
    const error = new VpnControllerError('CANCELED'); job.abort.abort(error);
    if (!job.started) { queue.splice(queue.indexOf(job), 1); completeJob(job, error); }
    changed(); pump(); return true;
  }
  function editWaitingPool(action) {
    const job = activeSwitch;
    if (!job?.wake || retryEngine.snapshot().blocked || !['begin', 'discard'].includes(action)) return false;
    if (action === 'begin' && !job.poolEditing) {
      job.poolEditing = true; job.savedProgress = structuredClone(connectionProgress); job.pauseWait();
      connectionProgress = { ...connectionProgress, nextRetryAt: null, message: 'Automatic retries are paused while you edit the waiting pool. Apply the pool or discard edits to continue.' };
    } else if (action === 'discard' && job.poolEditing) {
      job.poolEditing = false; connectionProgress = job.savedProgress;
      if (job.retryDelay !== null) connectionProgress.nextRetryAt = now() + job.retryDelay;
      job.scheduleWait();
    }
    changed(); return true;
  }
  function waitForRound(job, delay) {
    return new Promise(resolve => {
      let timer;
      const wake = () => {
        retryTimers.clearTimeout(timer); job.abort.signal.removeEventListener('abort', wake);
        job.wake = null; job.pauseWait = null; job.scheduleWait = null; job.poolEditing = false; resolve();
      };
      job.wake = wake;
      job.retryDelay = delay;
      job.pauseWait = () => { retryTimers.clearTimeout(timer); timer = null; };
      job.scheduleWait = () => { retryTimers.clearTimeout(timer); if (delay !== null) timer = retryTimers.setTimeout(wake, Math.max(0, delay)); };
      job.abort.signal.addEventListener('abort', wake, { once: true });
      job.scheduleWait();
      if (job.abort.signal.aborted) wake();
      changed();
    });
  }
  function progressChanged(job, progress) {
    if (job.abort.signal.aborted || disposed) return;
    connectionProgress = structuredClone(progress);
    if (progress.status) status = structuredClone(progress.status);
    if (progress.lastConfirmed) lastConfirmed = structuredClone(progress.lastConfirmed);
    if (job.fastest && progress.phase === 'connecting' && !progress.server) job.fastestAttempted = true;
    if (progress.phase === 'status' && !job.initialStatusCaptured) {
      job.initialStatusCaptured = true;
      if (progress.status.server?.id && !job.excludeServers.includes(progress.status.server.id)) job.excludeServers.push(progress.status.server.id);
    }
    if (progress.phase === 'connecting' || progress.phase === 'retrying') {
      state = job.recovery ? 'recovering' : 'switching'; lastError = null;
    }
    if (['attempt-failed', 'retrying', 'diagnostic'].includes(progress.phase)) {
      const { action: help, ...details } = progress.error || {};
      history.push({ time: now(), action: 'connection-' + progress.phase, ...details, help, message: progress.message,
        server: progress.server, lastConfirmed: structuredClone(lastConfirmed) });
      if (history.length > 100) history.shift();
    }
    changed();
  }
  async function connectWithRetries(job) {
    let round = 0;
    job.recoveryState = createRecoveryState(); job.recoveryState.lastConfirmed = structuredClone(lastConfirmed);
    job.excludeServers = status.server?.id ? [status.server.id] : [];
    while (true) {
      if (job.abort.signal.aborted || disposed) throw abortError(job.abort.signal);
      let result, policy;
      try {
        policy = await connectionPolicy();
        let selection = job.selectionOverride || policy.selection;
        if (!job.selectionOverride && job.target.server) selection = { ...selection, mode: 'servers', servers: [job.target.server], recentLimit: 0 };
        else if (!job.selectionOverride && job.target.country) selection = job.target.city
          ? { ...selection, mode: 'cities', cities: [{ country: job.target.country, city: job.target.city }] }
          : { ...selection, mode: 'countries', countries: [job.target.country] };
        else if (!job.selectionOverride && job.target.city) selection = { ...selection, mode: 'servers', servers: policy.catalog.records
          .filter(server => server.city.toLowerCase() === job.target.city.toLowerCase()).map(server => server.id) };
        if (!job.policy) job.policy = { retry: policy.retry };
        if (!(job.fastest && !job.fastestAttempted) && describePool(policy.catalog, selection).servers === 0 &&
            (!selection.fallbackToAll || describePool(policy.catalog, { ...selection, mode: 'all' }).servers === 0)) {
          throw new VpnCatalogError('NO_CANDIDATES', 'The selected VPN pool contains no catalog servers. Change the pool or import an updated local list.');
        }
        result = await retryEngine.runRound({ catalog: policy.catalog, selection, retry: job.policy.retry,
          excludeServers: job.excludeServers,
          reuseServer: !job.selectionOverride ? job.target.server || null : null,
          reuseCurrent: job.reuseCurrent,
          initialFastest: job.fastest && !job.fastestAttempted, recovery: job.recoveryState, signal: job.abort.signal,
          onProgress: progress => progressChanged(job, { ...progress, round: round + 1 }) });
      } catch (error) {
        if (job.abort.signal.aborted || disposed || error.code === 'CANCELED') throw error;
        const retry = normalizeRetrySettings(job.policy?.retry);
        job.recoveryState.failures = Math.min(1000000, job.recoveryState.failures + 1);
        const delay = Math.max(30000, retry.roundRetryDelayMs, retryDelay(retry, job.recoveryState.failures, retryRandom));
        result = { outcome: 'attention', reason: 'prerequisite-unavailable', status: structuredClone(status), error: safeError(error), retryDelayMs: delay };
      }
      if (job.abort.signal.aborted || disposed) throw abortError(job.abort.signal);
      status = result.status;
      if (result.lastConfirmed) lastConfirmed = structuredClone(result.lastConfirmed);
      if (result.outcome === 'connected') return;
      state = result.outcome === 'waiting' ? 'waiting' : 'attention';
      lastError = result.error;
      const delay = result.retryDelayMs ?? normalizeRetrySettings(job.policy?.retry).roundRetryDelayMs;
      const detail = result.error?.message || 'No eligible connection was established in this round.';
      const exhausted = ['candidate-limit', 'pool-exhausted'].includes(result.reason) ? 'VPN candidates are exhausted for this round. ' : '';
      const message = `${exhausted}${detail} Work is paused; automatically ${result.reason === 'process-unconfirmed' ? 'checking for CLI process closure' : 'retrying'} in ${Math.ceil(delay / 1000)} seconds.`;
      connectionProgress = { ...(connectionProgress || {}), phase: state, round: round + 1, status,
        message, error: result.error, reason: result.reason, lastConfirmed: structuredClone(lastConfirmed), nextRetryAt: now() + delay };
      const { action: help, ...details } = result.error || {};
      history.push({ time: now(), action: 'connection-' + state, ...details, help, message,
        nextRetryAt: connectionProgress.nextRetryAt, lastConfirmed: structuredClone(lastConfirmed) });
      if (history.length > 100) history.shift();
      await waitForRound(job, delay); round++;
    }
  }

  async function performSwitch(job) {
    const signal = job.abort.signal;
    try {
      clearUncertainty();
      if (job.action === 'disconnect' && retryEngine.snapshot().blocked) throw new ProtonVpnError('PROCESS_UNCONFIRMED', 'disconnect');
      if (settings.required) await checkProtection(signal);
      if (job.selectTarget) {
        // Resolve preferred candidates only after incompatible leases and prior
        // switches have finished. This excludes the actual current server.
        status = await adapter.getStatus({ signal });
        job.target = normalizeTarget(await job.selectTarget(snapshot(), { signal }));
        if (signal.aborted) throw abortError(signal);
      }
      if (job.budgeted) {
        while (true) {
          while (recoveryTimes.length && recoveryTimes[0] <= now() - settings.recoveryWindowMs) recoveryTimes.shift();
          const latest = recoveryTimes.at(-1);
          const allowedAt = Math.max(now(), latest === undefined ? 0 : latest + settings.recoveryCooldownMs,
            recoveryTimes.length < settings.maxRecoverySwitches ? 0 : recoveryTimes[recoveryTimes.length - settings.maxRecoverySwitches] + settings.recoveryWindowMs);
          if (allowedAt <= now()) break;
          state = 'waiting'; lastError = safeError(new VpnControllerError('RECOVERY_LIMIT'));
          connectionProgress = { phase: 'waiting', reason: 'speed-switch-limit', nextRetryAt: allowedAt, error: lastError,
            message: `Speed recovery is waiting for its configured limit; automatically retrying in ${Math.ceil((allowedAt - now()) / 1000)} seconds.` };
          changed(); await waitForRound(job, allowedAt - now());
          if (signal.aborted || disposed) throw abortError(signal);
        }
      }
      if (signal.aborted) throw abortError(signal);
      if (job.budgeted) recoveryTimes.push(now()); // One trigger, regardless of candidates/rounds.
      state = job.recovery ? 'recovering' : job.action === 'disconnect' || status.state === 'connected' ? 'switching' : 'connecting';
      lastError = null;
      changed();
      if (job.action === 'disconnect') {
        status = await adapter.disconnect({ signal });
        if (status.state !== 'disconnected') throw new VpnControllerError('STATUS_UNVERIFIED');
        lastConfirmed = { time: now(), status: structuredClone(status) };
        state = 'disconnected';
      } else {
        if (connectionPolicy) await connectWithRetries(job);
        else {
          await adapter.connect(job.target, { signal, retryFastest: !job.recovery, onProgress: progress => {
          if (signal.aborted || disposed) return;
          connectionProgress = { ...progress };
          if (progress.phase === 'retrying') {
            history.push({ time: now(), action: 'connection-retrying', message: progress.message });
            if (history.length > 100) history.shift();
          }
          changed();
          } });
          await checkConnection(signal);
        }
        if (settings.required) await checkProtection(signal);
        state = 'connected';
      }
      if (signal.aborted || disposed) throw abortError(signal);
      connectionGeneration++;
      recoveryNeeded = false;
      lastError = null; record(job.recovery ? 'recovered' : job.action);
      completeJob(job, null, snapshot());
    } catch (error) {
      state = disposed ? 'disabled' : 'attention';
      if (error?.name === 'ProtonVpnError' && ['connected', 'disconnected', 'unknown'].includes(error.connection?.state)) {
        status = { state: error.connection.state, server: null };
      }
      lastError = safeError(error); record('connection-failed', error);
      completeJob(job, error);
    } finally { activeSwitch = null; connectionProgress = null; changed(); }
  }

  async function pump() {
    if (pumping || disposed || configuring || polling) return;
    pumping = true;
    try {
      while (queue.length && !disposed) {
        const barrier = queue.findIndex(job => job.type === 'switch');
        if (barrier >= 0 && (barrier === 0 || !canAdmit())) {
          if (leases.size || activeSwitch) break;
          const job = queue.splice(barrier, 1)[0]; job.started = true; activeSwitch = job;
          await performSwitch(job); continue;
        }
        if (!canAdmit()) break;
        const end = barrier < 0 ? queue.length : barrier;
        const index = queue.findIndex((job, i) => i < end && resourcesFree(job.resources) &&
          (!job.requireVpn || (settings.enabled && state === 'connected' && status.state === 'connected')));
        if (index < 0) break;
        const job = queue.splice(index, 1)[0];
        const subscriber = [...job.subscribers][0];
        if (!subscriber || subscriber.signal?.aborted) { completeJob(job, new VpnControllerError('CANCELED')); continue; }
        const abort = new AbortController();
        const lease = { id: ++sequence, kind: job.kind, requireVpn: job.requireVpn, resources: job.resources, abort, signal: abort.signal,
          externalSignal: subscriber.signal, externalAbort: () => abort.abort(abortError(subscriber.signal)),
          release: () => release(lease), checkpoint: resource => assertLease(lease, resource) };
        subscriber.signal?.addEventListener('abort', lease.externalAbort, { once: true });
        leases.set(lease.id, lease);
        if (subscriber.signal?.aborted) lease.externalAbort();
        completeJob(job, null, lease); changed();
      }
    } finally { pumping = false; }
  }

  function reportTunnelLoss(error = new VpnControllerError('VPN_LOST')) {
    if (!settings.enabled || disposed) return;
    if (activeSwitch) return;
    clearUncertainty(); recoveryNeeded = true;
    state = 'attention'; lastError = safeError(error);
    invalidate(error); record(error.code === 'VPN_LOST' ? 'proton-disconnected' : 'work-interrupted', error);
    updateAutomaticRecovery();
  }
  function holdForRecovery(error) {
    if (disposed) return;
    state = 'attention'; lastError = safeError(error);
    record('recovery-held', error);
  }

  async function poll(force = false) {
    if (!settings.enabled || disposed || configuring || activeSwitch || polling) return;
    polling = true; pollAbort = new AbortController();
    try {
      if (settings.required) await checkProtection(pollAbort.signal);
      const current = await adapter.getStatus({ signal: pollAbort.signal });
      if (disposed || pollAbort.signal.aborted) return;
      status = current;
      if (!['connected', 'disconnected'].includes(current.state)) throw new ProtonVpnError('UNKNOWN_OUTPUT', 'status');
      if (current.state === 'connected' && lastConfirmed?.status.server?.id && lastConfirmed.status.server.id !== current.server?.id) connectionGeneration++;
      lastConfirmed = { time: now(), status: structuredClone(current) };
      if (current.state === 'connected') {
        clearUncertainty(); recoveryNeeded = false; state = 'connected'; lastError = null; connectionProgress = null;
        updateAutomaticRecovery();
      } else if (!hasVpnWork() && (!settings.autoRecover || recoverySuppressed)) {
        clearUncertainty(); state = 'disconnected'; lastError = null; connectionProgress = null;
      } else reportTunnelLoss();
    } catch (error) {
      if (!disposed && !pollAbort.signal.aborted) {
        if (['PROTECTION_UNVERIFIED', 'VERIFICATION_TIMEOUT'].includes(error.code)) {
          state = 'attention'; lastError = safeError(error); invalidate(error); record('protection-unavailable', error);
        } else reportStatusUnavailable(error);
      }
    } finally { polling = false; pollAbort = null; changed(); pump(); }
  }

  async function configure(input, { commit } = {}) {
    if (disposed) throw new VpnControllerError('DISPOSED');
    if (configuring || activeSwitch || leases.size || queue.length || polling) throw new VpnControllerError('BUSY');
    const next = normalizeSettings(input, settings);
    const previous = { settings, state, status, protectionVerified, lastError };
    configuring = true;
    const controller = new AbortController(); outstanding.add(controller);
    try {
      settings = next; clearInterval(pollTimer); pollTimer = null;
      protectionVerified = false; lastError = null;
      if (!settings.enabled) {
        clearUncertainty(); recoveryNeeded = false; automaticRecovery?.abort();
        state = 'disabled'; status = { state: 'unknown', server: null };
        commit?.(); return snapshot();
      }
      state = 'disconnected';
      try {
        if (settings.required) await checkProtection(controller.signal);
        status = await adapter.getStatus({ signal: controller.signal });
        if (status.state === 'connected' || status.state === 'disconnected') lastConfirmed = { time: now(), status: structuredClone(status) };
        if (status.state === 'connected') { await checkConnection(controller.signal); state = 'connected'; }
        else if (status.state !== 'disconnected') throw new VpnControllerError('STATUS_UNVERIFIED');
      } catch (error) {
        if (['PROTECTION_UNVERIFIED', 'VERIFICATION_TIMEOUT'].includes(error.code)) { state = 'attention'; lastError = safeError(error); }
        else reportStatusUnavailable(error);
      }
      if (!disposed) { pollTimer = setInterval(poll, settings.monitorIntervalMs); pollTimer.unref?.(); }
      commit?.();
      return snapshot();
    } catch (error) {
      clearInterval(pollTimer); pollTimer = null;
      ({ settings, state, status, protectionVerified, lastError } = previous);
      if (settings.enabled && !disposed) { pollTimer = setInterval(poll, settings.monitorIntervalMs); pollTimer.unref?.(); }
      throw error;
    } finally {
      outstanding.delete(controller); configuring = false;
      if (disposed) state = 'disabled'; changed(); pump();
    }
  }

  function cancelWaitingOperations() {
    for (const job of [...queue]) if (job.type === 'operation') {
      queue.splice(queue.indexOf(job), 1); completeJob(job, new VpnControllerError('CANCELED'));
    }
    changed(); pump();
  }

  function dispose() {
    if (disposed) return;
    disposed = true; state = 'disabled'; clearInterval(pollTimer); pollAbort?.abort(); clearUncertainty(); automaticRecovery?.abort(); vpnWork.clear();
    const error = new VpnControllerError('DISPOSED');
    for (const controller of outstanding) controller.abort(error);
    activeSwitch?.abort.abort(error);
    for (const job of queue.splice(0)) { job.abort.abort(error); completeJob(job, error); }
    invalidate(error); changed();
    // Disposal stops coordination. The app's shutdown sequence subsequently
    // disconnects Proton after active work and CLI cleanup have stopped.
  }

  return { configure, acquire, requestSwitch, setConnectionPolicy, retryWaitingSwitch, editWaitingPool, cancelConnectionRequest, reportTunnelLoss, holdForRecovery, poll, cancelWaitingOperations, dispose, snapshot, assertLease, retainVpnWork, suppressAutomaticRecovery,
    onChange: listener => { events.on('change', listener); return () => events.off('change', listener); },
  };
}

module.exports = { createVpnController, VpnControllerError, normalizeSettings };
