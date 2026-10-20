'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startMediainfoPoller } = require('./mediainfo-poller');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(2); }
  assert.fail('MediaInfo fixture did not reach expected state');
}
function fixture(options = {}) {
  const children = [], results = [];
  const poller = startMediainfoPoller('/owned/preview.mkv', value => results.push(value), {
    getBinary: () => 'fixture-mediainfo', initialDelayMs: 0, fastIntervalMs: 2,
    queryTimeoutMs: 200, terminateGraceMs: 5, terminationTimeoutMs: 5,
    spawn(binary, args) {
      assert.equal(binary, 'fixture-mediainfo'); assert.equal(args.at(-1), '/owned/preview.mkv');
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.pid = 123;
      child.signals = []; child.kill = signal => { child.signals.push(signal); options.onKill?.(child, signal); return true; };
      children.push(child); return child;
    }, ...options.poller,
  });
  return { children, results, poller };
}
test('stop cancels an in-flight query and suppresses a late duration until confirmed closure', async () => {
  const f = fixture(); await until(() => f.children.length);
  let done = false; const stopping = f.poller.stop().then(() => { done = true; });
  const child = f.children[0]; assert.deepEqual(child.signals, ['SIGTERM']); assert.equal(done, false);
  child.stdout.emit('data', Buffer.from('60000')); child.emit('close', 0); await stopping;
  assert.equal(done, true); assert.deepEqual(f.results, []); await sleep(10); assert.equal(f.children.length, 1);
});
test('stop escalates to SIGKILL and waits for child and stdio closure', async () => {
  const f = fixture({ onKill(child, signal) { if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null)); } });
  await until(() => f.children.length); await f.poller.stop();
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(f.results, []);
});
test('unconfirmed closure produces a bounded failure and still suppresses late results', async () => {
  const f = fixture(); await until(() => f.children.length);
  await assert.rejects(f.poller.stop(), { code: 'MEDIAINFO_UNCONFIRMED' });
  f.children[0].stdout.emit('data', Buffer.from('60000')); f.children[0].emit('close', 0);
  await sleep(2); assert.deepEqual(f.results, []);
});
test('a successful query reports once and stop is idempotent', async () => {
  const f = fixture(); await until(() => f.children.length);
  f.children[0].stdout.emit('data', Buffer.from('12345')); f.children[0].emit('close', 0);
  await until(() => f.results.length); await f.poller.stop(); await f.poller.stop();
  assert.deepEqual(f.results, [12345]); assert.deepEqual(f.children[0].signals, []);
});
test('stop before the initial timer prevents a child from starting', async () => {
  const f = fixture({ poller: { initialDelayMs: 20 } }); await f.poller.stop(); await sleep(25);
  assert.equal(f.children.length, 0);
});
test('query timeout terminates its reader before scheduling another query', async () => {
  const f = fixture({ poller: { queryTimeoutMs: 5 }, onKill(child) { setImmediate(() => child.emit('close', null)); } });
  await until(() => f.children.length >= 2); await f.poller.stop();
  assert.ok(f.children.every(child => child.signals.includes('SIGTERM'))); assert.deepEqual(f.results, []);
});
