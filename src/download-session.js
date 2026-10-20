'use strict';
const { createTransferWatchdog } = require('./transfer-watchdog');
const { VpnControllerError } = require('./vpn-controller');

function createDownloadSession({ network, service, streamMode = false, onState = () => {}, onSpeed = () => {}, tickMs = 1000, now = Date.now }) {
  const abort = new AbortController();
  const plan = service?.beginDownload('download', { signal: abort.signal });
  const policy = plan?.policy || { enabled: false };
  const monitored = policy.enabled && policy.downloadRecoveryEnabled;
  const resumable = policy.enabled && (monitored || policy.autoRecover);
  const active = new Set();
  let epoch = new AbortController(), recovering = null, guard = null, closed = false, deferred = false, pausedSince = null, pausedMs = 0;
  let routeGeneration;
  function check() { if (abort.signal.aborted) throw abort.signal.reason; }
  function notify(state, message) { onState({ state, message }); }
  function releaseGuard() { guard?.release(); guard = null; }
  function recover(reason) {
    if (recovering || closed || abort.signal.aborted) return recovering;
    pausedSince = now();
    const measuredGeneration = routeGeneration;
    recovering = Promise.resolve().then(async () => {
      check();
      // Register intent before local file cleanup finishes so all affected
      // downloads keep a shared recovery alive. The controller still waits for
      // every transport lease to close before any CLI mutation can start.
      const route = plan.recover(abort.signal, reason, snapshot => {
        const blockers = [...new Set(snapshot.activeOperations.map(item => item.kind))];
        notify(snapshot.state === 'attention' ? 'attention' : 'waiting', snapshot.connectionProgress?.message ||
          (blockers.length ? 'VPN recovery waiting for: ' + blockers.join(', ') : 'Changing the VPN connection…'));
      }, measuredGeneration);
      route.catch(() => {});
      await Promise.allSettled([...active]); check();
      try {
        await route;
      } catch (error) {
        check();
        notify('attention', (error?.vpnInterrupted || error?.name === 'ProtonVpnError' ? error.message : 'VPN recovery failed.') + ' Connect a working VPN to resume, or Stop / Skip.');
        await plan.waitForRoute(abort.signal);
      }
      check(); epoch = new AbortController(); deferred = false;
      notify('resuming', 'Proton reports connected. Resuming retained download data…');
    }).finally(() => { pausedMs += now() - pausedSince; pausedSince = null; recovering = null; });
    // Handle rejection even when the alarm fires outside a waiting run().
    recovering.catch(() => {});
    epoch.abort(new VpnControllerError('VPN_RECOVERY')); releaseGuard();
    notify('recovering', reason === 'speed' ? 'Download paused for sustained low speed / no progress.' : 'Download paused while Proton’s connection status recovers.');
    return recovering;
  }
  const unwatch = plan?.onRouteChange(snapshot => {
    if (resumable && (snapshot.lastError?.code === 'VPN_LOST' ||
        snapshot.lastError?.code === 'VPN_STATUS_UNAVAILABLE' && snapshot.statusUncertainty?.interrupted)) recover('loss');
  });
  async function run(fn, { transfer = false, fileName = '' } = {}) {
    while (true) {
      check(); if (recovering) await recovering; check();
      const attemptEpoch = epoch;
      const route = plan?.state();
      if (resumable && (route.state !== 'connected' || route.pendingSwitches || route.connectionCommandActive)) {
        notify('waiting', 'Waiting for Proton to report a connected VPN. Connect from VPN settings, or Stop / Skip.');
      }
      if (streamMode && plan && !guard) {
        notify('waiting', 'Waiting for the connection before streaming…');
        try { guard = await plan.guard(AbortSignal.any([abort.signal, attemptEpoch.signal])); }
        catch (error) { check(); if (resumable && attemptEpoch.signal.aborted) continue; throw error; }
      }
      let watchdog, timer;
      const observe = { monitored: transfer && monitored, signal: null, start() {}, add() {} };
      if (observe.monitored) {
        watchdog = createTransferWatchdog({ thresholdBps: policy.downloadThresholdBps, durationMs: policy.downloadDurationMs,
          warmupMs: policy.warmupMs, averagingMs: policy.averagingMs, now, onAlarm: sample => {
            if (streamMode && sample.bytesInWindow > 0) {
              if (!deferred) { deferred = true; notify('deferred', 'Low speed detected. Streaming is still advancing; switching is deferred.'); }
              return false;
            }
            recover('speed');
          } });
        observe.start = () => {
          watchdog.start();
          timer = setInterval(() => { const sample = watchdog.tick(); if (sample) onSpeed({ fileName, speedBps: sample.speedBps }); }, tickMs);
          timer.unref?.();
        };
        observe.add = watchdog.add;
      }
      const signal = AbortSignal.any([abort.signal, attemptEpoch.signal]);
      const work = network.run('download', leaseSignal => {
        routeGeneration = plan?.state().connectionGeneration;
        observe.signal = leaseSignal; return fn(observe);
      }, { signal, requireVpn: resumable });
      active.add(work);
      try {
        const result = await work; check(); return result;
      } catch (error) {
        check();
        if (resumable && (attemptEpoch.signal.aborted || ['VPN_LOST', 'VPN_RECOVERY', 'VPN_STATUS_UNAVAILABLE'].includes(error?.code))) {
          if (!recovering) recover('loss');
          // The raw run promise has already settled after transport closure.
        } else throw error;
      } finally { active.delete(work); clearInterval(timer); watchdog?.stop(); }
    }
  }
  function cancel(skipped = false) {
    const error = new VpnControllerError('CANCELED'); error.skipped = skipped;
    abort.abort(error); epoch.abort(error); releaseGuard();
  }
  async function close() {
    closed = true; unwatch?.(); cancel();
    await Promise.allSettled([...active]); await recovering?.catch(() => {}); plan?.close();
  }
  function sleep(ms) {
    check();
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(abort.signal.reason); };
      const timer = setTimeout(() => { abort.signal.removeEventListener('abort', stop); resolve(); }, ms);
      abort.signal.addEventListener('abort', stop, { once: true });
    });
  }
  return { run, sleep, cancel, close, check, signal: abort.signal, monitored,
    activeNow: () => now() - pausedMs - (pausedSince === null ? 0 : now() - pausedSince) };
}
module.exports = { createDownloadSession };
