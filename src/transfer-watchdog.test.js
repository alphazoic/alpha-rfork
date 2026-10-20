'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransferWatchdog } = require('./transfer-watchdog');
function fixture(options = {}) {
  let time = 0; const alarms = [];
  const watch = createTransferWatchdog({ thresholdBps: 100, warmupMs: 20, averagingMs: 20, durationMs: 30,
    now: () => time, onAlarm: sample => { alarms.push(sample); return options.defer ? false : undefined; }, ...options });
  return { watch, alarms, tick: (t, bytes = 0) => { time = t; watch.add(bytes); return watch.tick(); } };
}
test('zero-progress timer ticks include warmup, averaging and sustained duration', () => {
  const f = fixture(); f.watch.start();
  for (const t of [10, 20, 30, 40]) f.tick(t);
  assert.equal(f.alarms.length, 0); f.tick(50);
  assert.equal(f.alarms.length, 1); assert.equal(f.alarms[0].speedBps, 0);
  f.tick(100); assert.equal(f.alarms.length, 1);
});
test('actual numeric bytes detect sustained low speed and reset after a healthy interval', () => {
  const f = fixture(); f.watch.start(); f.tick(20, 1); f.tick(30, 1);
  f.tick(40, 100); assert.equal(f.alarms.length, 0);
  f.tick(60); f.tick(80); assert.equal(f.alarms.length, 0); f.tick(90);
  assert.equal(f.alarms.length, 1);
});
test('local work/idle stops sampling and a new attempt resets the baseline', () => {
  const f = fixture(); f.watch.start(); f.tick(20); f.watch.stop(); f.tick(1000);
  assert.equal(f.alarms.length, 0); f.watch.start(); f.tick(1010); f.tick(1020); f.tick(1040);
  assert.equal(f.alarms.length, 0); f.tick(1050); assert.equal(f.alarms.length, 1);
});
test('deferring an advancing stream keeps sampling until zero progress is visible', () => {
  const f = fixture({ thresholdBps: 10000, defer: true }); f.watch.start(); f.tick(20, 10); f.tick(50, 10);
  assert.ok(f.alarms[0].bytesInWindow > 0); f.tick(80); assert.equal(f.alarms.at(-1).bytesInWindow, 0);
});
test('a high-speed burst followed by a short dip does not recover', () => {
  const f = fixture(); f.watch.start(); f.tick(20, 100); f.tick(30); f.tick(40); f.tick(50, 100); f.tick(60, 100);
  assert.equal(f.alarms.length, 0);
});
