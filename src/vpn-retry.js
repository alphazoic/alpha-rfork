'use strict';

const { ProtonVpnError, normalizeTarget, toDiagnostic } = require('./protonvpn');
const { createCatalogTraversal, normalizeSelectionPolicy } = require('./vpn-catalog');

const DEFAULT_RETRY_SETTINGS = Object.freeze({
  attemptsPerServer: 1, maxCandidates: 10,
  attemptTimeoutMs: 90000, roundTimeoutMs: 300000,
  initialDelayMs: 1000, maxDelayMs: 60000,
  failedServerCooldownMs: 900000, roundRetryDelayMs: 30000,
});
class VpnRetryError extends Error {
  constructor(code) {
    super({ CANCELED: 'VPN connection recovery canceled.', BUSY: 'A VPN connection recovery round is already running.',
      INVALID_RETRY_SETTINGS: 'Choose valid VPN retry limits and durations.' }[code] || 'VPN connection recovery could not continue.');
    this.name = 'VpnRetryError'; this.code = code; this.cancelled = code === 'CANCELED';
  }
}
function normalizeRetrySettings(input = {}, previous = DEFAULT_RETRY_SETTINGS) {
  const fail = () => { throw new VpnRetryError('INVALID_RETRY_SETTINGS'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_RETRY_SETTINGS, key))) fail();
  const result = { ...DEFAULT_RETRY_SETTINGS, ...previous, ...input };
  for (const [key, value] of Object.entries(result)) {
    const min = ['initialDelayMs', 'maxDelayMs', 'failedServerCooldownMs'].includes(key) ? 0 : 1;
    const max = key === 'attemptsPerServer' ? 10 : key === 'maxCandidates' ? 1000 : 2147483647;
    if (!Object.hasOwn(DEFAULT_RETRY_SETTINGS, key) || !Number.isSafeInteger(value) || value < min || value > max) fail();
  }
  if (result.initialDelayMs > result.maxDelayMs) fail();
  return result;
}
const PREREQUISITES = new Set(['AUTH_REQUIRED', 'AUTH_FAILED', 'VPN_2FA_REQUIRED', 'KEYRING_UNAVAILABLE', 'SESSION_UNAVAILABLE',
  'SERVICE_UNAVAILABLE', 'CLI_MISSING', 'CLI_PERMISSION', 'GUI_CONFLICT', 'PLAN_RESTRICTED', 'CAPABILITY_UNAVAILABLE',
  'UNSUPPORTED_CLI', 'UNSUPPORTED_PLATFORM', 'INVALID_SELECTION', 'OUTPUT_LIMIT']);
function createRecoveryState() { return { failures: 0, nextAttemptAt: 0, lastConfirmed: null, pending: null, refreshCapabilities: false }; }
function retryDelay(settings, failures, random = Math.random) {
  const n = Math.max(1, Math.min(32, failures));
  const factor = n < 5 ? 2 ** (n - 1) : 15 * 2 ** (n - 5);
  const base = Math.min(settings.maxDelayMs, settings.initialDelayMs * factor);
  return Math.min(settings.maxDelayMs, Math.max(0, Math.round(base * (0.9 + random() * 0.2))));
}
const UNKNOWN = () => ({ state: 'unknown', server: null });
function normalizedId(value) { return normalizeTarget({ server: value }).server; }
function safeStatus(value) {
  if (value?.state === 'disconnected') return { state: 'disconnected', server: null };
  if (value?.state === 'connected') {
    try { return { state: 'connected', server: { id: normalizedId(value.server?.id) } }; } catch { /* unknown */ }
  }
  return UNKNOWN();
}
function safeFailure(error) {
  return toDiagnostic(error);
}
function pause(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

// One engine must be shared by the controller. It never schedules another round
// or releases a workflow lease. Callers use waiting/attention results to hold the
// same job, and schedule rounds only while that job still wants a connection.
function createVpnRetryEngine({ adapter, now = Date.now, timers = { setTimeout, clearTimeout }, sleep = pause,
  random = Math.random } = {}) {
  if (!adapter || typeof adapter.connect !== 'function' || typeof adapter.getStatus !== 'function') throw new TypeError('A Proton CLI adapter is required.');
  let active = false, blocked = false, progress = null;
  let traversalCatalog = null, currentTraversal = null;
  const traversals = new Map(), traversalAliases = new Map();
  const cooldowns = new Map(), recent = [];
  function traversalFor(catalog, policy) {
    if (catalog !== traversalCatalog) {
      traversalCatalog = catalog; traversals.clear(); traversalAliases.clear();
    }
    // Recency is an eligibility preference, not a new pool or a new shuffle.
    const policyKey = JSON.stringify({ ...policy, recentLimit: 0 });
    let scope = traversalAliases.get(policyKey), traversal = traversals.get(scope);
    if (!traversal) {
      const candidate = createCatalogTraversal(catalog, policy, { random });
      scope = candidate.scopeKey; traversal = traversals.get(scope) || candidate;
      traversalAliases.set(policyKey, scope);
    }
    traversals.delete(scope); traversals.set(scope, traversal);
    while (traversals.size > 8) traversals.delete(traversals.keys().next().value);
    while (traversalAliases.size > 16) traversalAliases.delete(traversalAliases.keys().next().value);
    currentTraversal = traversal;
    return traversal;
  }
  function prune() { for (const [id, until] of cooldowns) if (until <= now()) cooldowns.delete(id); }
  function noteConnected(id) {
    id = normalizedId(id); cooldowns.delete(id);
    const index = recent.indexOf(id); if (index >= 0) recent.splice(index, 1);
    recent.push(id); if (recent.length > 1000) recent.shift();
  }
  const snapshot = () => {
    prune();
    if (blocked && adapter.getProcessState?.().blocked === false) blocked = false;
    return { active, blocked, progress: progress && structuredClone(progress), recentServers: [...recent],
      selection: currentTraversal?.summary() || null, cachedPools: traversals.size,
      cooldowns: [...cooldowns].map(([server, until]) => ({ server, until })) };
  };
  const unconfirmed = error => error?.terminationConfirmed === false || error?.code === 'PROCESS_UNCONFIRMED';

  async function runRound({ catalog, selection = {}, retry = {}, recentServers = [], excludeServers = [], reuseServer = null,
    initialFastest = false, reuseCurrent = false, recovery = createRecoveryState(), signal, onProgress = () => {} } = {}) {
    if (signal?.aborted) throw new VpnRetryError('CANCELED');
    if (active) throw new VpnRetryError('BUSY');
    const settings = normalizeRetrySettings(retry), policy = normalizeSelectionPolicy(selection);
    recentServers = recentServers.map(normalizedId);
    excludeServers = excludeServers.map(normalizedId);
    if (reuseServer !== null) reuseServer = normalizedId(reuseServer);
    const selector = traversalFor(catalog, policy);
    const started = now(), abort = new AbortController();
    let budgetExpired = false, attempts = 0, candidateNumber = 0, status = UNKNOWN();
    let lastFailure = null, currentCandidate = null, currentAttempt = null;
    const attemptedServers = [], failures = [];
    const attemptedThisRound = new Set();
    const cancel = () => abort.abort();
    const remaining = () => Math.max(0, settings.roundTimeoutMs - (now() - started));
    const emit = (phase, details = {}) => {
      progress = { phase, attempts, candidateNumber, maxCandidates: settings.maxCandidates,
        server: currentCandidate?.target.server || null, attempt: currentAttempt, maxAttempts: settings.attemptsPerServer,
        fallback: currentCandidate?.fallback || false,
        elapsedMs: Math.max(0, now() - started), status: structuredClone(status),
        selection: selector.summary(),
        lastConfirmed: structuredClone(recovery.lastConfirmed), ...details };
      // Observers cannot interrupt process cleanup or turn a successful
      // connection into another attempt. Cancellation uses the AbortSignal.
      try { onProgress(structuredClone(progress)); } catch { /* observer only */ }
    };
    const finish = (outcome, reason, error = null) => {
      let retryDelayMs = null;
      if (outcome !== 'connected') {
        retryDelayMs = Math.max(1, recovery.nextAttemptAt - now());
        if (reason === 'status-unavailable') retryDelayMs = Math.max(1000, retryDelayMs);
        if (outcome === 'attention') retryDelayMs = Math.max(30000, settings.roundRetryDelayMs, retryDelayMs);
        if (['candidate-limit', 'round-timeout', 'pool-exhausted'].includes(reason)) retryDelayMs = Math.max(settings.roundRetryDelayMs, retryDelayMs);
        if (reason === 'pool-exhausted' && cooldowns.size) {
          const earliest = selector.nextCooldownAt(cooldowns, status.server?.id);
          if (earliest !== null) retryDelayMs = Math.max(retryDelayMs, earliest - now());
        }
      }
      const nextRetryAt = retryDelayMs === null ? null : now() + retryDelayMs;
      const result = { outcome, reason, status: structuredClone(status), attempts, attemptedServers: [...attemptedServers],
        failures: structuredClone(failures), elapsedMs: Math.max(0, now() - started), nextRetryAt, retryDelayMs,
        lastConfirmed: structuredClone(recovery.lastConfirmed),
        selection: selector.summary(),
        server: outcome === 'connected' ? status.server.id : currentCandidate?.target.server || null, fallback: currentCandidate?.fallback || false,
        error: outcome === 'connected' ? null : error || lastFailure };
      emit(outcome, { reason, nextRetryAt, error: result.error,
        message: outcome === 'connected' ? `Proton reports connected to ${status.server.id}.` : outcome === 'waiting'
          ? `VPN recovery round finished (${reason}). Work is waiting for another connection recovery round.`
          : `VPN recovery is waiting: ${result.error?.message || 'Proton status could not be confirmed.'} Automatically checking again in ${Math.ceil(retryDelayMs / 1000)} seconds.` });
      return result;
    };
    const observed = value => {
      status = safeStatus(value);
      if (status.state !== 'unknown') recovery.lastConfirmed = { time: now(), status: structuredClone(status) };
      for (const diagnostic of (value?.diagnostics || []).slice(-10)) {
        // Diagnostics from the adapter are already sanitized; reconstruct typed
        // fields nevertheless so an arbitrary adapter cannot forward raw text.
        const error = Object.assign(new ProtonVpnError(diagnostic.code, diagnostic.operation, diagnostic.exitCode), { reason: diagnostic.reason });
        emit('diagnostic', { error: safeFailure(error), message: safeFailure(error).message });
      }
      return status;
    };
    const succeeded = () => {
      selector.observe(status.server.id);
      noteConnected(status.server.id); recovery.failures = 0; recovery.nextAttemptAt = 0; recovery.pending = null;
      return finish('connected', 'connected');
    };
    const failed = error => {
      recovery.failures = Math.min(1000000, recovery.failures + 1);
      recovery.nextAttemptAt = now() + retryDelay(settings, recovery.failures, random);
      return safeFailure(error);
    };
    const attention = error => {
      const details = failed(error);
      if (PREREQUISITES.has(details.code)) recovery.refreshCapabilities = true;
      return finish('attention', details.code === 'PROCESS_UNCONFIRMED' ? 'process-unconfirmed' : 'prerequisite-unavailable', details);
    };
    const statusFailure = error => {
      if (PREREQUISITES.has(error?.code)) return attention(error);
      return finish('waiting', 'status-unavailable', failed(error));
    };
    const checkAbort = () => {
      if (signal?.aborted) throw new VpnRetryError('CANCELED');
      return budgetExpired || remaining() <= 0;
    };
    const recordFailure = (id, attempt, error, processTimeoutMs) => {
      lastFailure = { server: id, attempt, ...safeFailure(error) };
      if (error.code === 'TIMEOUT') {
        lastFailure.message = `M3's CLI process deadline of ${processTimeoutMs} ms was reached.`;
        lastFailure.deadlineOrigin = 'm3-process';
      } else if (lastFailure.protonTimeoutSeconds) lastFailure.deadlineOrigin = 'proton-cli';
      failures.push(lastFailure); if (failures.length > 100) failures.shift();
      if (id && settings.failedServerCooldownMs) {
        cooldowns.delete(id); cooldowns.set(id, now() + settings.failedServerCooldownMs);
        if (cooldowns.size > 100000) cooldowns.delete(cooldowns.keys().next().value);
      }
    };
    let timer;
    active = true;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      if (snapshot().blocked) return attention(new ProtonVpnError('PROCESS_UNCONFIRMED'));
      if (settings.failedServerCooldownMs === 0) cooldowns.clear();
      timer = timers.setTimeout(() => { budgetExpired = true; abort.abort(); }, settings.roundTimeoutMs);
      try {
        if (recovery.refreshCapabilities && adapter.inspect) {
          await adapter.inspect({ signal: abort.signal, refresh: true }); recovery.refreshCapabilities = false;
        }
        observed(await adapter.getStatus({ signal: abort.signal, timeout: Math.max(1, Math.min(settings.attemptTimeoutMs, remaining())) }));
      }
      catch (error) {
        if (unconfirmed(error)) { blocked = true; checkAbort(); return attention(new ProtonVpnError('PROCESS_UNCONFIRMED')); }
        if (checkAbort()) return finish('waiting', 'round-timeout');
        return statusFailure(error);
      }
      if (checkAbort()) return finish('waiting', 'round-timeout');
      if (status.state === 'unknown') return statusFailure(new ProtonVpnError('UNKNOWN_OUTPUT', 'status'));
      emit('status', { message: status.state === 'connected' ? `Proton reports connected to ${status.server.id}.` : 'Proton reports disconnected.' });
      if (recovery.pending && status.state === 'connected' && (!recovery.pending.server || recovery.pending.server === status.server.id)) return succeeded();
      recovery.pending = null;
      if (reuseCurrent && status.state === 'connected') return succeeded();
      if (reuseServer && status.server?.id === reuseServer) return succeeded();
      if (status.server?.id) {
        noteConnected(status.server.id); selector.observe(status.server.id);
        // There is no alternative route in a one-server pool. Proton already
        // reports its sole permitted server connected, so reuse it honestly.
        if (!initialFastest && selector.summary().total === 1 && selector.contains(status.server.id)) return succeeded();
      }
      while (candidateNumber < settings.maxCandidates) {
        if (checkAbort()) return finish('waiting', 'round-timeout');
        prune();
        const candidate = initialFastest && candidateNumber === 0 ? { target: {}, fallback: false } :
          selector.peek({ currentServer: status.server?.id, recentServers: [...recentServers, ...recent], recentLimit: policy.recentLimit,
            unavailableServers: [...cooldowns.keys(), ...attemptedThisRound], avoidServers: excludeServers });
        if (!candidate) return finish('waiting', 'pool-exhausted');
        currentCandidate = candidate;
        candidateNumber++;
        for (let attempt = 1; attempt <= settings.attemptsPerServer; attempt++) {
          currentAttempt = attempt;
          const id = candidate.target.server || null, label = id || 'fastest available';
          if (recovery.nextAttemptAt > now()) {
            const delayMs = Math.min(recovery.nextAttemptAt - now(), remaining());
            emit('retrying', { server: id, attempt, maxAttempts: settings.attemptsPerServer, delayMs,
              fallback: candidate.fallback, error: lastFailure,
              message: `Retrying with ${label} after ${delayMs} ms (server ${candidateNumber} of up to ${settings.maxCandidates}; attempt ${attempt} of ${settings.attemptsPerServer}).` });
            if (checkAbort()) return finish('waiting', 'round-timeout');
            await sleep(delayMs, abort.signal);
          }
          if (checkAbort()) return finish('waiting', 'round-timeout');
          status = UNKNOWN();
          const processTimeoutMs = Math.max(1, Math.min(settings.attemptTimeoutMs, remaining()));
          emit('connecting', { server: id, attempt, maxAttempts: settings.attemptsPerServer, processTimeoutMs,
            fallback: candidate.fallback,
            message: `Connecting to ${label} (server ${candidateNumber} of up to ${settings.maxCandidates}; attempt ${attempt} of ${settings.attemptsPerServer}).` });
          if (checkAbort()) return finish('waiting', 'round-timeout');
          attempts++; if (attempt === 1 && id) attemptedServers.push(id);
          if (id) attemptedThisRound.add(id);
          let failure;
          recovery.pending = { server: id };
          try {
            observed(await adapter.connect(candidate.target, { signal: abort.signal,
              retryFastest: false, connectTimeoutMs: processTimeoutMs }));
            if (id) selector.consume(id);
            if (checkAbort()) return finish('waiting', 'round-timeout');
            if (status.state === 'connected' && (!id || status.server.id === id)) {
              return succeeded();
            }
            failure = new ProtonVpnError(status.state === 'connected' ? 'SERVER_MISMATCH' : 'CONNECTION_UNVERIFIED', 'connect');
            failure.terminationConfirmed = true;
          } catch (error) {
            failure = error;
            if (id && (!PREREQUISITES.has(error?.code) || error?.operation === 'status')) selector.consume(id);
          }
          if (unconfirmed(failure)) {
            blocked = true; checkAbort(); return attention(new ProtonVpnError('PROCESS_UNCONFIRMED'));
          }
          if (checkAbort()) return finish('waiting', 'round-timeout');
          if (PREREQUISITES.has(failure?.code)) { recovery.pending = null; return attention(failure); }
          // A timeout/cancellation rejection is not itself evidence that the
          // process stopped. Never overlap another command without this proof.
          if (failure.terminationConfirmed !== true) {
            blocked = true; return attention(new ProtonVpnError('PROCESS_UNCONFIRMED'));
          }
          failed(failure);
          recordFailure(id, attempt, failure, processTimeoutMs);
          emit('diagnostic', { error: safeFailure(failure), message: safeFailure(failure).message });
          try { observed(await adapter.getStatus({ signal: abort.signal, timeout: Math.max(1, Math.min(settings.attemptTimeoutMs, remaining())) })); }
          catch (error) {
            if (unconfirmed(error)) { blocked = true; checkAbort(); return attention(new ProtonVpnError('PROCESS_UNCONFIRMED')); }
            if (checkAbort()) return finish('waiting', 'round-timeout');
            return statusFailure(error);
          }
          if (checkAbort()) return finish('waiting', 'round-timeout');
          if (status.state === 'connected') {
            if (!id || status.server.id === id) return succeeded();
            const mismatch = new ProtonVpnError('SERVER_MISMATCH', 'connect');
            recordFailure(id, attempt, mismatch, processTimeoutMs);
            return finish('waiting', 'server-mismatch', failed(mismatch));
          }
          if (status.state !== 'disconnected') return statusFailure(new ProtonVpnError('UNKNOWN_OUTPUT', 'status'));
          recovery.pending = null;
          emit('attempt-failed', { server: id, attempt, maxAttempts: settings.attemptsPerServer, error: lastFailure,
            message: `${label}: ${lastFailure.message} Proton reports disconnected.` });
        }
      }
      if (checkAbort()) return finish('waiting', 'round-timeout');
      return finish('waiting', 'candidate-limit');
    } catch (error) {
      if (error instanceof VpnRetryError && error.code === 'CANCELED') {
        error.terminationConfirmed = !blocked;
        emit('canceled', { message: 'VPN connection recovery canceled.',
          error: blocked ? safeFailure(new ProtonVpnError('PROCESS_UNCONFIRMED')) : null });
      }
      throw error;
    } finally {
      // Awaited CLI calls settle before this releases serialization. There is
      // deliberately no Promise.race that abandons a still-running command.
      timers.clearTimeout(timer); signal?.removeEventListener('abort', cancel); active = false;
    }
  }
  return { runRound, snapshot, noteConnected };
}

module.exports = { createVpnRetryEngine, normalizeRetrySettings, DEFAULT_RETRY_SETTINGS, VpnRetryError,
  createRecoveryState, retryDelay };
