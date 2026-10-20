'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { spawn: systemSpawn } = require('child_process');
const { VpnControllerError } = require('./vpn-controller');

// The account session belongs to a complete workflow, not to each individual
// login/ls/logout command. Otherwise another workflow could change accounts
// between two commands. Public-link metadata/downloads need no account lock.
const SESSION_KINDS = new Set(['upload', 'bulk-import', 'account-refresh', 'single-account',
  'security-upgrade', 'account-files', 'account-links', 'import-quota', 'import', 'folder-link', 'account-create', 'megacmd']);

function createNetworkOperations(controller, { spawn = systemSpawn, fetch = globalThis.fetch,
  terminationGraceMs = 1000 } = {}) {
  const storage = new AsyncLocalStorage(), tasks = new Map();
  const contexts = new Set();
  let closing = false;

  function checkpoint(resource) {
    if (closing) throw new VpnControllerError('DISPOSED');
    const context = storage.getStore();
    if (!context) {
      if (controller.snapshot().settings.enabled) throw new VpnControllerError('LEASE_INVALID');
      return;
    }
    controller.assertLease(context.lease, resource);
  }
  function interruption(error) {
    const context = storage.getStore();
    // Catches in fallback/retry engines must not reinterpret lost protection as
    // an account failure, a bad upload tool, or a new reason to rotate accounts.
    if (context?.lease.signal.aborted) throw context.lease.signal.reason;
    if (error?.vpnInterrupted) throw error;
  }

  async function run(kind, fn, { signal, requireVpn = false, resources = SESSION_KINDS.has(kind) ? ['megacmd-session'] : [] } = {}) {
    if (closing) throw new VpnControllerError('DISPOSED');
    const parent = storage.getStore();
    if (parent) {
      checkpoint();
      for (const resource of resources) checkpoint(resource);
      return fn(parent.lease.signal);
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const task = { abort, kind };
    if (!tasks.has(kind)) tasks.set(kind, new Set());
    tasks.get(kind).add(task);
    let lease;
    try {
      lease = await controller.acquire({ kind, resources, requireVpn, signal: abort.signal });
      const context = { lease, children: new Set(), fetchAborts: new Set(), requests: new Set(), finished: false,
        abort, reacquire: async () => {
          lease = await controller.acquire({ kind, resources, requireVpn, signal: abort.signal });
          context.lease = lease;
        } };
      contexts.add(context);
      return await storage.run(context, async () => {
        try { checkpoint(); const result = await fn(lease.signal); checkpoint(); return result; }
        finally {
          for (const pending of context.fetchAborts) pending.abort();
          // Wait for transport closure, not just a successful destroy()/kill().
          const transports = [...context.children, ...context.requests];
          for (const transport of transports) if (!transport.closed) transport.terminate();
          const results = await Promise.all(transports.map(transport => transport.completion));
          context.finished = true;
          if (results.some(closed => !closed) && transports.some(transport => !transport.closed)) {
            controller.reportTunnelLoss(new VpnControllerError('TRANSPORT_UNCONFIRMED'));
            // Keep the lease: a still-running child may issue network commands.
            // Its close handler releases it only after every child is stopped.
            throw new VpnControllerError('TRANSPORT_UNCONFIRMED');
          }
          lease.release();
          contexts.delete(context);
        }
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      tasks.get(kind).delete(task);
      if (!tasks.get(kind).size) tasks.delete(kind);
    }
  }

  function cancel(kind, reason = new VpnControllerError('CANCELED')) {
    for (const task of tasks.get(kind) || []) task.abort.abort(reason);
  }

  async function shutdown() {
    closing = true;
    for (const kind of tasks.keys()) cancel(kind, new VpnControllerError('DISPOSED'));
    const transports = [];
    for (const context of contexts) {
      for (const abort of context.fetchAborts) abort.abort();
      for (const transport of [...context.children, ...context.requests]) {
        if (!transport.closed) transport.terminate();
        transports.push(transport);
      }
    }
    await Promise.all(transports.map(item => item.completion));
    if (transports.some(item => !item.closed)) throw new VpnControllerError('TRANSPORT_UNCONFIRMED');
  }

  // Only completed, committed upload files may yield their account session.
  // The callback has no lease and cannot accidentally start guarded traffic.
  async function yieldRoute(fn) {
    checkpoint();
    const context = storage.getStore();
    if (!context || context.finished) throw new VpnControllerError('LEASE_INVALID');
    const transports = [...context.children, ...context.requests];
    for (const transport of transports) if (!transport.closed) transport.terminate();
    await Promise.all(transports.map(transport => transport.completion));
    if (transports.some(transport => !transport.closed)) throw new VpnControllerError('TRANSPORT_UNCONFIRMED');
    checkpoint();
    context.lease.release();
    try { return await storage.run(undefined, () => fn(context.abort.signal)); }
    finally { await context.reacquire(); }
  }

  function trackProcess(child) {
    const context = storage.getStore();
    if (!context) return child;
    const signal = context.lease.signal;
    let timer, deadline, closed = child.exitCode != null || child.signalCode != null, resolve;
    const record = { closed, completion: new Promise(done => { resolve = done; }) };
    context.children.add(record);
    const stopped = () => {
      record.closed = true; closed = true; clearTimeout(timer); clearTimeout(deadline);
      signal.removeEventListener('abort', terminate); resolve(true);
      if (context.finished && [...context.children, ...context.requests].every(item => item.closed)) { context.lease.release(); contexts.delete(context); }
    };
    const terminate = () => {
      if (closed || timer) return;
      try { child.kill('SIGTERM'); } catch { /* attempt SIGKILL below */ }
      if (closed) return;
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* retain lease if termination cannot be verified */ }
        if (!closed) deadline = setTimeout(() => resolve(false), terminationGraceMs);
      }, terminationGraceMs);
    };
    record.terminate = terminate;
    child.once('close', stopped);
    child.once('error', () => { if (!child.pid) stopped(); });
    signal.addEventListener('abort', terminate, { once: true });
    if (closed) stopped(); else if (signal.aborted) terminate();
    return child;
  }

  function spawnNetwork(command, args, options) {
    const isMegaCmd = /(?:mega-exec|MEGAclient)(?:\.exe)?$/i.test(command);
    checkpoint(isMegaCmd ? 'megacmd-session' : null);
    return trackProcess(spawn(command, args, options));
  }

  function trackRequest(request) {
    const context = storage.getStore();
    if (!context) return request;
    const signal = context.lease.signal;
    let resolve, deadline;
    const record = { closed: false, completion: new Promise(done => { resolve = done; }) };
    record.terminate = error => {
      if (record.closed || deadline) return;
      request.destroy(error);
      if (!record.closed) deadline = setTimeout(() => resolve(false), terminationGraceMs);
    };
    const abort = () => record.terminate(signal.reason);
    context.requests.add(record);
    signal.addEventListener('abort', abort, { once: true });
    request.once('close', () => {
      record.closed = true; clearTimeout(deadline); resolve(true);
      context.requests.delete(record); signal.removeEventListener('abort', abort);
      if (context.finished && [...context.children, ...context.requests].every(item => item.closed)) { context.lease.release(); contexts.delete(context); }
    });
    if (signal.aborted) abort();
    return request;
  }

  function requestNetwork(lib, method, ...args) {
    checkpoint();
    return trackRequest(lib[method](...args));
  }

  async function fetchNetwork(url, options = {}) {
    checkpoint();
    const context = storage.getStore();
    if (!context) return fetch(url, options);
    const abort = new AbortController(); context.fetchAborts.add(abort);
    const combined = [abort.signal, context.lease.signal, options.signal].filter(Boolean);
    return fetch(url, { ...options, signal: AbortSignal.any(combined) });
  }

  function delay(ms) {
    checkpoint();
    const signal = storage.getStore()?.lease.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }).finally(() => checkpoint());
  }

  function wrap(kind, fn, onFailure) {
    return (...args) => {
      if (['download', 'upload', 'bulk-import', 'account-refresh', 'security-upgrade'].includes(kind) && tasks.get(kind)?.size) return Promise.resolve();
      return run(kind, () => fn(...args)).catch(error => {
        if (onFailure) return onFailure(error, args);
        throw error;
      });
    };
  }

  return { run, wrap, cancel, shutdown, yieldRoute, checkpoint, interruption, spawnNetwork, requestNetwork, fetchNetwork, delay,
    hasTask: kind => Boolean(tasks.get(kind)?.size),
    hasContext: () => Boolean(storage.getStore()),
    currentSignal: () => storage.getStore()?.lease.signal,
  };
}

// Main installs one controller. Without installation, imports remain inert and
// existing CLI/module use stays operational. No hidden Proton calls at require().
let installed = null;
function installNetworkOperations(controller) {
  if (installed) throw new Error('Network operations are already installed.');
  installed = createNetworkOperations(controller);
  return installed;
}
const fallback = {
  shutdown: async () => {},
  yieldRoute: fn => fn(),
  run: (_kind, fn) => Promise.resolve().then(fn), cancel: () => {}, checkpoint: () => {}, interruption: error => { if (error?.vpnInterrupted) throw error; },
  spawnNetwork: (...args) => systemSpawn(...args), requestNetwork: (lib, method, ...args) => lib[method](...args),
  fetchNetwork: (...args) => globalThis.fetch(...args), hasContext: () => false, currentSignal: () => undefined,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  hasTask: () => false,
};
fallback.wrap = (_kind, fn, onFailure) => (...args) => Promise.resolve().then(() => fn(...args)).catch(error => {
  if (onFailure) return onFailure(error, args);
  throw error;
});
const exportsApi = { createNetworkOperations, installNetworkOperations };
for (const key of Object.keys(fallback)) exportsApi[key] = (...args) => (installed || fallback)[key](...args);
// Main imports workflow modules before installing the coordinator. Defer wrap
// resolution too: binding fallback.wrap here permanently bypasses leasing.
exportsApi.wrap = (...options) => (...args) => (installed || fallback).wrap(...options)(...args);
module.exports = exportsApi;
