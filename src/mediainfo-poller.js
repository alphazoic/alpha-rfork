'use strict';

const { spawn: systemSpawn } = require('child_process');
const { getBinPath } = require('../binPath');

// Poll every five seconds for six attempts, then back off up to five minutes.
// stop() waits for confirmed child/stdio closure, not just a successful kill().
function startMediainfoPoller(filePath, onResult, { spawn = systemSpawn, getBinary = () => getBinPath('mediainfo'),
  initialDelayMs = 5000, fastIntervalMs = 5000, fastAttempts = 6, backoffBaseMs = 10000,
  backoffCapMs = 300000, queryTimeoutMs = 25000, terminateGraceMs = 1000, terminationTimeoutMs = 1000 } = {}) {
  let stopped = false, timer = null, active = null, attempts = 0, stopping = null;

  function query() {
    let child;
    try { child = spawn(getBinary(), ['--Inform=Video;%Duration%', filePath]); }
    catch { return Promise.resolve(null); }
    let output = '', settled = false, deadline, killTimer, confirmationTimer, termination;
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const work = { closed, terminate() {
      if (settled) return closed;
      if (termination) return termination;
      termination = new Promise((resolve, reject) => {
        closed.then(resolve);
        try { child.kill('SIGTERM'); } catch { /* Closure must still be confirmed. */ }
        if (settled) return;
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* Bound the confirmation wait. */ }
          if (settled) return;
          confirmationTimer = setTimeout(() => reject(Object.assign(
            new Error('MediaInfo has not confirmed shutdown; preview cleanup is deferred.'), { code: 'MEDIAINFO_UNCONFIRMED' })), terminationTimeoutMs);
        }, terminateGraceMs);
      });
      termination.catch(() => {});
      return termination;
    } };
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(confirmationTimer);
      if (active === work) active = null;
      const duration = parseFloat(output.trim());
      resolveClosed(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    active = work;
    child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.once('close', finish);
    child.once('error', () => {
      if (!child.pid) finish(); // A spawn error with no child owns no file reader.
      else work.terminate().catch(() => {});
    });
    deadline = setTimeout(() => work.terminate().catch(() => {}), queryTimeoutMs);
    return closed;
  }

  async function poll() {
    if (stopped) return;
    attempts++;
    const duration = await query();
    if (stopped) return;
    if (duration !== null) { stopped = true; onResult(duration); return; }
    const delay = attempts < fastAttempts ? fastIntervalMs : Math.min(backoffBaseMs * 2 ** (attempts - fastAttempts), backoffCapMs);
    timer = setTimeout(poll, delay);
  }
  timer = setTimeout(poll, initialDelayMs);
  return {
    stop() {
      stopped = true; clearTimeout(timer);
      if (!stopping) stopping = active ? active.terminate().then(() => {}) : Promise.resolve();
      return stopping;
    },
  };
}

module.exports = { startMediainfoPoller };
