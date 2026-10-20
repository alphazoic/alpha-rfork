'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVpnShutdown } = require('./vpn-shutdown');

function megaServerFixture() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = path.join(__dirname, 'megacmd.js'), module = { exports: {} }, timers = new Map(); let sequence = 0, now = 0;
  const mocks = { electron: { app: { on() {} } }, '../binPath': { getBinPath: name => name } };
  vm.runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout){${fs.readFileSync(filename, 'utf8')}\nmodule.exports.testServer = child => { _megaCmdServerProc = child; };})`, { filename })(
    id => mocks[id] || require(id.startsWith('.') ? path.resolve(__dirname, id) : id), module, module.exports,
    (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; }, id => timers.delete(id));
  return { api: module.exports, advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
test('owned MEGAcmd server is confirmed closed before shutdown completes', async () => {
  const { EventEmitter } = require('node:events'); const f = megaServerFixture(), child = new EventEmitter(), kills = [];
  child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close')); };
  f.api.testServer(child);
  const first = f.api.shutdownMegaCmdServer(); assert.equal(first, f.api.shutdownMegaCmdServer());
  await first; assert.deepEqual(kills, ['SIGTERM']); await f.api.shutdownMegaCmdServer(); assert.equal(kills.length, 1);
});
test('unconfirmed MEGAcmd server shutdown fails visibly and remains available for retry', async () => {
  const { EventEmitter } = require('node:events'); const f = megaServerFixture(), child = new EventEmitter(), kills = [];
  child.kill = signal => { kills.push(signal); }; f.api.testServer(child);
  const rejected = assert.rejects(f.api.shutdownMegaCmdServer(), /not confirmed shutdown/);
  f.advance(1000); f.advance(1000); await rejected; assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  child.kill = () => { queueMicrotask(() => child.emit('close')); }; await f.api.shutdownMegaCmdServer();
});

test('quit waits for work, confirmed disconnection and log flush, and shares concurrent requests', async () => {
  const calls = []; let release;
  const work = new Promise(resolve => { release = resolve; });
  const quit = createVpnShutdown({ stopWork: async () => { calls.push('stop'); await work; },
    adapter: { async shutdown() { calls.push('disconnect'); return { state: 'disconnected' }; } },
    flush: async () => calls.push('flush') });
  const first = quit.run(), second = quit.run(); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['stop']);
  assert.equal(quit.completed, false); release(); await first;
  assert.deepEqual(calls, ['stop', 'disconnect', 'flush']); assert.equal(quit.completed, true);
  await quit.run(); assert.equal(calls.length, 3);
});
test('failed/unverified disconnect does not authorize exit and may be retried', async () => {
  let connected = true, flushes = 0; const phases = [];
  const quit = createVpnShutdown({ stopWork: async () => {},
    adapter: { async shutdown() { return { state: connected ? 'connected' : 'disconnected' }; } },
    flush: async () => { flushes++; }, onProgress: phase => phases.push(phase) });
  await assert.rejects(quit.run(), /did not confirm/); assert.equal(quit.completed, false); assert.equal(flushes, 0);
  connected = false; await quit.run(); assert.equal(quit.completed, true); assert.equal(flushes, 1);
  assert.ok(phases.includes('failed'));
});
test('unconfirmed transport cleanup prevents disconnection and exit', async () => {
  let disconnects = 0;
  const quit = createVpnShutdown({ stopWork: async () => { throw new Error('transport still active'); },
    adapter: { shutdown: async () => { disconnects++; } }, flush: async () => {} });
  await assert.rejects(quit.run(), /transport still active/); assert.equal(disconnects, 0); assert.equal(quit.completed, false);
});
test('a stalled disconnect is canceled at the shutdown deadline and leaves exit unapproved', async () => {
  let signal;
  const quit = createVpnShutdown({ stopWork: async () => {}, adapter: { shutdown: ({ signal: value }) => { signal = value; return new Promise(() => {}); } },
    flush: async () => {}, timeoutMs: 15 });
  await assert.rejects(quit.run(), /time limit/); assert.equal(signal.aborted, true); assert.equal(quit.completed, false);
});
