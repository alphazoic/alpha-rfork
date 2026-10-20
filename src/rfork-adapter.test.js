'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { uploadWithRfork } = require('./rfork-upload');
const { createUploadJournal } = require('./upload-journal');
const { reviewUploadRecovery } = require('./upload-recovery-review');
const { createRforkOutput } = require('./rfork-output');
const { megaToolPath } = require('./mega-paths');
const { rforkEnvironment } = require('./rfork-environment');
const { runCommand } = require('./proc-utils');
const { BUNDLE_OS } = require('./rfork-bundle');
const root = path.resolve(__dirname, '..');

test('test-account Trash cleanup accepts only UUID fixture folders with known payload names', () => {
  const { ownedTrashFolder } = require('../scripts/cleanup-rfork-trash.cjs');
  const folder = '/Trash/m3-ci-11111111-2222-4333-8444-555555555555';
  assert.equal(ownedTrashFolder(folder, [folder, folder + '/payload ünicode.bin', folder + '/empty.bin']), true);
  for (const other of ['/Trash', '/Root/' + path.basename(folder), folder + '/../anything', '/Trash/m3-ci-not-a-uuid']) {
    assert.equal(ownedTrashFolder(other, []), false);
  }
  for (const other of [folder + '/my-file.txt', folder + '/subdir/empty.bin', '/Trash/unrelated']) {
    assert.equal(ownedTrashFolder(folder, [other]), false);
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rfork-adapter-'));
  const source = path.join(directory, 'source.bin'); fs.writeFileSync(source, 'payload');
  const journal = createUploadJournal(directory);
  const record = journal.begin({ account: 'fixture@example.test', destination: 'folder/file.bin', source, bytes: 7 });
  let child;
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = (code, options = {}) => uploadWithRfork({ binary: 'rfork', source, destination: record.destination, bytes: 7,
    env: rforkEnvironment('fixture@example.test', 'obscured-private-value'), journal, record,
    spawn: () => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] }),
    onSpawn(value) { child = value; }, onStats() {}, cancelled: () => false, ...options });
  return { directory, journal, record, run, source };
}

test('100% read progress followed by a nonzero exit remains held, including after a new journal instance', async t => {
  const f = fixture(t);
  await assert.rejects(f.run(`process.stderr.write('{"stats":{"bytes":7}}');process.exit(1)`), error => error.code === 'UPLOAD_UNCERTAIN');
  assert.equal(createUploadJournal(f.directory).read()[0].state, 'uncertain');
  assert.throws(() => createUploadJournal(f.directory).assertClear(), /completion is uncertain/);
  assert.ok(fs.existsSync(f.source));
  assert.ok(!fs.readFileSync(path.join(f.directory, 'upload-recovery.json'), 'utf8').includes('obscured-private-value'));
});

test('post-commit old-version removal failure and contradictory successful exit cannot trigger replay', async t => {
  for (const [message, code] of [['upload failed to remove old version: quota exceeded', 1], ['MEGA finalization failed; remote outcome may be uncertain', 0]]) {
    const f = fixture(t);
    await assert.rejects(f.run(`process.stderr.write(${JSON.stringify(message)});process.exit(${code})`), error => error.code === 'UPLOAD_UNCERTAIN' && !error.overQuota);
    assert.equal(f.journal.read()[0].state, 'uncertain');
  }
});

test('a missing executable is a definite failure, closes first, and clears the in-flight hold', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('', { spawn: () => spawn(path.join(f.directory, 'missing-tool')) }), error => error.rforkPreCommit === true);
  assert.equal(f.journal.read().length, 0);
});

test('Skip escalates a child that ignores SIGTERM and waits for actual closure before returning', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); let cancel = false, observed = false;
  const work = f.run(`process.on('SIGTERM',()=>{});process.stderr.write('{"stats":{"bytes":1}}\\n');setInterval(()=>{},1000)`, {
    onStats() { observed = true; cancel = true; }, cancelled: () => cancel,
  });
  await assert.rejects(work, error => error.cancelled && error.uploadUncertain);
  assert.ok(observed); assert.equal(f.journal.read()[0].state, 'uncertain');
});

test('a crash after successful process close but before CSV recording leaves a committed hold', async t => {
  const f = fixture(t); await f.run('process.exit(0)');
  assert.equal(f.journal.read()[0].state, 'committed');
  assert.throws(() => createUploadJournal(f.directory).assertClear(), /completion is uncertain/);
});

test('review defaults to holding, requires explicit inspection, and rejects concurrent journal changes', async t => {
  const f = fixture(t), options = { directory: () => f.directory, busy: () => false };
  const declined = await reviewUploadRecovery({ ...options, confirm: async detail => { assert.match(detail, /fixture@example.test/); assert.match(detail, /folder\/file.bin/); return false; } });
  assert.equal(declined.ok, false); assert.equal(f.journal.read().length, 1);
  const changed = await reviewUploadRecovery({ ...options, confirm: async () => { f.journal.update(f.record.id, 'committed'); return true; } });
  assert.equal(changed.ok, false); assert.equal(f.journal.read().length, 1);
  const accepted = await reviewUploadRecovery({ ...options, confirm: async () => true });
  assert.equal(accepted.ok, true); assert.equal(f.journal.read().length, 0);
  fs.writeFileSync(path.join(f.directory, 'upload-recovery.json'), '{broken');
  assert.throws(() => createUploadJournal(f.directory).assertClear(), error => error.uploadUncertain);
});

test('progress decoder handles split UTF-8, unterminated final records and oversized noise without retaining logs', () => {
  const stats = [], parser = createRforkOutput(item => stats.push(item.bytes));
  const line = Buffer.from(JSON.stringify({ msg: 'é', stats: { bytes: 7 } }));
  for (const byte of line) parser.feed(Buffer.from([byte]));
  parser.flush(); assert.deepEqual(stats, [7]);
  parser.feed('x'.repeat(100000) + '\n' + JSON.stringify({ msg: 'MEGA finalization failed' })); parser.flush();
  assert.equal(parser.uncertain, true);
});

test('cross-provider paths strip only megatools virtual Root and retain real Root directories', () => {
  assert.equal(megaToolPath('/Root/folder/file', 'megatools', 'rclone'), 'folder/file');
  assert.equal(megaToolPath('/Root/Root/file', 'megatools', 'rclone'), 'Root/file');
  assert.equal(megaToolPath('/Root/file', 'rclone', 'megatools'), '/Root/Root/file');
  assert.equal(megaToolPath('/Root/file', 'megacmd', 'rclone'), 'Root/file');
  assert.equal(megaToolPath('/folder/file', 'rclone', 'megacmd'), '/folder/file');
});

test('browsing and fallback link generation preserve a real Root directory through M3 import APIs', async () => {
  const commands = [], module = { exports: {} };
  const mocks = {
    './network-operations': { wrap: (_kind, fn) => fn, interruption() {} },
    './config': { loadConfig: () => ({ toolOrderView: ['rclone'] }) },
    '../binPath': { getBinPath: () => 'rfork' },
    './megacmd': { ensureMegaCmdServer: async () => { throw new Error('fixture unavailable'); } },
    './rclone': { obscurePass: async () => 'obscured', rcloneRemote: () => ':mega' },
    './proc-utils': { runCommand: async (_cmd, args) => { commands.push(args); return args[0] === 'lsjson' ? JSON.stringify([{ Path: 'Root/file.bin', Size: 7, IsDir: false }]) : 'https://mega.nz/file/fixture#key'; } },
    './account-manager': {},
  };
  const filename = path.join(__dirname, 'import-engine.js');
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    id => Object.hasOwn(mocks, id) ? mocks[id] : require(id.startsWith('.') ? path.resolve(__dirname, id) : id), module, module.exports);
  const browse = await module.exports.browseAccountFiles({ email: 'fixture@example.test', password: 'fixture' });
  assert.equal(browse.ok, true); assert.equal(browse.tool, 'rclone');
  assert.equal(browse.data.files[0].handle, '/Root/file.bin');
  const result = await module.exports.getAccountFileLinks({ email: 'fixture@example.test', password: 'fixture', paths: ['/Root/file.bin'], tool: 'megacmd' });
  assert.equal(result.ok, true); assert.equal(commands.at(-1)[1], ':mega:Root/file.bin');
});

test('a filename mentioned in an unknown error cannot impersonate a proven pre-commit failure', () => {
  const output = createRforkOutput();
  output.feed(JSON.stringify({ msg: 'Failed to copy: network failure reading file named "couldn\'t login: test"' }));
  output.flush(); assert.equal(output.preCommit, false);
  output.feed('quota exceeded\n'); assert.equal(output.quota, true);
  output.feed('unknown failure after transfer\n'); assert.equal(output.quota, false);
  output.feed("couldn't login: fixture\n"); assert.equal(output.preCommit, true);
  output.feed(JSON.stringify({ level: 'error', msg: 'Failed to copy: unknown error after transfer' }));
  output.flush(); assert.equal(output.preCommit, false);
});

test('password obscuring uses stdin and remote parameters quote commas and quotes', async () => {
  let captured;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'rclone.js'), 'utf8'), {
    module, require: id => id === '../binPath' ? { getBinPath: () => 'rfork' } :
      id === './proc-utils' ? { runCommand: async (...args) => { captured = args; return 'obscured\n'; } } : require(id),
  });
  const password = 'single-line fixture password';
  await module.exports.obscurePass(password);
  assert.deepEqual(Array.from(captured[1]), ['obscure', '-']); assert.equal(captured[2].input, password + '\n');
  assert.ok(!captured[1].includes(password));
  assert.equal(module.exports.rcloneRemote('a,"b@example.test', 'key'), ':mega,user="a,""b@example.test",pass="key"');
});

test('usage reads used bytes and ignores overflowing free-space reports', async () => {
  let response = { total: 10, used: 20, free: 18446744073709551600 };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'account-usage.js'), 'utf8'), { module,
    require: id => id === '../binPath' ? { getBinPath: () => 'rfork' } : id === './rclone' ? { obscurePass: async () => 'x', rcloneRemote: () => ':mega' } :
      id === './megacmd' ? {} : id === './proc-utils' ? { runCommandWithTimeout: async () => JSON.stringify(response) } : require(id),
  });
  assert.equal(await module.exports.queryActualUsageKb('a', 'b', 'rclone'), 20 / 1024);
  response = { used: -1 }; assert.equal(await module.exports.queryActualUsageKb('a', 'b', 'rclone'), null);
});

const nativeOS = BUNDLE_OS[process.platform], binary = nativeOS && path.join(root, 'bin', nativeOS, process.platform === 'win32' ? 'rfork.exe' : 'rfork');
test('real bundled CLI accepts Unicode password via stdin without putting it in argv', { skip: !nativeOS || process.arch !== 'x64' }, async () => {
  const password = 'fixture-π-"-comma, space';
  const out = (await runCommand(binary, ['obscure', '-'], { env: rforkEnvironment(), input: password + '\n' })).trim();
  const data = Buffer.from(out, 'base64url');
  const key = Buffer.from('9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638', 'hex');
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, data.subarray(0, 16));
  assert.equal(Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8'), password);
});

test('real bundled CLI executes the adapter flags and emits a committed local-copy result', { skip: !nativeOS || process.arch !== 'x64' }, async t => {
  const f = fixture(t), destination = path.join(f.directory, 'destination.bin');
  await f.run('', { binary, env: rforkEnvironment(), spawn: (command, args, options) => {
    const local = [...args]; local[2] = destination;
    return spawn(command, local, options);
  } });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'payload');
  assert.equal(f.journal.read()[0].state, 'committed');
});

test('new settings reach the child and unsafe diagnostic fields never reach callbacks', async t => {
  const f = fixture(t); let argv, diagnostics;
  await f.run(`process.stderr.write(JSON.stringify({megaUpload:{workers:5,sourceBytes:7,secret:'private',chunks:{payloadBytesRead:14,acknowledgedBytes:7,url:'private'}}})+'\\n')`, {
    settings: { workers: 5, bundling: true, bundleSizeMiB: 2, pacingMs: 0, dataRetries: 3 },
    onDiagnostics(value) { diagnostics = value; },
    spawn(_binary, args) { argv = args; return spawn(process.execPath, ['-e', `process.stderr.write(JSON.stringify({megaUpload:{workers:5,sourceBytes:7,secret:'private',chunks:{payloadBytesRead:14,acknowledgedBytes:7,url:'private'}}})+'\\n')`], { stdio: ['ignore','pipe','pipe'] }); },
  });
  assert.equal(argv[argv.indexOf('--mega-upload-concurrency') + 1], '5');
  assert.equal(argv[argv.indexOf('--mega-upload-request-size') + 1], '2097152B');
  assert.equal(diagnostics.chunks.payloadBytesRead, 14); assert.ok(!JSON.stringify(diagnostics).includes('private'));
});

test('resume requires structured commit proof and retains the same checkpoint after every failure', async t => {
  for (const [result, code, accepted] of [
    [{status:'committed',node:'native-node',restoredAcknowledgedBytes:3,pendingSourceBytes:4,sourceBytesRead:7},0,true],
    [{status:'already-committed',node:'native-node',restoredAcknowledgedBytes:7,pendingSourceBytes:0,sourceBytesRead:0},0,true],
    [{status:'committed'},0,false], [null,0,false], [{status:'committed',node:'native-node',restoredAcknowledgedBytes:3,pendingSourceBytes:4,sourceBytesRead:7},6,false],
  ]) {
    const f = fixture(t); let argv;
    const record = { ...f.record, checkpoint: path.join(f.directory, 'private-state') };
    const promise = f.run('', { record, settings: { resume:true }, spawn(_binary,args) {
      argv=args;return spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(result))});process.exit(${code})`],{stdio:['ignore','pipe','pipe']});
    } });
    if (accepted) { const value = await promise; assert.equal(value.node,'native-node'); }
    else { await assert.rejects(promise, e=>e.uploadUncertain); assert.equal(f.journal.read().length,1); }
    assert.deepEqual(argv.slice(0,3),['backend','upload-resume',':mega:folder']);
    assert.ok(argv.includes('checkpoint='+record.checkpoint)); assert.ok(!argv.includes('--ignore-times')); assert.ok(!argv.includes('--buffer-size'));
  }
});
