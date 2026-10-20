'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const b = require('./benchmark-bundled-uploads.cjs');
const folder = 'm3-upload-bench-7afcf430-0c7b-4e93-a829-b4d4b07b0c6b';

test('cold rounds balance every tool across every position', () => {
  const plan = b.rounds('baseline');
  assert.equal(plan.length, 9);
  for (const tool of Object.keys(b.baseline)) {
    assert.deepEqual(plan.filter(r => r.tool === tool).map(r => r.workers), Array(3).fill(b.baseline[tool]));
    assert.deepEqual(plan.map((r, i) => r.tool === tool ? i % 3 : -1).filter(i => i >= 0).sort(), [0, 1, 2]);
    assert.ok(plan.filter(r => r.tool === tool).every(r => r.bytes === 1073741824));
  }
  assert.deepEqual(b.baseline, { megatools: 5, megacmd: 10, rfork: 8 });
});
test('nomination ignores failed, unverified and non-tuning results', () => {
  const run = { tool: 'rfork', phase: 'tuning', success: true, sizeVerified: true };
  const runs = [{ ...run, workers: 8, seconds: 12 }, { ...run, workers: 16, seconds: 10 },
    { ...run, workers: 32, seconds: 1, success: false }, { ...run, workers: 4, seconds: 2, sizeVerified: false },
    { ...run, workers: 1, seconds: 0.1, phase: 'baseline' }];
  assert.equal(b.choose(runs, 'rfork'), 16);
  assert.equal(b.choose([], 'megatools'), 5);
});
test('confirmation is a new balanced set using each nominated setting', () => {
  const chosen = { megatools: 20, megacmd: 40, rfork: 16 };
  assert.ok(b.rounds('confirmation', chosen).every(r => r.workers === chosen[r.tool] && r.phase === 'confirmation'));
  assert.equal(b.tuning().length, 12);
});
test('timeouts and size mismatches never become a fast throughput result', () => {
  const run = { tool: 'megatools', phase: 'baseline', workers: 5, bytes: b.GiB, success: true, sizeVerified: true };
  const result = b.summarize([{ ...run, seconds: 10 }, { ...run, seconds: 20 },
    { ...run, seconds: 1, success: false }, { ...run, seconds: 2, sizeVerified: false }])[0];
  assert.equal(result.completed, 2); assert.equal(result.attempts, 4);
  assert.equal(result.medianSeconds, 15); assert.equal(result.medianMBps, b.GiB / 15 / 1e6);
});
test('a completely failed configuration reports null speed and time', () => {
  const result = b.summarize([{ tool: 'rfork', phase: 'tuning', workers: 1, bytes: b.GiB, success: false, seconds: 900 }])[0];
  assert.equal(result.medianSeconds, null); assert.equal(result.medianMBps, null);
});
test('upload commands block to completion and never silently skip existing files', () => {
  const options = { source: '/tmp/payload.bin', folder, name: 'trial-001', workers: 8, config: '/private/config', batch: false };
  const rc = b.command('rfork', options);
  assert.equal(rc[0], 'copyto'); assert.ok(rc.includes('--ignore-times'));
  assert.equal(rc[rc.indexOf('--transfers') + 1], '1');
  assert.equal(rc[rc.indexOf('--mega-upload-concurrency') + 1], '8');
  const mc = b.command('megacmd', options);
  assert.equal(mc[0], 'put'); assert.ok(!mc.includes('-q')); assert.ok(!mc.includes('-c'));
  const mt = b.command('megatools', { ...options, workers: 5 });
  assert.ok(!mt.includes('--disable-boost'));
  assert.equal(mt[mt.indexOf('--chunk-size') + 1], '8388608');
  assert.equal(mt[mt.indexOf('--buffer-size') + 1], '524288');
  assert.ok(!mt.some(v => /^(-u|-p|--password|--username)$/.test(v)));
});
test('batch commands include all files once in stable order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-bench-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'part-01.bin'), 'b'); fs.writeFileSync(path.join(dir, 'part-00.bin'), 'a');
    const cmd = b.command('megatools', { source: dir, folder, name: 'trial-001', workers: 5, config: '/private/config', batch: true });
    assert.deepEqual(cmd.slice(-2), [path.join(dir, 'part-00.bin'), path.join(dir, 'part-01.bin')]);
    assert.equal(cmd[cmd.indexOf('--path') + 1], `/Root/${folder}/trial-001/`);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('cleanup guards reject roots, traversal and unrelated account directories', () => {
  assert.equal(b.assertFolder(folder), folder);
  for (const bad of ['/', '', 'm3-upload-bench-', folder + '/../unrelated', 'm3-ci-7afcf430-0c7b-4e93-a829-b4d4b07b0c6b']) assert.throws(() => b.assertFolder(bad));
  assert.throws(() => b.command('rfork', { folder, name: '../outside', workers: 8 }));
  assert.throws(() => b.settings('rfork', 33));
});
test('sensitive values and share links are removed from stored diagnostics', () => {
  const actual = b.redact('secret-password account@example.com obscured-key https://mega.nz/file/id#key', ['secret-password', 'obscured-key']);
  assert.ok(!/secret-password|account@example|obscured-key|mega.nz/.test(actual));
  assert.throws(() => b.configEscape('password\nnew-setting=value'));
  assert.equal(b.configEscape('a b\\c'), 'a\\sb\\\\c');
});
test('--plan and idempotent cleanup require neither secrets nor network', () => {
  const env = { PATH: process.env.PATH, BENCHMARK_PRIVATE: path.join(os.tmpdir(), 'm3-nonexistent-benchmark-' + process.pid) };
  const script = path.join(__dirname, 'benchmark-bundled-uploads.cjs');
  const planned = spawnSync(process.execPath, [script, '--plan'], { env, encoding: 'utf8' });
  assert.ifError(planned.error);
  assert.equal(planned.status, 0);
  assert.equal(JSON.parse(planned.stdout).totalFullSuiteUploadGiB, 33);
  const cleaned = spawnSync(process.execPath, [script, '--cleanup'], { env, encoding: 'utf8' });
  assert.equal(cleaned.status, 0); assert.match(cleaned.stdout, /already completed/);
});
test('phase lifecycle verifies bytes, rejects replay and preserves unrelated files during cleanup', () => {
  const crypto = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-bench-lifecycle-'));
  try {
    const binaryDir = path.join(dir, 'bin/linux'); fs.mkdirSync(binaryDir, { recursive: true });
    const fixture = '#!' + process.execPath + '\n' + fs.readFileSync(path.join(__dirname, 'benchmark-bundled-uploads.fixture.cjs'), 'utf8');
    for (const name of ['rfork', 'megatools', 'mega-exec', 'mega-cmd-server']) fs.writeFileSync(path.join(binaryDir, name), fixture, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'bin/rfork-bundle'));
    fs.writeFileSync(path.join(dir, 'bin/rfork-bundle/manifest.json'), JSON.stringify({ targets: [{ os: 'linux', sha256: crypto.createHash('sha256').update(fixture).digest('hex') }] }));
    fs.mkdirSync(path.join(dir, 'fake-remote/unrelated'), { recursive: true });
    const unrelated = path.join(dir, 'fake-remote/unrelated/keep.bin'); fs.writeFileSync(unrelated, 'keep');
    const output = path.join(dir, 'public'), privateDir = path.join(dir, 'private');
    const env = { PATH: process.env.PATH, RFORK_MEGA_EMAIL: 'offline@example.invalid', RFORK_MEGA_PASSWORD: 'offline-password', BENCHMARK_PRIVATE: privateDir, BENCHMARK_OUTPUT: output, BENCHMARK_SUITE: 'smoke' };
    const runner = `require(${JSON.stringify(path.join(__dirname, 'benchmark-bundled-uploads.cjs'))}).main(${JSON.stringify(dir)}).catch(e=>{console.error(e);process.exitCode=1})`;
    const result = spawnSync(process.execPath, ['-e', runner, '--', '--phase=smoke'], { env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
    assert.equal(report.runs.length, 3); assert.ok(report.runs.every(r => r.success && r.sizeVerified));
    assert.equal(report.checks.filter(c => c.kind === 'sha256' && c.matches).length, 3);
    assert.equal(report.complete, true); assert.deepEqual(report.completedPhases, ['smoke']);
    assert.equal(fs.existsSync(privateDir), true);
    const replay = spawnSync(process.execPath, ['-e', runner, '--', '--phase=smoke'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(replay.status, 1); assert.match(replay.stderr, /replay or skip/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).runs.length, 3);
    const cleaned = spawnSync(process.execPath, ['-e', runner, '--', '--cleanup'], { env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(cleaned.error); assert.equal(cleaned.status, 0, cleaned.stderr + cleaned.stdout);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).cleanup.verified, true);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep'); assert.equal(fs.existsSync(privateDir), false);
    const artifacts = fs.readdirSync(output).map(n => fs.readFileSync(path.join(output, n), 'utf8')).join('\n');
    assert.ok(!artifacts.includes('offline-password')); assert.ok(!artifacts.includes('offline@example.invalid')); assert.ok(!artifacts.includes('fake-obscured'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
