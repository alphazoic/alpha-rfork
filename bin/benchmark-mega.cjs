'use strict';

// Real-account diagnostic. Credentials belong in a private rclone/megatools
// config supplied by the caller; reports contain no credentials or share keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const i = arg.indexOf('='); return [arg.slice(0, i), arg.slice(i + 1)];
}));
const phase = args['--phase'] || 'smoke';
if (!['smoke', 'speed', 'large', 'probe', 'cleanup'].includes(phase)) throw new Error('invalid phase');
const config = args['--config'];
const remoteName = args['--remote'] || 'benchmark';
const megaBin = args['--megatools'];
const megaConfig = args['--megatools-config'];
if (!config || !megaBin || !megaConfig || !/^[a-zA-Z0-9_-]+$/.test(remoteName)) throw new Error('supply --config, --remote, --megatools and --megatools-config');
const stock = path.join(root, 'build/rclone-v1.75.2-stock');
const fork = path.join(root, 'build/rfork-linux-amd64');
const reportDir = path.join(root, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const reportFile = path.join(reportDir, phase + '.json');
const folder = phase === 'cleanup' ? args['--cleanup-folder'] : 'rfork-test-' + phase + '-' + crypto.randomUUID();
if (!/^rfork-test-(smoke|speed|large|probe)-[a-f0-9-]{36}$/.test(folder || '')) throw new Error('invalid test folder');
const remote = `${remoteName}:${folder}`;
const work = fs.mkdtempSync(path.join(root, 'build/private-' + phase + '-'));
fs.chmodSync(work, 0o700);
const report = { phase, startedAt: new Date().toISOString(), remoteFolder: folder, runs: [], checks: [], cleanup: {} };
let current, interrupted = false, created = false, cleaning = false;
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const emit = value => console.log(JSON.stringify(value));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; current?.kill('SIGINT'); });

function route() {
  try { const r = JSON.parse(execFileSync('ip', ['-j', 'route', 'get', '1.1.1.1'], { encoding: 'utf8' }))[0]; return { interface: r.dev, gateway: r.gateway || null }; }
  catch { return null; }
}
function capture(pid, totals, resource) {
  try {
    const lines = execFileSync('ss', ['-Htinp'], { encoding: 'utf8', timeout: 1000 }).split('\n');
    let active = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(`pid=${pid},`)) {
      const fields = lines[i].trim().split(/\s+/), port = Number(fields[4]?.match(/:(\d+)$/)?.[1]);
      const sent = Number(lines[i + 1]?.match(/\bbytes_sent:(\d+)/)?.[1] || 0);
      const key = fields[3] + '|' + fields[4];
      totals.set(key, { port, sent: Math.max(sent, totals.get(key)?.sent || 0) });
      if ((port === 80 || port === 443) && sent > 32768) active++;
    }
    resource.peakBulkConnections = Math.max(resource.peakBulkConnections, active);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    resource.peakRssKiB = Math.max(resource.peakRssKiB, Number(status.match(/VmHWM:\s+(\d+)/)?.[1] || 0));
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    // Linux USER_HZ is obtained once rather than inferred from wall time.
    resource.cpuSecondsSampled = (Number(stat[11]) + Number(stat[12])) / resource.clockTicks;
  } catch { /* unavailable host diagnostics remain zero */ }
}
const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
async function execute(binary, argv, { label = '', timeout = 600000, cancelAtBytes, expectedBytes = null } = {}) {
  if (interrupted && !cleaning) throw new Error('Interrupted');
  const started = Date.now(), initialRoute = route(), totals = new Map();
  const resource = { peakRssKiB: 0, cpuSecondsSampled: 0, peakBulkConnections: 0, clockTicks };
  const child = spawn(binary, argv, { stdio: ['ignore', 'pipe', 'pipe'] }); current = child;
  let stdout = '', stderr = '', carry = '', timedOut = false, routeChanged = false, cancelSentAt = null, forceTimer;
  const samples = [];
  const stop = () => { child.kill('SIGINT'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 10000); };
  const deadline = setTimeout(() => { timedOut = true; stop(); }, timeout);
  let lastLog = 0;
  const timer = setInterval(() => {
    capture(child.pid, totals, resource);
    if (JSON.stringify(route()) !== JSON.stringify(initialRoute)) { routeChanged = true; stop(); }
    if (label && Date.now() - lastLog > 30000) {
      lastLog = Date.now(); emit({ event: 'progress', label, seconds: Math.round((Date.now() - started) / 1000), bytes: samples.at(-1)?.bytes ?? null });
    }
  }, 1000);
  child.stdout.on('data', b => { stdout = (stdout + b).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', b => {
    stderr = (stderr + b).slice(-32768); carry += b;
    const lines = carry.split('\n'); carry = lines.pop();
    for (const line of lines) try {
      const o = JSON.parse(line); if (!o.stats) continue;
      const s = o.stats;
      samples.push({ seconds: (Date.now() - started) / 1000, bytes: s.bytes || 0, errors: s.errors || 0, speed: s.speed || 0 });
      if (cancelAtBytes && !cancelSentAt && s.bytes >= cancelAtBytes) { cancelSentAt = Date.now(); stop(); }
    } catch { /* logs are only retained in memory until an error is classified */ }
  });
  return await new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(deadline); clearTimeout(forceTimer); clearInterval(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(forceTimer); clearInterval(timer); if (current === child) current = null;
      const seconds = (Date.now() - started) / 1000, sentByPort = {};
      for (const { port, sent } of totals.values()) sentByPort[port] = (sentByPort[port] || 0) + sent;
      const first = samples.find(s => s.seconds >= 30), last = samples.at(-1);
      resolve({ label, code, signal, seconds, timedOut, routeChanged, route: initialRoute,
        cancelExitSeconds: cancelSentAt ? (Date.now() - cancelSentAt) / 1000 : null,
        MBps: code === 0 && expectedBytes !== null ? expectedBytes / seconds / 1e6 : null,
        sustainedMBps: first && last.seconds > first.seconds ? (last.bytes - first.bytes) / (last.seconds - first.seconds) / 1e6 : null,
        sentByPort, resource, samples, stdout, stderr });
    });
  });
}
const rcOptions = ['--config', config, '--retries', '1', '--low-level-retries', '3', '--contimeout', '20s', '--timeout', '60s', '--mega-use-https=true'];
const stats = ['--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'];
const clean = result => {
  const { stdout, stderr, ...publicResult } = result;
  if (result.code !== 0) {
    let message = stderr;
    for (const file of [config, megaConfig]) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:user|pass|session_id|master_key|Username|Password)\s*=\s*(.+)$/i);
        if (m) message = message.split(m[1].trim()).join('[redacted]');
      }
    }
    publicResult.error = result.timedOut ? 'Time limit' : result.cancelExitSeconds !== null ? 'Intentional cancellation'
      : message.replace(/https?:\/\/\S+/g, '[url]').replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[account]').slice(-4000);
  }
  return publicResult;
};
function ensure(result, operation) {
  if (result.code !== 0 || result.timedOut || result.routeChanged) throw new Error(`${operation} failed (exit ${result.code}, timeout ${result.timedOut}, route changed ${result.routeChanged})`);
  return result;
}
async function rc(binary, argv, options) { return execute(binary, [...argv, ...rcOptions], options); }
async function hash(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
function payload(name, size) {
  const file = path.join(work, name), fd = fs.openSync(file, 'wx', 0o600), block = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
  try { for (let i = 0; i < size; i += block.length) { crypto.randomFillSync(block); fs.writeSync(fd, block, 0, Math.min(block.length, size - i)); } }
  finally { fs.closeSync(fd); }
  return file;
}
async function upload(file, name, concurrency, label, binary = fork) {
  emit({ event: 'starting', label });
  const flags = binary === fork ? ['--mega-upload-concurrency', String(concurrency)] : [];
  const result = await rc(binary, ['copyto', file, `${remote}/${name}`, '--transfers', '1', ...flags, ...stats],
    { label, expectedBytes: fs.statSync(file).size });
  report.runs.push({ name, concurrency, binary: path.basename(binary), ...clean(result) }); save();
  emit({ event: 'finished', ...clean(result), samples: undefined }); ensure(result, label);
  return result;
}
async function verify(name, source, independent = true, allowFailure = false) {
  const target = path.join(work, 'verify.bin');
  for (const name of fs.readdirSync(work).filter(name => name.includes('verify.bin'))) fs.unlinkSync(path.join(work, name));
  emit({ event: 'verifying', name, client: independent ? 'megatools' : 'rfork' });
  let result = independent
    ? await execute(megaBin, ['get', '--config', megaConfig, '--reload', '--no-ask-password', '--no-progress', '--disable-resume', '--path', target, `/Root/${folder}/${name}`], { timeout: 600000 })
    : await rc(fork, ['copyto', `${remote}/${name}`, target], { timeout: 600000 });
  for (let attempt = 1; independent && attempt < 4 && result.code !== 0 && /SSL connect error|HTTP POST failed|CURL error|Connection timed out/i.test(result.stderr); attempt++) {
    report.checks.push({ kind: 'verificationClientTransient', name, attempt, ...clean(result) }); save();
    emit({ event: 'retrying-independent-client', name, attempt });
    await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    for (const name of fs.readdirSync(work).filter(name => name.includes('verify.bin'))) fs.unlinkSync(path.join(work, name));
    result = await execute(megaBin, ['get', '--config', megaConfig, '--reload', '--no-ask-password', '--no-progress', '--disable-resume', '--path', target, `/Root/${folder}/${name}`], { timeout: 600000 });
  }
  if (result.code !== 0) {
    report.checks.push({ kind: 'downloadError', name, independentClient: independent, ...clean(result) }); save();
    if (allowFailure) return false;
  }
  ensure(result, 'Verification download');
  const expected = await hash(source), actual = await hash(target);
  report.checks.push({ kind: 'sha256', name, independentClient: independent, expected, actual, matches: expected === actual, seconds: result.seconds }); save();
  fs.unlinkSync(target); if (expected !== actual) throw new Error('SHA-256 mismatch');
}
async function smoke() {
  const sizes = [0, 1, 15, 16, 17, 131071, 131072, 131073, 8 * 1024 * 1024 + 31];
  for (const size of sizes) {
    const name = `boundary-${size}.bin`, source = payload(name, size);
    await upload(source, name, 4, name); await verify(name, source); fs.unlinkSync(source);
  }
  for (const concurrency of [1, 2, 8]) {
    const name = `workers-${concurrency}.bin`, source = payload(name, 8 * 1024 * 1024 + 17);
    await upload(source, name, concurrency, name); await verify(name, source); fs.unlinkSync(source);
  }
  const source = payload('overwrite.bin', 1024 * 1024 + 17);
  await upload(source, 'overwrite.bin', 4, 'overwrite-first');
  const replacement = payload('replacement.bin', 1024 * 1024 + 31);
  await upload(replacement, 'overwrite.bin', 4, 'overwrite-replacement'); await verify('overwrite.bin', replacement);
  const listed = JSON.parse(ensure(await rc(fork, ['lsjson', remote]), 'Listing').stdout);
  if (listed.filter(x => x.Name === 'overwrite.bin').length !== 1) throw new Error('Duplicate replacement object');
  const link = ensure(await rc(fork, ['link', `${remote}/overwrite.bin`]), 'Link').stdout.trim();
  report.checks.push({ kind: 'link', valid: /^https:\/\/mega\.(?:co\.nz|nz)\//.test(link) });
  if (!report.checks.at(-1).valid) throw new Error('Invalid file link'); save();
  const directory = path.join(work, 'multi'); fs.mkdirSync(directory);
  for (let i = 0; i < 2; i++) fs.renameSync(payload(`multi-${i}.bin`, 8 * 1024 * 1024 + i), path.join(directory, `file-${i}.bin`));
  ensure(await rc(fork, ['copy', directory, `${remote}/multi`, '--transfers', '2', '--mega-upload-concurrency', '4']), 'Multiple concurrent files');
  for (let i = 0; i < 2; i++) await verify(`multi/file-${i}.bin`, path.join(directory, `file-${i}.bin`));
  const cancelSource = payload('cancel-source.bin', 512 * 1024 * 1024);
  const stopped = await rc(fork, ['copyto', cancelSource, `${remote}/cancelled.bin`, '--transfers', '1', '--mega-upload-concurrency', '4', ...stats],
    { label: 'cancel-live-upload', cancelAtBytes: 8 * 1024 * 1024 });
  report.checks.push({ kind: 'cancellation', ...clean(stopped) }); save();
  if (stopped.code === 0 || stopped.cancelExitSeconds === null || stopped.cancelExitSeconds > 10) throw new Error('Cancellation did not stop promptly');
  const after = JSON.parse(ensure(await rc(fork, ['lsjson', remote]), 'Cancelled-file inspection').stdout);
  report.checks.push({ kind: 'cancelledFileAbsent', absent: !after.some(x => x.Name === 'cancelled.bin') }); save();
  if (!report.checks.at(-1).absent) throw new Error('Cancelled file requires reconciliation');
}
async function speed() {
  const size = 512 * 1024 * 1024, source = payload('speed.bin', size); report.fileBytes = size; report.sha256 = await hash(source); save();
  const sequence = [['stock-a', stock, null], ['rfork-1', fork, 1], ['rfork-2', fork, 2], ['rfork-4', fork, 4], ['rfork-8', fork, 8]];
  for (const [label, binary, n] of sequence) await upload(source, label + '.bin', n, label, binary);
  emit({ event: 'starting', label: 'megatools-5' });
  const mega = await execute(megaBin, ['put', '--config', megaConfig, '--reload', '--no-ask-password', '--no-progress', '--disable-previews', '--workers', '5', '--path', `/Root/${folder}/megatools.bin`, source],
    { label: 'megatools-5', expectedBytes: size });
  report.runs.push({ name: 'megatools.bin', workers: 5, ...clean(mega) }); save(); emit({ event: 'finished', ...clean(mega), samples: undefined }); ensure(mega, 'megatools baseline');
  const best = report.runs.filter(x => [2, 4, 8].includes(x.concurrency)).sort((a, b) => b.MBps - a.MBps)[0]; report.selectedConcurrency = best.concurrency; save();
  await upload(source, 'selected-a.bin', best.concurrency, 'selected-a');
  await upload(source, 'stock-b.bin', null, 'stock-b', stock);
  await upload(source, 'selected-b.bin', best.concurrency, 'selected-b');
  await verify('selected-b.bin', source); await verify('stock-b.bin', source);
}
async function large() {
  const concurrency = Number(args['--workers'] || 8), size = 2 * 1024 ** 3;
  const source = payload('large.bin', size); report.fileBytes = size; report.sha256 = await hash(source); save();
  await upload(source, 'large.bin', concurrency, `large-${concurrency}`); await verify('large.bin', source);
}
async function probe() {
  for (const size of [0, 1, 1024 * 1024]) {
    const source = payload(`probe-${size}.bin`, size);
    for (const [label, binary] of [['stock', stock], ['rfork', fork]]) {
      const name = `${label}-${size}.bin`;
      const flags = binary === fork ? ['--mega-upload-concurrency', '4'] : [];
      const result = await rc(binary, ['copyto', source, `${remote}/${name}`, '--transfers', '1', ...flags, ...stats], { label: name, timeout: 90000, expectedBytes: size });
      report.runs.push({ name, ...clean(result) }); save(); emit({ event: 'probe', ...clean(result), samples: undefined });
      if (result.code === 0) { await verify(name, source, true, true); await verify(name, source, false, true); }
    }
  }
}
(async () => {
  try {
    if (phase === 'cleanup') { created = true; report.success = true; return; }
    report.route = route(); report.forkSHA256 = await hash(fork); report.stockSHA256 = await hash(stock);
    report.version = ensure(await execute(fork, ['version']), 'Version').stdout.trim();
    report.quotaBefore = JSON.parse(ensure(await rc(fork, ['about', `${remoteName}:`, '--json']), 'Quota').stdout);
    // Upstream's unsigned subtraction can make an over-quota account's Free
    // field enormous. Derive available space from both verified counters.
    const available = report.quotaBefore.total - report.quotaBefore.used;
    report.verifiedAvailableBytes = available;
    if (!Number.isSafeInteger(available) || available < 8 * 1024 ** 3) throw new Error('Need at least 8 GiB actual free space for isolated benchmark');
    const parent = JSON.parse(ensure(await rc(fork, ['lsjson', `${remoteName}:`, '--dirs-only']), 'Unique folder check').stdout);
    if (parent.some(x => x.Name === folder)) throw new Error('Test folder already exists');
    ensure(await rc(fork, ['mkdir', remote]), 'Create test folder'); created = true; save();
    if (phase === 'smoke') await smoke(); else if (phase === 'speed') await speed(); else if (phase === 'probe') await probe(); else await large();
    report.success = true;
  } catch (error) { report.error = error.message; report.success = false; emit({ event: 'error', message: error.message }); process.exitCode = 1; }
  finally {
    cleaning = true;
    try {
    if (created) {
      const purged = await rc(fork, ['purge', remote, '--mega-hard-delete=true'], { timeout: 120000 });
      report.cleanup.remotePurgeSucceeded = purged.code === 0;
      if (purged.code !== 0) throw new Error('Remote test-folder purge failed');
      if (purged.code === 0) {
        const result = await rc(fork, ['lsjson', `${remoteName}:`, '--dirs-only']);
        report.cleanup.remoteAbsenceVerified = result.code === 0 && !JSON.parse(result.stdout).some(x => x.Name === folder);
        if (!report.cleanup.remoteAbsenceVerified) throw new Error('Remote test-folder absence not verified');
      }
    }
    } catch (error) { report.cleanup.error = error.message; process.exitCode = 1; }
    // This private directory is created exclusively by this invocation.
    fs.rmSync(work, { recursive: true, force: true }); report.cleanup.localPayloadsRemoved = true;
    report.finishedAt = new Date().toISOString(); save(); emit({ event: 'complete', success: report.success, reportFile, cleanup: report.cleanup });
  }
})();
