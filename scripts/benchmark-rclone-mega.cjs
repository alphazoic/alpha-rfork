'use strict';

// Live diagnostic only. Writes only its own UUID-named remote directory.
// No credentials, account names or MEGA session keys enter the public report.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { parseCSVLine } = require('../src/utils');
const root = path.resolve(__dirname, '..');
const binary = path.join(root, 'bin/linux/rclone');
if (process.argv.includes('--status')) {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'docs/rclone-https-benchmark.json'), 'utf8'));
  console.log(JSON.stringify({ runsFinished: report.runs.length, verification: report.verification,
    cleanup: report.cleanup, finishedAt: report.finishedAt || null }));
  for (const name of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('m3-rclone-https-'))) {
    const directory = path.join(os.tmpdir(), name);
    for (const filename of fs.readdirSync(directory).filter(filename => filename.includes('verify.bin'))) {
      try { console.log(JSON.stringify({ verificationBytes: fs.statSync(path.join(directory, filename)).size,
        partial: filename !== 'verify.bin' })); } catch { /* no active verification */ }
    }
  }
  process.exit(0);
}
const sizeMiB = Number(process.argv.find(arg => arg.startsWith('--size-mib='))?.split('=')[1] || 1024);
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 128 || sizeMiB > 4096) throw new Error('size-mib must be 128..4096');
const reportPath = path.join(root, 'docs/rclone-https-benchmark.json');
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rclone-https-'));
fs.chmodSync(privateDir, 0o700);
const configPath = path.join(privateDir, 'rclone.conf');
const megaConfig = path.join(privateDir, 'megatools.conf');
const file = path.join(privateDir, 'payload.bin');
const bytes = sizeMiB * 1024 ** 2;
const folder = 'm3-rclone-https-' + new Date().toISOString().slice(0, 10) + '-' + crypto.randomUUID();
const remote = 'benchmark:' + folder;
const report = { startedAt: new Date().toISOString(), fileBytes: bytes, remoteFolder: folder,
  uploadLimitSeconds: 600, warmupSeconds: 30, runs: [], verification: [], cleanup: {} };
let secrets = [], currentChild, interrupted = false, created = false;
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const print = value => console.log(JSON.stringify(value));
function redact(value) {
  let out = String(value);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out.replace(/https?:\/\/\S+/g, '[url]').slice(-3000);
}
function route() {
  try { const r = JSON.parse(execFileSync('ip', ['-j', 'route', 'get', '1.1.1.1'], { encoding: 'utf8' }))[0];
    return { interface: r.dev, gateway: r.gateway || null }; } catch { return null; }
}
function ports(pid) {
  try {
    const inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
      try { const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); return m ? [m[1]] : []; }
      catch { return []; }
    }));
    const found = new Set();
    for (const protocol of ['tcp', 'tcp6']) for (const row of fs.readFileSync(`/proc/${pid}/net/${protocol}`, 'utf8').trim().split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      if (inodes.has(fields[9]) && fields[3] === '01') found.add(parseInt(fields[2].split(':')[1], 16));
    }
    return [...found];
  } catch { return []; }
}
function socketTraffic(pid, connections) {
  try {
    const lines = execFileSync('ss', ['-Htinp'], { encoding: 'utf8', timeout: 1000 }).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(`pid=${pid},`)) continue;
      const fields = lines[i].trim().split(/\s+/), port = Number(fields[4]?.match(/:(\d+)$/)?.[1]);
      const sent = Number(lines[i + 1]?.match(/\bbytes_sent:(\d+)/)?.[1] || 0);
      if (port) { const key = fields[3] + '|' + fields[4], previous = connections.get(key);
        connections.set(key, { port, sent: Math.max(sent, previous?.sent || 0) }); }
    }
  } catch { /* lack of TCP_INFO is reported as absent transport evidence */ }
}
function execute(command, args, { timeout = 90000, input, progress = false, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    currentChild = child;
    let stdout = '', stderr = '', carry = '', timedOut = false, routeChanged = false, killTimer;
    const samples = [], observedPorts = new Set(), connections = new Map(), initialRoute = route();
    const stop = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    let lastPrint = 0;
    const watcher = setInterval(() => {
      if (!progress) return;
      for (const port of ports(child.pid)) observedPorts.add(port);
      socketTraffic(child.pid, connections);
      if (JSON.stringify(route()) !== JSON.stringify(initialRoute)) { routeChanged = true; stop(); }
      if (Date.now() - lastPrint > 30000) { lastPrint = Date.now(); const last = samples.at(-1);
        print({ event: 'progress', label, seconds: Math.round((Date.now() - started) / 1000), bytes: last?.bytes || 0 }); }
    }, 1000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-32768);
      carry += data;
      const lines = carry.split('\n'); carry = lines.pop();
      for (const line of lines) {
        try { const entry = JSON.parse(line); if (entry.stats) {
          const s = entry.stats, active = s.transferring?.[0];
          samples.push({ seconds: (Date.now() - started) / 1000, bytes: s.bytes || 0,
            fileBytes: active?.bytes ?? null, speed: s.speed || 0, errors: s.errors || 0,
            transfers: s.transfers || 0 });
        } } catch { /* other client output is retained privately until redacted */ }
      }
    });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); clearInterval(watcher); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); clearInterval(watcher);
      if (currentChild === child) currentChild = null;
      const socketBytesSentByPort = {};
      for (const { port, sent } of connections.values()) socketBytesSentByPort[port] = (socketBytesSentByPort[port] || 0) + sent;
      resolve({ code, signal, timedOut, routeChanged, seconds: (Date.now() - started) / 1000,
        stdout, stderr, samples, socketBytesSentByPort, observedPorts: [...observedPorts].sort((a, b) => a - b), route: initialRoute });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}
const options = ['--config', configPath, '--retries', '1', '--contimeout', '20s', '--timeout', '60s'];
async function rclone(args, opts) { return execute(binary, [...args, ...options], opts); }
function ensure(result, label) {
  if (result.code !== 0 || result.timedOut || result.routeChanged) throw new Error(label + ': ' + redact(result.stderr));
  return result;
}
async function digest(filename) {
  const hash = crypto.createHash('sha256'); for await (const part of fs.createReadStream(filename)) hash.update(part);
  return hash.digest('hex');
}
function summary(result) {
  const start = result.samples.find(s => s.seconds >= 30), end = result.samples.at(-1);
  return { code: result.code, signal: result.signal, timedOut: result.timedOut, routeChanged: result.routeChanged,
    seconds: result.seconds, observedPorts: result.observedPorts, socketBytesSentByPort: result.socketBytesSentByPort, route: result.route,
    reportedBytes: end?.bytes || 0, wholeFileMBps: result.code === 0 && !result.timedOut ? bytes / result.seconds / 1e6 : null,
    sustainedMBps: start && end.seconds > start.seconds ? (end.bytes - start.bytes) / (end.seconds - start.seconds) / 1e6 : null,
    errors: result.timedOut ? 'Stopped at the configured time limit' : result.signal ? 'Interrupted' : result.code !== 0 ? redact(result.stderr) : '', samples: result.samples };
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true; currentChild?.kill('SIGTERM');
});
async function main() {
  const cfg = JSON.parse(fs.readFileSync('/home/human/.config/M3/mega-dl-config.json', 'utf8'));
  const accounts = fs.readFileSync(path.join(cfg.dataDir, 'account_log.csv'), 'utf8')
    .split(/\r?\n/).slice(1).filter(Boolean).map(parseCSVLine);
  // Select a recently used, security-upgraded account with ample recorded room.
  const index = accounts.findIndex(row => /active|alive/i.test(row[5]) && row[6] === 'Yes' && +row[2] < 1 && row[0] && row[1]);
  if (index < 0) throw new Error('No suitable saved account');
  const [email, password] = accounts[index];
  secrets = [email, password];
  if (/[\r\n]/.test(email + password)) throw new Error('Multiline credentials are unsupported');
  report.accountRowIndex = index;
  const obscured = ensure(await execute(binary, ['obscure', '-'], { input: password + '\n' }), 'Password preparation').stdout.trim();
  secrets.push(obscured);
  fs.writeFileSync(configPath, `[benchmark]\ntype = mega\nuser = ${email}\npass = ${obscured}\n`, { mode: 0o600 });
  fs.writeFileSync(megaConfig, `[Login]\nUsername = ${email}\nPassword = ${password}\n`, { mode: 0o600 });
  report.rcloneVersion = ensure(await execute(binary, ['version']), 'Version').stdout.trim();
  report.binarySha256 = await digest(binary);
  report.route = route();
  const quota = JSON.parse(ensure(await rclone(['about', 'benchmark:', '--json', '--mega-use-https=true']), 'Account quota').stdout);
  report.initialQuota = quota;
  if (!(quota.free >= bytes * 6)) throw new Error('Insufficient live free space for benchmark');
  print({ event: 'preflight', freeGiB: quota.free / 1024 ** 3, route: report.route }); save();
  // Seeded from fresh random blocks, rather than a sparse or all-zero file.
  const fd = fs.openSync(file, 'wx', 0o600), block = Buffer.alloc(4 * 1024 ** 2);
  try { for (let written = 0; written < bytes; written += block.length) {
    crypto.randomFillSync(block); fs.writeSync(fd, block); } } finally { fs.closeSync(fd); }
  report.sha256 = await digest(file); save();
}

// A missing folder is expected; use parent listing to avoid treating it as failure.
async function experiment() {
  const listed = ensure(await rclone(['lsjson', 'benchmark:', '--dirs-only', '--mega-use-https=true']), 'Root directory check');
  if (JSON.parse(listed.stdout).some(entry => entry.Name === folder)) throw new Error('Benchmark folder already exists');
  ensure(await rclone(['mkdir', remote, '--mega-use-https=true']), 'Test directory creation'); created = true; save();
  for (const [i, https] of [false, true, true, false].entries()) {
    if (interrupted) break;
    const label = `${i + 1}-${https ? 'https' : 'http'}`, name = label + '.bin';
    print({ event: 'starting', label });
    const result = await rclone(['copyto', file, `${remote}/${name}`, `--mega-use-https=${https}`,
      '--transfers', '1', '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'],
    { timeout: 600000, progress: true, label });
    report.runs.push({ label, https, name, ...summary(result) }); save();
    print({ event: 'finished', label, ...summary(result), samples: undefined });
    if (result.routeChanged) throw new Error('Network route changed during comparison');
  }
  if (!interrupted) {
    const name = 'megatools.bin'; print({ event: 'starting', label: 'megatools' });
    const result = await execute(path.join(root, 'bin/linux/megatools'), ['put', '--config', megaConfig,
      '--no-ask-password', '--disable-previews', '--no-progress', '--workers', String(cfgWorkers()),
      '--path', `/Root/${folder}/${name}`, file], { timeout: 600000, progress: true, label: 'megatools' });
    report.runs.push({ label: 'megatools', name, workers: cfgWorkers(), ...summary(result) }); save();
    print({ event: 'finished', label: 'megatools', ...summary(result), samples: undefined });
  }
  for (const https of [false, true]) {
    if (interrupted) break;
    const run = report.runs.find(r => r.https === https && r.code === 0 && !r.timedOut);
    if (!run) { report.verification.push({ https, status: 'no completed upload' }); save(); continue; }
    const target = path.join(privateDir, 'verify.bin');
    print({ event: 'verifying', label: run.label });
    const result = await rclone(['copyto', `${remote}/${run.name}`, target, '--mega-use-https=true',
      '--transfers', '1', '--multi-thread-streams', '0'], { timeout: 600000 });
    const hash = result.code === 0 ? await digest(target) : null;
    report.verification.push({ label: run.label, seconds: result.seconds, sha256: hash,
      matches: hash === report.sha256, error: result.code === 0 ? '' : redact(result.stderr) });
    if (fs.existsSync(target)) fs.unlinkSync(target); save();
  }
}
function cfgWorkers() {
  const cfg = JSON.parse(fs.readFileSync('/home/human/.config/M3/mega-dl-config.json', 'utf8'));
  return Math.min(100, Math.max(1, parseInt(cfg.uploadWorkers, 10) || 3));
}

(async () => {
  try { await main(); await experiment(); }
  catch (error) { report.error = redact(error.message); print({ event: 'error', message: report.error }); process.exitCode = 1; }
  finally {
    if (created) {
      const result = await rclone(['purge', remote, '--mega-use-https=true', '--mega-hard-delete=true'], { timeout: 120000 });
      report.cleanup.remotePurgeSucceeded = result.code === 0;
      if (result.code !== 0) report.cleanup.error = redact(result.stderr);
      else {
        const check = await rclone(['lsjson', 'benchmark:', '--dirs-only', '--mega-use-https=true']);
        report.cleanup.remoteAbsenceVerified = check.code === 0 && !JSON.parse(check.stdout).some(entry => entry.Name === folder);
      }
    }
    // Remove only the known diagnostic files and directory we created.
    const partials = fs.readdirSync(privateDir).filter(name => name.includes('verify.bin') && name.endsWith('.partial'));
    for (const name of ['rclone.conf', 'rclone.conf.old', 'megatools.conf', 'payload.bin', 'verify.bin', ...partials]) {
      const p = path.join(privateDir, name); if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    try { fs.rmdirSync(privateDir); report.cleanup.privateFilesRemoved = true; } catch { report.cleanup.privateFilesRemoved = false; }
    report.finishedAt = new Date().toISOString(); save(); print({ event: 'complete', reportPath, cleanup: report.cleanup });
  }
})();
