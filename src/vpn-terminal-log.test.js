'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createVpnTerminalLog } = require('./vpn-terminal-log');

test('retains raw text, pages by sequence, and bounds events and encoded bytes', () => {
  const log = createVpnTerminalLog({ maxEvents: 3, maxBytes: 1000 });
  const original = '  Traceback:\n\t<img src=x>\r\n\x1b[31mRésumé 雨\x1b[0m\n\n';
  log.onChange(() => { throw new Error('broken UI'); });
  log.record({ kind: 'stderr', commandId: 1, text: original });
  assert.equal(log.read().events[0].text, original); assert.ok(log.text().includes(original));
  for (let i = 0; i < 8; i++) log.record({ kind: 'm3', text: String(i) });
  const recent = log.read(); assert.equal(recent.events.length, 3); assert.equal(recent.dropped, 6);
  assert.deepEqual(log.read(recent.events[0].seq).events.map(e => e.text), ['6', '7']);
  assert.match(log.text(), /6 earlier events expired/);
  log.record({ kind: 'stdout', text: 'x'.repeat(1200) });
  assert.ok(log.read().bytes <= 1000); assert.equal(log.read().events.length, 0);
});

test('bounded pages reconstruct split Unicode without gaps or duplicate events', () => {
  const log = createVpnTerminalLog();
  const text = 'x'.repeat(8191) + '😀'.repeat(15000);
  log.record({ kind: 'stdout', commandId: 1, text });
  for (let i = 0; i < 600; i++) log.record({ kind: 'm3', text: 'event ' + i });
  let cursor = 0, events = [], page;
  do { page = log.read(cursor); assert.ok(page.events.length <= 256); events.push(...page.events); cursor = page.cursor; } while (page.hasMore);
  assert.equal(events.filter(e => e.kind === 'stdout').map(e => e.text).join(''), text);
  assert.equal(new Set(events.map(e => e.seq)).size, events.length);
  assert.equal(cursor, page.latest);
});

test('active commands stay distinguishable and unconfirmed processes survive until close', () => {
  const log = createVpnTerminalLog();
  for (const commandId of [1, 2]) log.record({ kind: 'cmd', commandId, phase: 'start', deadlineMs: 15000, text: 'protonvpn status' });
  assert.match(log.text(), /\[deadline 15000ms\]/);
  log.record({ kind: 'stdout', commandId: 1, text: 'test' });
  log.record({ kind: 'm3', commandId: 1, phase: 'unconfirmed', text: 'still running' });
  assert.deepEqual(log.read().active.map(c => [c.id, c.outputBytes]), [[1, 4], [2, 0]]);
  log.record({ kind: 'm3', commandId: 2, phase: 'spawn-failed', text: 'missing' });
  log.record({ kind: 'm3', commandId: 1, phase: 'close', text: 'closed' });
  assert.deepEqual(log.read().active, []);
});

test('local rolling files retain at most three bounded files, flushing pending records', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-terminal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const log = createVpnTerminalLog({ directory: dir, fileBytes: 1000 });
  for (let i = 0; i < 50; i++) log.record({ kind: 'stdout', text: 'line ' + i + '\n'.repeat(20) });
  await log.flush();
  const files = await fs.readdir(dir); assert.equal(files.length, 3);
  const contents = [];
  for (const file of files) {
    const stat = await fs.stat(path.join(dir, file)); assert.ok(stat.size <= 1000);
    assert.equal(stat.mode & 0o777, 0o600);
    contents.push(await fs.readFile(path.join(dir, file), 'utf8'));
  }
  const lines = contents.join('').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(lines.some(line => line.text.startsWith('line 49'))); assert.equal(log.read().diskError, false);
  await log.dispose();
});

test('disk failures and backlog do not fail or stop session capture', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-terminal-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'not-a-directory'); await fs.writeFile(file, '');
  const log = createVpnTerminalLog({ directory: file });
  log.record({ kind: 'stdout', text: 'x'.repeat(1200000) });
  assert.ok(log.read().diskDropped > 0);
  await log.flush(); assert.equal(log.read().diskError, true);
  log.record({ kind: 'm3', text: 'still capturing' });
  assert.ok(log.text().includes('still capturing')); await log.dispose();
});

test('coordinator state captures retry schedule and held work without duplicate noise', () => {
  const log = createVpnTerminalLog();
  const controller = { state: 'waiting', connectionProgress: { nextRetryAt: 10000, message: 'Work paused; job retained' }, lastError: { message: 'Status unavailable' } };
  log.recordState(controller); log.recordState(controller);
  assert.equal(log.read().events.length, 1); assert.match(log.text(), /Automatic retry:/);
  log.recordState({ state: 'connected' }); assert.equal(log.read().events.length, 2);
});
