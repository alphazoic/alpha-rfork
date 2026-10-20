'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { createNetworkOperations } = require('./network-operations');
const { ProtonVpnError } = require('./protonvpn');
const { createUploadProgress, createUploadVpnSession } = require('./upload-vpn-session');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(5); } throw new Error('Condition timed out'); }

function load(mocks) {
  const filename = path.join(__dirname, 'upload-engine.js'), mod = { exports: {} };
  const req = id => Object.hasOwn(mocks, id) ? mocks[id] : id.startsWith('.') ? require(path.resolve(__dirname, id)) : require(id);
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(req, mod, mod.exports);
  return mod.exports;
}
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-upload-'));
  let route = 'CH#1', connects = 0, config = {}, creations = 0;
  const invocations = [], events = [], accountWrites = [], quota = [], commands = [];
  const adapter = {
    async getStatus() { if (options.statusError) throw new ProtonVpnError('COMMAND_FAILED', 'status', 0);
      return { state: route ? 'connected' : 'disconnected', server: route ? { id: route } : null }; },
    async diagnose() { return { ready: true, diagnostics: [], capabilities: await this.inspect() }; },
    async inspect() { return { commands: { connect: true, status: true }, selectors: { random: true, server: true } }; },
    async connect(target) {
      connects++;
      if (options.failConnections > 0) {
        options.failConnections--; route = null;
        const { ProtonVpnError } = require('./protonvpn');
        const error = new ProtonVpnError('CONNECTION_FAILED'); error.terminationConfirmed = true; throw error;
      }
      if (options.connect) await options.connect(); route = target.server || 'DE#2'; return this.getStatus();
    },
  };
  const controller = createVpnController({ adapter, ...options.controllerOptions });
  const service = createVpnService({ controller, adapter, catalogStore: require('../scripts/vpn-test-catalog.cjs'), platform: 'linux', loadConfig: () => config, saveConfig: value => { config = value; } });
  await service.saveSettings({ enabled: true, required: false, uploadRecoveryEnabled: !options.disabled,
    preferredServers: ['CH#1', 'DE#2'],
    warmupMs: 0, averagingMs: 10, uploadDurationMs: 20, uploadThresholdBps: 1000000, recoveryCooldownMs: 0, ...options.vpn });
  const network = createNetworkOperations(controller, { terminationGraceMs: 100, spawn(cmd, args, opts) {
    invocations.push({ cmd, args, route });
    if (options.nativeLocal && cmd === 'rclone' && args[0] === 'copyto') {
      const { BUNDLE_OS } = require('./rfork-bundle');
      const binary = path.join(__dirname, '..', 'bin', BUNDLE_OS[process.platform], process.platform === 'win32' ? 'rfork.exe' : 'rfork');
      const local = [...args]; local[2] = path.join(dir, 'remote', args[2].replace(/^:mega:/, ''));
      return spawn(binary, local, opts);
    }
    // Actual child processes exercise close/abort ordering without accounts or VPN.
    const code = (typeof options.child === 'function' ? options.child(cmd, args, invocations.length) : options.child) || `process.stdout.write('1.0%\\r'); setTimeout(()=>process.stdout.write('2.0%\\r'),30); setTimeout(()=>process.exit(0),120);`;
    return spawn(process.execPath, ['-e', code], opts);
  } });
  const csv = path.join(dir, 'files.csv'); fs.writeFileSync(csv, '');
  const mocks = {
    './network-operations': network,
    './rfork-checkpoints': { newCheckpoint: () => path.join(dir, 'checkpoint-' + require('crypto').randomUUID()) },
    './upload-vpn-session': { createUploadVpnSession: options => createUploadVpnSession({ ...options, tickMs: 5 }) },
    './config': { loadConfig: () => ({ tempDir: dir, ...options.config }), getDataDir: () => dir, getFileCsv: () => csv, getAccountCsv: () => path.join(dir, 'accounts.csv'), getMediainfoLog: () => path.join(dir, 'media.jsonl') },
    './proc-utils': { execRetry: async (_cmd, args) => { commands.push(args); if (options.linkFailure && args[0] === 'link') throw new Error('link unavailable'); return args[0] === 'ls' ? 'folder\nhttps://mega.nz/file/test#key' : 'https://mega.nz/file/test#key'; }, runCommandWithTimeout: async (_cmd, args) => { commands.push(args); return 'https://mega.nz/file/test#key'; }, runCommand: async () => '', runCommandWithProgress: async (_cmd, args) => { if (options.archive) { fs.writeFileSync(args.at(-2) + '.001', 'part one'); fs.writeFileSync(args.at(-2) + '.002', 'part two'); } } },
    './megacmd': { ensureMegaCmdServer: async () => {}, megaSwitch: async () => {}, megaCmdBin: () => 'mega-exec', megaEnv: () => ({}), megaSpawnOpts: () => ({}), getMegacmdFolderLink: async () => 'https://mega.nz/folder/test#key' },
    './rclone': { obscurePass: async () => 'obscured', rcloneRemote: () => ':mega,fixture:' },
    './account-manager': { touchAccountRow() {}, updateAccountRow: (...args) => accountWrites.push(args), markAccountOverQuota: email => quota.push(email) },
    './account-creator': { registerMegaAccount: async () => { creations++; throw new Error('fixture-account-creation-stopped'); } },
    './account-usage': { queryActualUsageKb: async () => 0 }, '../binPath': { getBinPath: name => name },
  };
  const upload = load(mocks); upload.installUploadVpn(service);
  const files = ['first.bin', 'second.bin'].map(name => { const file = path.join(dir, name); fs.writeFileSync(file, Buffer.alloc(options.size ?? 1000)); return file; });
  const send = (channel, data) => events.push({ channel, data });
  const start = (tool = 'megatools', queue = files) => upload.startUpload({ queue, manualEmail: 'same@example.test', manualPassword: 'fixture-password', uploadToolOrder: Array.isArray(tool) ? tool : [tool], folderName: 'folder' }, send);
  t.after(async () => { upload.killQueue(); service.dispose(); controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { upload, start, files, network, controller, service, events, invocations, csv, quota, accountWrites, commands, dir,
    get connects() { return connects; }, get creations() { return creations; } };
}

test('progress normalizes split terminal percentages, ANSI, integer percentages, JSON byte counters and regressions', () => {
  for (const tool of ['megatools', 'megacmd']) {
    const samples = [], progress = createUploadProgress(tool, 1000, bytes => samples.push(bytes));
    progress.feed('\\x1b[0m'.replace('\\x1b', '\x1b') + '1'); progress.feed('.5 %\r2%\n1%\r'); progress.flush();
    assert.equal(samples.reduce((a, b) => a + b, 0), 20);
  }
  const samples = [], progress = createUploadProgress('rclone', 1000, bytes => samples.push(bytes));
  progress.feed('{"stats":{"by', 'stderr'); progress.feed('tes":30}}\n{"stats":{"bytes":20}}\n', 'stderr');
  progress.feed('{"stats":{"bytes":1001}}\nnot JSON\n', 'stderr');
  assert.deepEqual(samples, [30, 0]);
});

test('rfork uses an explicit account-relative destination, HTTPS, eight workers and one whole-file attempt', async t => {
  const a = await fixture(t, { disabled: true }); await a.start('rclone', [a.files[0]]);
  const args = a.invocations[0].args;
  assert.equal(args[0], 'copyto'); assert.equal(args[2], ':mega:folder/first.bin');
  for (const [flag, value] of [['--mega-upload-concurrency', '8'], ['--transfers', '1'], ['--retries', '1'], ['--low-level-retries', '1']]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--mega-use-https=true')); assert.ok(args.includes('--ignore-times'));
  assert.ok(!args.join(' ').includes('fixture-password'));
  assert.ok(a.commands.some(args => args[0] === 'mkdir' && !args[1].includes('/Root/')));
  assert.ok(a.commands.some(args => args[0] === 'link' && !args[1].includes('/Root/')));
});

for (const disabled of [true, false]) test(`rfork uncertain finalization overrides quota and blocks fallback/restart (recovery disabled=${disabled})`, async t => {
  const message = JSON.stringify({ level: 'error', msg: 'MEGA finalization failed; remote outcome may be uncertain, inspect before retrying: exceeded your available storage' });
  const a = await fixture(t, { disabled, child: (_cmd, _args, n) => n === 1 ? `process.stderr.write(${JSON.stringify(message)}); process.exit(6)` : 'process.exit(0)' });
  await a.start(['rclone', 'megatools'], [a.files[0]]);
  assert.equal(a.invocations.length, 1); assert.equal(a.quota.length, 0); assert.equal(a.creations, 0);
  assert.equal(fs.readFileSync(a.csv, 'utf8'), ''); assert.ok(fs.existsSync(a.files[0]));
  assert.ok(a.events.some(e => e.channel === 'up:log' && /completion is uncertain/i.test(e.data)));
  await a.start('rclone', [a.files[0]]); assert.equal(a.invocations.length, 1);
});

test('rfork split/final JSON statistics survive buffering and a failed share link never repeats a completed upload', async t => {
  const a = await fixture(t, { disabled: true, size: 2 * 1024 * 1024, linkFailure: true,
    child: `process.stderr.write('{"stats":{"by'); setTimeout(()=>{process.stderr.write('tes":2097152,"totalBytes":2097152,"speed":100}}');process.exit(0)},20)` });
  const work = a.start('rclone', [a.files[0]]);
  await until(() => a.creations > 0 || a.events.some(e => e.channel === 'up:link'));
  if (a.creations > 0) a.upload.killQueue();
  await work;
  assert.equal(a.invocations.length, 1); assert.equal(a.events.filter(e => e.channel === 'up:link').length, 1);
  assert.equal(a.events.find(e => e.channel === 'up:link').data.link, '');
  assert.ok(a.events.some(e => e.channel === 'up:progress' && e.data.filePct === 100));
});

test('rfork fast and empty successful uploads need no periodic statistics record', async t => {
  for (const size of [0, 2 * 1024 * 1024]) {
    const a = await fixture(t, { disabled: true, size, child: 'process.exit(0)' }); await a.start('rclone', [a.files[0]]);
    assert.equal(a.events.filter(e => e.channel === 'up:link').length, 1); assert.equal(a.creations, 0);
  }
});

test('rfork definite login failure retains the configured fallback even with VPN recovery enabled', async t => {
  const a = await fixture(t, { child: (_cmd, _args, n) => n === 1 ? `process.stderr.write("couldn't login: invalid password");process.exit(1)` : 'process.exit(0)' });
  await a.start(['rclone', 'megatools'], [a.files[0]]);
  assert.equal(a.invocations.length, 2); assert.equal(a.events.filter(e => e.channel === 'up:link').length, 1);
});

test('rfork Skip retains the uncertain source/hold but continues a distinct pending file on the same account', async t => {
  const a = await fixture(t, { disabled: true, child: (_cmd, _args, n) => n === 1 ? `process.stderr.write('{"stats":{"bytes":1}}\\n');setInterval(()=>{},1000)` : 'process.exit(0)' });
  const work = a.start('rclone'); await until(() => a.events.some(e => e.channel === 'up:progress'));
  a.upload.cancelCurrentFile(); await work;
  assert.equal(a.invocations.length, 2); assert.equal(a.events.filter(e => e.channel === 'up:link').length, 1);
  assert.equal(a.events.find(e => e.channel === 'up:link').data.name, 'second.bin');
  assert.ok(fs.existsSync(a.files[0]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, 'upload-recovery.json'), 'utf8')).entries.length, 1);
  await a.start('megatools', [a.files[0]]); assert.equal(a.invocations.length, 2);
});

test('committed archive parts are recorded/deleted once; an uncertain part and its original remain recoverable', async t => {
  const a = await fixture(t, { disabled: true, size: 2 * 1024 * 1024, archive: true, config: { splitThresholdGb: 0.001 },
    child: (_cmd, _args, n) => n === 1 ? 'process.exit(0)' : `process.stderr.write('MEGA finalization failed; remote outcome may be uncertain');process.exit(6)` });
  await a.start('rclone', [a.files[0]]);
  assert.equal(a.invocations.length, 2);
  assert.equal(fs.readFileSync(a.csv, 'utf8').trim().split('\n').length, 1);
  const held = require('./upload-journal').createUploadJournal(a.dir).read()[0];
  assert.equal(fs.existsSync(path.join(path.dirname(held.source), 'first.bin.7z.001')), false);
  assert.equal(fs.readFileSync(held.source, 'utf8'), 'part two');
  assert.notEqual(path.dirname(held.source), a.dir);
  assert.ok(fs.existsSync(a.files[0]));
});

test('M3 engine runs its bundled rfork with production flags and verifies the resulting local payload hash', { skip: process.arch !== 'x64' || !['linux', 'win32', 'darwin'].includes(process.platform) }, async t => {
  const a = await fixture(t, { disabled: true, nativeLocal: true, size: 2 * 1024 * 1024 });
  const crypto = require('node:crypto'), payload = crypto.randomBytes(2 * 1024 * 1024); fs.writeFileSync(a.files[0], payload);
  await a.start('rclone', [a.files[0]]);
  const actual = fs.readFileSync(path.join(a.dir, 'remote/folder/first.bin'));
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(hash(actual), hash(payload));
  assert.equal(a.events.filter(e => e.channel === 'up:link').length, 1);
});

for (const tool of ['megatools', 'rclone']) {
  test(`${tool}: sustained low speed waits for completion, then switches once and retains account/order`, async t => {
    const child = tool === 'rclone' ? `process.stderr.write('{"stats":{"bytes":10,"totalBytes":1000}}\\n');setTimeout(()=>process.exit(0),120);` : undefined;
    const a = await fixture(t, { child }); await a.start(tool);
    assert.equal(a.connects, 1); assert.equal(a.creations, 0);
    assert.equal(a.invocations.length, 2); assert.deepEqual(a.invocations.map(item => item.route), ['CH#1', 'DE#2']);
    assert.equal(a.events.filter(item => item.channel === 'up:link').length, 2);
    assert.equal(fs.readFileSync(a.csv, 'utf8').trim().split('\n').length, 2);
    assert.ok(a.events.some(item => item.channel === 'up:vpnState' && item.data.state === 'deferred'));
    assert.ok(a.events.filter(item => item.channel === 'up:link').every(item => item.data.email === 'same@example.test'));
  });
}

test('MEGAcmd progress supports space before percent and file completion without restarting', async t => {
  const a = await fixture(t, { child: `process.stdout.write('(1/1 MB: 1.00 %)\\r');setTimeout(()=>process.exit(0),120);` });
  await a.start('megacmd'); assert.equal(a.connects, 1); assert.equal(a.invocations.length, 2); assert.equal(a.creations, 0);
});
test('upload queue survives failed candidates and round exhaustion at a completed-file boundary', async t => {
  const a = await fixture(t, { failConnections: 1, vpn: { preferredServers: ['CH#1', 'DE#2', 'US#3'],
    connectionRetry: { initialDelayMs: 0, maxCandidates: 1, roundRetryDelayMs: 20 } } });
  await a.start();
  assert.equal(a.connects, 2); assert.equal(a.invocations.length, 2); assert.equal(a.creations, 0);
  assert.deepEqual(a.invocations.map(item => item.route), ['CH#1', 'US#3']);
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 2);
  assert.equal(fs.readFileSync(a.csv, 'utf8').trim().split('\n').length, 2);
  assert.ok(a.events.some(item => item.channel === 'up:vpnState' && item.data.message.includes('candidates are exhausted')));
});

test('unrecognised output does not become zero speed or trigger ghost-file rotation', async t => {
  const a = await fixture(t, { child: 'setTimeout(()=>process.exit(0),100)' });
  await a.start(); assert.equal(a.connects, 0); assert.equal(a.creations, 0);
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 2);
});

test('zero-progress stall remains active without account demotion; Kill stops without recording success', async t => {
  const a = await fixture(t, { child: `process.stdout.write('0%\\r');setInterval(()=>{},1000);` });
  const work = a.start(); await until(() => a.events.some(item => item.data?.state === 'deferred'));
  assert.equal(a.connects, 0); assert.equal(a.creations, 0);
  a.upload.killQueue(); await work;
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 0); assert.equal(fs.readFileSync(a.csv, 'utf8'), '');
  assert.equal(a.controller.snapshot().activeOperations.length, 0);
});

test('uncertain exit and existing-name collision stop before fallback, account creation or false completion', async t => {
  for (const code of [1, 2]) {
    const a = await fixture(t, { child: `process.exit(${code})` }); await a.start();
    assert.equal(a.invocations.length, 1); assert.equal(a.creations, 0); assert.equal(a.quota.length, 0);
    assert.equal(a.events.filter(item => item.channel === 'up:link').length, 0);
    assert.ok(a.events.some(item => item.channel === 'up:log' && /completion is uncertain/.test(item.data)));
  }
});

for (const tool of ['megatools', 'megacmd', 'rclone']) test(`${tool}: explicit storage exhaustion still marks quota and attempts existing account rotation`, async t => {
  const a = await fixture(t, { child: `process.stderr.write('You have exceeded your available storage'); process.exit(1);` });
  const work = a.start(tool); await until(() => a.creations > 0); a.upload.killQueue(); await work;
  assert.deepEqual(a.quota, ['same@example.test']); assert.equal(a.connects, 0);
});

test('completion racing with a pending speed alarm never retries the completed file', async t => {
  const a = await fixture(t); await a.start('megatools', [a.files[0]]);
  assert.equal(a.connects, 0); assert.equal(a.invocations.length, 1);
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 1);
});

test('disabled upload policy retains old route without scheduling VPN recovery', async t => {
  const a = await fixture(t, { disabled: true }); await a.start(); assert.equal(a.connects, 0);
  assert.equal(a.events.filter(item => item.channel === 'up:vpnState').length, 0);
});

test('simultaneous upload/download alarms share one switch after upload releases its lease', async t => {
  const a = await fixture(t); const work = a.start();
  await until(() => a.events.some(item => item.data?.state === 'deferred'));
  const plan = a.service.beginDownload(); const recovered = plan.recover(undefined, 'speed');
  await work; await recovered; plan.close(); assert.equal(a.connects, 1); assert.equal(a.invocations.length, 2);
});

test('Stop during boundary recovery cancels waiting and prevents the next upload', async t => {
  let entered = false, release; const barrier = new Promise(resolve => { release = resolve; });
  const a = await fixture(t, { connect: async () => { entered = true; await barrier; } });
  const work = a.start(); await until(() => entered); a.upload.killQueue(); release(); await work;
  assert.equal(a.invocations.length, 1); assert.equal(a.controller.snapshot().waitingOperations.length, 0);
  assert.equal(a.service.snapshot().transferring, false);
});

test('yielding a route blocks traffic without a lease and respects account-session changes before reacquiring', async t => {
  const a = await fixture(t); let visited = false;
  await a.network.run('upload', async () => {
    await a.network.yieldRoute(async () => {
      assert.throws(() => a.network.checkpoint(), error => error.code === 'LEASE_INVALID');
      await a.network.run('single-account', async () => { visited = true; });
    });
    a.network.checkpoint('megacmd-session');
  });
  assert.equal(visited, true); assert.equal(a.controller.snapshot().activeOperations.length, 0);
});


test('tunnel loss stops an uncertain file without retries, quota markings, or account rotation', async t => {
  const a = await fixture(t, { child: `process.stdout.write('1%\\r');setInterval(()=>{},1000);` });
  const work = a.start(); await until(() => a.invocations.length === 1);
  a.controller.reportTunnelLoss(); await work;
  assert.equal(a.invocations.length, 1); assert.equal(a.creations, 0); assert.equal(a.quota.length, 0);
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 0);
  assert.ok(a.events.some(item => item.channel === 'up:log' && /Check the current remote file/.test(item.data)));
  assert.equal(a.service.snapshot().transferring, false);
});
test('persistent status uncertainty stops an uncertain upload without automatically replaying its file', async t => {
  const options = { controllerOptions: { statusGraceMs: 15 }, child: `process.stdout.write('1%\\r');setInterval(()=>{},1000);` };
  const a = await fixture(t, options), work = a.start(); await until(() => a.invocations.length === 1);
  options.statusError = true; await a.controller.poll(); assert.equal(a.controller.snapshot().state, 'checking');
  await work;
  assert.equal(a.invocations.length, 1); assert.equal(a.creations, 0); assert.equal(a.quota.length, 0);
  assert.equal(a.events.filter(item => item.channel === 'up:link').length, 0);
  assert.ok(a.events.some(item => item.channel === 'up:log' && /Check the current remote file/.test(item.data)));
});

test('Skip cancels only the active upload and continues the same account without recording that file', async t => {
  const a = await fixture(t); const work = a.start();
  await until(() => a.events.some(item => item.data?.state === 'deferred'));
  a.upload.cancelCurrentFile(); await work;
  const links = a.events.filter(item => item.channel === 'up:link');
  assert.equal(links.length, 1); assert.equal(links[0].data.name, 'second.bin');
  assert.equal(links[0].data.email, 'same@example.test'); assert.equal(a.creations, 0); assert.equal(a.connects, 0);
});


test('a large file with no progress and an early successful tool exit is held rather than falsely completed', async t => {
  const a = await fixture(t, { size: 2 * 1024 * 1024, child: 'process.exit(0)' });
  await a.start(); assert.equal(a.invocations.length, 1); assert.equal(a.creations, 0); assert.equal(a.connects, 0);
  assert.equal(fs.readFileSync(a.csv, 'utf8'), '');
  assert.ok(a.events.some(item => item.channel === 'up:log' && /completion is uncertain/.test(item.data)));
});


test('M3 retains a failed resume session, refuses fallback, and recovers it with resume preference off', async t => {
  let attempts = 0;
  const options = { disabled: true, config: { rforkUpload: { resume: true, workers: 5, bundling: true, bundleSizeMiB: 2 } },
    child: (_cmd, args) => {
      if (args[0] !== 'backend') throw new Error('Expected explicit resume operation');
      attempts++;
      return attempts === 1 ? `process.stderr.write('checkpoint retained');process.exit(6)` :
        `process.stdout.write(JSON.stringify({status:'committed',node:'same-node',restoredAcknowledgedBytes:300,pendingSourceBytes:700,sourceBytesRead:1000}));process.exit(0)`;
    } };
  const a = await fixture(t, options);
  await a.start(['rclone','megatools'], [a.files[0]]);
  const journal = require('./upload-journal').createUploadJournal(a.dir);
  const record = journal.read()[0]; assert.ok(record.checkpoint); assert.equal(attempts,1); assert.equal(a.creations,0);
  await a.start('rclone',[a.files[0]]);assert.equal(attempts,1);
  options.config.rforkUpload = { resume: false, workers: 6 };
  const result = await a.upload.resumeSavedUpload({ id:record.id,password:'original-password' },(channel,data)=>a.events.push({channel,data}));
  assert.equal(result.ok,true);assert.equal(result.restoredAcknowledgedBytes,300);assert.equal(attempts,2);
  assert.ok(a.invocations[1].args.includes('checkpoint='+record.checkpoint));
  assert.equal(a.invocations[1].args[a.invocations[1].args.indexOf('--mega-upload-concurrency')+1],'6');
  assert.equal(journal.read().length,0);assert.equal(fs.readFileSync(a.csv,'utf8').trim().split('\n').length,1);
  assert.ok(fs.existsSync(a.files[0]));assert.equal(a.creations,0);
});

test('resume recovery rejects changed source or HTTP before spawning or altering the hold', async t => {
  const options={disabled:true,config:{rforkUpload:{resume:true}},child:`process.exit(6)`};
  const a=await fixture(t,options);await a.start('rclone',[a.files[0]]);
  const journal=require('./upload-journal').createUploadJournal(a.dir);const record=journal.read()[0];
  fs.appendFileSync(a.files[0],'changed');
  assert.equal((await a.upload.resumeSavedUpload({id:record.id,password:'fixture'},()=>{})).ok,false);
  fs.truncateSync(a.files[0],1000);options.config.rforkUpload={https:false};
  const result=await a.upload.resumeSavedUpload({id:record.id,password:'fixture'},()=>{});
  assert.equal(result.ok,false);assert.match(result.error,/HTTPS/);assert.equal(a.invocations.length,1);assert.equal(journal.read().length,1);
});
