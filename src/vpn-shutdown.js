'use strict';

// One attempt at a time; a failure leaves the app alive and allows an explicit
// retry. The deadline also bounds non-CLI work such as browser teardown.
function createVpnShutdown({ stopWork, adapter, flush, onProgress = () => {}, timeoutMs = 120000,
  requireDisconnect = () => true } = {}) {
  let pending = null, completed = false;
  function run() {
    if (completed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const abort = new AbortController();
      let rejectDeadline;
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      const timer = setTimeout(() => {
        const error = new Error('VPN shutdown exceeded its time limit. Disconnection has not been confirmed.');
        abort.abort(error); rejectDeadline(error);
      }, timeoutMs);
      const step = async fn => { if (abort.signal.aborted) throw abort.signal.reason; return Promise.race([Promise.resolve().then(fn), deadline]); };
      try {
        onProgress('stopping', 'Stopping active work before disconnecting Proton VPN…');
        await step(stopWork);
        onProgress('disconnecting', 'Disconnecting Proton VPN and waiting for confirmation…');
        const result = await step(() => adapter.shutdown ? adapter.shutdown({ signal: abort.signal, requireDisconnect: requireDisconnect() }) : adapter.disconnect({ signal: abort.signal }));
        if (!['disconnected', 'unsupported', 'not-installed'].includes(result?.state)) throw new Error('Proton did not confirm disconnection.');
        onProgress('disconnected', result.state === 'disconnected' ? 'Proton confirmed disconnection. Closing M3…' : 'No supported Proton session to disconnect. Closing M3…');
        await step(flush);
        completed = true;
      } catch (error) {
        onProgress('failed', 'VPN disconnection could not be confirmed. M3 remains open. Close M3 to retry.');
        throw error;
      } finally { clearTimeout(timer); }
    })();
    pending.then(() => { pending = null; }, () => { pending = null; });
    return pending;
  }
  return { run, get completed() { return completed; } };
}

module.exports = { createVpnShutdown };
