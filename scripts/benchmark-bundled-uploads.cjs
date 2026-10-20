'use strict';

// Deliberate live-account benchmark. Only --plan and the unit tests are offline.
// No raw client logs, configs, credentials, session keys or share links are artifacts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const tools = ['megatools', 'megacmd', 'rfork'];
const baseline = { megatools: 5, megacmd: 10, rfork: 8 };
const sweep = { megatools: [5, 10, 20, 40], megacmd: [10, 20, 40], rfork: [1, 4, 8, 16, 32] };
const folderPattern = /^m3-upload-bench-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function assertFolder(folder) {
  if (!folderPattern.test(folder)) throw new Error('Refusing an unowned benchmark path');
  return folder;
}
function settings(tool, workers) {
  if (!tools.includes(tool) || !Number.isInteger(workers) || workers < 1 || workers > (tool === 'rfork' ? 32 : 100)) throw new Error('Invalid tool/concurrency');
  return tool === 'megatools' ? { workers, chunkBytes: 8 * MiB, bufferBytes: 512 * 1024, boost: true, transport: 'client-default' }
    : tool === 'megacmd' ? { uploadConnections: workers, transport: 'client-default' }
      : { chunkWorkers: workers, fileTransfers: 1, transport: 'https', retries: 1, lowLevelRetries: 1 };
}
function rounds(phase, chosen = baseline) {
  return Array.from({ length: 3 }, (_, round) => tools.map((_, j) => {
    const tool = tools[(j + round) % tools.length];
    return { phase, round: round + 1, tool, workers: chosen[tool], bytes: GiB, batch: false };
  })).flat();
}
function tuning() {
  // Interleave tools rather than giving one tool an entire time window.
  const trials = [];
  for (let i = 0; i < 5; i++) for (const tool of tools) if (sweep[tool][i]) trials.push({ phase: 'tuning', round: i + 1, tool, workers: sweep[tool][i], bytes: GiB, batch: false });
  return trials;
}
function choose(runs, tool) {
  const candidates = runs.filter(r => r.tool === tool && r.phase === 'tuning' && r.success && r.sizeVerified && Number.isFinite(r.seconds) && r.seconds > 0);
  if (!candidates.length) return baseline[tool];
  // Exploratory single trials nominate a setting; three NEW trials confirm it.
  return [...candidates].sort((a, b) => a.seconds - b.seconds || a.workers - b.workers)[0].workers;
}
function median(values) {
  const a = [...values].sort((x, y) => x - y), n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null;
}
function summarize(runs) {
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.phase}/${r.tool}/${r.workers}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map(group => {
    const ok = group.filter(r => r.success && r.sizeVerified), times = ok.map(r => r.seconds);
    const seconds = median(times);
    return { phase: group[0].phase, tool: group[0].tool, workers: group[0].workers, attempts: group.length, completed: ok.length,
      medianSeconds: seconds, minSeconds: times.length ? Math.min(...times) : null, maxSeconds: times.length ? Math.max(...times) : null,
      medianMBps: seconds ? group[0].bytes / seconds / 1e6 : null };
  });
}
function redact(value, secrets = []) {
  let s = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) s = s.split(secret).join('[redacted]');
  return s.replace(/https?:\/\/\S+/g, '[url]').replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[account]');
}
function configEscape(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Testing credentials must be single lines');
  return value.replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\t/g, '\\t');
}
function command(tool, { source, folder, name, workers, config, batch }) {
  assertFolder(folder);
  if (!/^trial-\d{3}$/.test(name)) throw new Error('Invalid trial name');
  settings(tool, workers);
  const target = `${folder}/${name}`;
  if (tool === 'megatools') return ['put', '--config', config, '--reload', '--no-ask-password', '--disable-previews',
    '--workers', String(workers), '--chunk-size', String(8 * MiB), '--buffer-size', String(512 * 1024),
    '--path', `/Root/${target}${batch ? '/' : '/payload.bin'}`, ...(batch ? fs.readdirSync(source).sort().map(n => path.join(source, n)) : [source])];
  if (tool === 'megacmd') return ['put', source, `/${target}/`]; // Foreground: NEVER -q.
  return [batch ? 'copy' : 'copyto', source, `benchmark:${target}${batch ? '' : '/payload.bin'}`, '--config', config,
    '--mega-use-https=true', '--mega-upload-concurrency', String(workers), '--transfers', '1', '--retries', '1', '--low-level-retries', '1',
    '--ignore-times', '--contimeout', '20s', '--timeout', '60s', '--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE'];
}

async function main(root = path.resolve(__dirname, '..')) {
  const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'all';
  const phaseOrder = ['smoke', 'baseline', 'tuning', 'confirmation', 'batch'];
  if (!['all', ...phaseOrder].includes(phase)) throw new Error('Invalid benchmark phase');
  const privateDir = process.env.BENCHMARK_PRIVATE;
  const output = process.env.BENCHMARK_OUTPUT || path.join(root, 'benchmark-results');
  if (process.argv.includes('--plan')) {
    console.log(JSON.stringify({ baseline, sweep, baselineTrials: rounds('baseline'), tuningTrials: tuning(),
      confirmationTrials: 9, batchTrials: 3, totalFullSuiteUploadGiB: 33, smokeUploadMiB: 3 }, null, 2)); return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This suite requires Linux x64');
  if (!privateDir || !path.isAbsolute(privateDir) || path.resolve(privateDir) === path.parse(privateDir).root) throw new Error('An absolute BENCHMARK_PRIVATE directory is required');
  if (process.argv.includes('--cleanup') && !fs.existsSync(path.join(privateDir, 'state.json'))) {
    console.log('No outstanding benchmark state; cleanup already completed.'); return;
  }
  const email = process.env.RFORK_MEGA_EMAIL, password = process.env.RFORK_MEGA_PASSWORD;
  if (!email || !password) throw new Error('RFORK_MEGA_EMAIL and RFORK_MEGA_PASSWORD are required');
  configEscape(email); configEscape(password);
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateDir, 0o700);
  fs.mkdirSync(output, { recursive: true });
  const reportFile = path.join(output, 'results.json'), stateFile = path.join(privateDir, 'state.json');
  const bin = { megatools: path.join(root, 'bin/linux/megatools'), megacmd: path.join(root, 'bin/linux/mega-exec'), rfork: path.join(root, 'bin/linux/rfork'), server: path.join(root, 'bin/linux/mega-cmd-server') };
  const secrets = [email, password];
  const childEnv = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin:' + path.join(root, 'bin/linux'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: privateDir, TMPDIR: privateDir };
  let report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { schemaVersion: 1, startedAt: new Date().toISOString(), runs: [], checks: [], cleanup: {} };
  let interrupted = false, server = null, active = null, cleaning = false;
  const started = performance.now(), clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { folder: 'm3-upload-bench-' + crypto.randomUUID(), created: false };
  assertFolder(state.folder);
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  saveState();
  report.remoteFolder = state.folder;
  function save() {
    report.summary = summarize(report.runs);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    const fmt = n => n == null ? '—' : n.toFixed(2);
    const rows = report.summary.map(g => `| ${g.phase} | ${g.tool} | ${g.workers} | ${g.completed}/${g.attempts} | ${fmt(g.medianSeconds)} | ${fmt(g.minSeconds)}–${fmt(g.maxSeconds)} | ${fmt(g.medianMBps)} |`);
    const checks = report.checks.filter(c => c.kind === 'sha256');
    fs.writeFileSync(path.join(output, 'summary.md'), [
      '# Bundled MEGA upload benchmark', '',
      '1 GiB = 1,073,741,824 bytes. MB/s is decimal. Single-file times include fresh client/session startup, authentication and upload finalization. Payload generation, destination setup, independent listing, downloads and cleanup are outside timing.', '',
      'All contenders run sequentially in the same Debian 13 container on one GitHub-hosted Ubuntu 24.04 VM. Baseline/confirmation use three rotated rounds. Tuning is exploratory; confirmation uses new uploads. Native retry behavior differs and is recorded.', '',
      '| Phase | Tool | Workers/connections | Completed/attempted | Median seconds | Range seconds | Effective MB/s |',
      '|---|---|---:|---:|---:|---:|---:|', ...rows, '',
      `SHA-256 checks: ${checks.filter(c => c.matches).length} passed; ${checks.filter(c => c.matches === false).length} mismatched; ${checks.filter(c => c.matches == null).length} unavailable. See results.json for per-trial status and errors.`, '',
      `Selected concurrency: ${JSON.stringify(report.selected || {})}`, '',
      `Suite complete: ${Boolean(report.complete)}. Cleanup verified: ${Boolean(report.cleanup.verified)}.`,
      report.error ? `Suite error: ${report.error}` : '', '',
      'Megatools uses 8 MiB chunks, 512 KiB buffer and boost throughout. MEGAcmd/megatools retain their default transport; rfork uses HTTPS. Higher connection counts rejected or clamped by a client are recorded and excluded from tuning. Progress counters and network counters are diagnostic only, not proof of committed bytes.',
    ].join('\n') + '\n');
    const cols = ['phase', 'round', 'tool', 'workers', 'bytes', 'seconds', 'MBps', 'success', 'sizeVerified', 'error'];
    const csv = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
    fs.writeFileSync(path.join(output, 'trials.csv'), [cols.join(','), ...report.runs.map(r => cols.map(c => csv(r[c])).join(','))].join('\n') + '\n');
  }
  const emit = value => console.log(JSON.stringify(value));
  const killGroup = child => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ } };
  function identity(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      return { pid, startTicks: stat[19], status: stat[0] };
    } catch { return null; }
  }
  async function reapSavedGroup(key) {
    const saved = state[key];
    if (!saved) return;
    const current = identity(saved.pid);
    if (current && current.startTicks === saved.startTicks && current.status !== 'Z') {
      killGroup(saved);
      for (let i = 0; i < 30; i++) {
        const now = identity(saved.pid);
        if (!now || now.startTicks !== saved.startTicks || now.status === 'Z') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const after = identity(saved.pid);
      if (after && after.startTicks === saved.startTicks && after.status !== 'Z') throw new Error('An owned upload process has not confirmed termination');
    }
    delete state[key]; saveState();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; killGroup(active); killGroup(server); });
  function resource(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      return { cpu: (Number(stat[11]) + Number(stat[12])) / clockTicks, rss: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) };
    } catch { return { cpu: 0, rss: 0 }; }
  }
  function netBytes() {
    try { return fs.readFileSync('/proc/net/dev', 'utf8').split('\n').filter(l => l.includes(':') && !l.trim().startsWith('lo:')).reduce((n, l) => n + Number(l.split(':')[1].trim().split(/\s+/)[8]), 0); }
    catch { return null; }
  }
  async function execute(binary, args, { timeout = 90000, env = childEnv, input, sample = false, onSample } = {}) {
    if (interrupted && !cleaning) throw new Error('Interrupted');
    const at = performance.now(), networkStart = netBytes(), serverStart = server ? resource(server.pid).cpu : 0;
    const p = spawn(binary, args, { env, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    active = p;
    if (sample && p.pid) { state.uploader = identity(p.pid); saveState(); }
    let stdout = '', stderr = '', timedOut = false, spawnError = false, carry = '', cpu = 0, peakRssKiB = 0;
    const samples = [];
    if (input != null) { p.stdin.on('error', () => {}); p.stdin.end(input); }
    p.stdout.on('data', b => { stdout = (stdout + b.toString()).slice(-2 * MiB); });
    p.stderr.on('data', b => {
      stderr = (stderr + b.toString()).slice(-128 * 1024);
      if (!sample) return;
      carry = (carry + b.toString()).slice(-128 * 1024);
      const lines = carry.split(/[\r\n]/); carry = lines.pop();
      for (const line of lines) try {
        const o = JSON.parse(line);
        if (o.stats) samples.push({ seconds: (performance.now() - at) / 1000, sourceBytes: o.stats.bytes, errors: o.stats.errors || 0 });
      } catch { /* Only structured numeric statistics are retained. */ }
    });
    const timer = setTimeout(() => { timedOut = true; killGroup(p); if (sample) killGroup(server); }, timeout);
    let lastNotice = at;
    const interval = sample ? setInterval(() => {
      const a = resource(p.pid), b = server ? resource(server.pid) : { cpu: 0, rss: 0 };
      cpu = Math.max(cpu, a.cpu + Math.max(0, b.cpu - serverStart));
      peakRssKiB = Math.max(peakRssKiB, a.rss + b.rss);
      if (performance.now() - lastNotice >= 30000) {
        lastNotice = performance.now();
        const observation = { commandSeconds: (lastNotice - at) / 1000, sourceBytes: samples.at(-1)?.sourceBytes ?? null, sampledCpuSeconds: cpu, sampledPeakRssKiB: peakRssKiB };
        onSample?.(observation);
        emit({ event: 'progress', ...observation });
      }
    }, 1000) : null;
    return await new Promise(resolve => {
      p.on('error', () => { spawnError = true; });
      p.on('close', (code, signal) => {
        clearTimeout(timer); if (interval) clearInterval(interval); if (active === p) active = null;
        if (sample && state.uploader?.pid === p.pid) { delete state.uploader; saveState(); }
        const netEnd = netBytes();
        resolve({ code, signal, timedOut, spawnError, seconds: (performance.now() - at) / 1000, stdout, stderr,
          sampledCpuSeconds: cpu, sampledPeakRssKiB: peakRssKiB, containerTxBytes: networkStart == null || netEnd == null ? null : Math.max(0, netEnd - networkStart), samples });
      });
    });
  }
  function requireSuccess(result, label) {
    if (result.code !== 0 || result.timedOut || result.spawnError) throw new Error(`${label}: ${result.timedOut ? 'timeout' : result.spawnError ? 'could not start bundled executable' : `exit ${result.code}`}; ${redact(result.stderr, secrets).slice(-1800)}`);
    return result.stdout;
  }
  const megaConfig = path.join(privateDir, 'megatools.conf');
  fs.writeFileSync(megaConfig, `[Login]\nUsername=${configEscape(email)}\nPassword=${configEscape(password)}\n`, { mode: 0o600 });
  const obscured = requireSuccess(await execute(bin.rfork, ['obscure', '-'], { input: password + '\n' }), 'Password preparation').trim();
  secrets.push(obscured);
  const rcConfig = path.join(privateDir, 'control.conf');
  function freshConfig(file) { fs.writeFileSync(file, `[benchmark]\ntype=mega\nuser=${email}\npass=${obscured}\n`, { mode: 0o600 }); }
  freshConfig(rcConfig);
  const rc = (args, opts = {}) => execute(bin.rfork, [...args, '--config', rcConfig, '--mega-use-https=true', '--retries', '1', '--low-level-retries', '1', '--contimeout', '20s', '--timeout', '60s'], opts);
  async function list(target) { return JSON.parse(requireSuccess(await rc(['lsjson', target, '--recursive', '--files-only']), 'Independent remote listing')); }
  async function remove(target) {
    if (target !== `benchmark:${state.folder}` && !new RegExp(`^benchmark:${state.folder}/trial-\\d{3}$`).test(target)) throw new Error('Refusing cleanup outside owned directory');
    requireSuccess(await rc(['purge', target, '--mega-hard-delete=true'], { timeout: 120000 }), 'Scoped cleanup');
  }
  async function stopServer() {
    if (!server) return;
    if (server.exitCode == null && server.signalCode == null) {
      await execute(bin.megacmd, ['quit'], { timeout: 5000, env: server.benchmarkEnv });
      killGroup(server);
      await new Promise(resolve => { if (server.exitCode != null || server.signalCode != null) resolve(); else { server.once('close', resolve); setTimeout(resolve, 2000); } });
    }
    server = null;
  }
  async function startServer(home) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = { ...childEnv, HOME: home, TMPDIR: home, USERPROFILE: home, PATH: path.join(root, 'bin/linux') + ':' + childEnv.PATH };
    server = spawn(bin.server, [], { env, cwd: path.dirname(bin.server), stdio: 'ignore', detached: true });
    if (server.pid) { state.server = identity(server.pid); saveState(); }
    server.benchmarkEnv = env; server.on('error', () => {});
    for (let i = 0; i < 20; i++) {
      if (server.exitCode != null) throw new Error('Bundled MEGAcmd server exited before readiness');
      await new Promise(resolve => setTimeout(resolve, 250));
      const v = await execute(bin.megacmd, ['version'], { env, timeout: 3000 });
      if (v.code === 0) return { env, version: v.stdout.trim() };
    }
    throw new Error('Bundled MEGAcmd server did not become ready');
  }
  async function cleanup() {
    cleaning = true;
    await stopServer();
    await reapSavedGroup('uploader'); await reapSavedGroup('server');
    for (const run of report.runs.filter(r => r.seconds == null)) {
      run.interrupted = true; run.error = 'Workflow interrupted before confirmed upload completion';
    }
    const folders = JSON.parse(requireSuccess(await rc(['lsjson', 'benchmark:', '--dirs-only']), 'Cleanup inspection'));
    if (folders.some(x => x.Name === state.folder)) await remove(`benchmark:${state.folder}`);
    const after = JSON.parse(requireSuccess(await rc(['lsjson', 'benchmark:', '--dirs-only']), 'Cleanup confirmation'));
    if (after.some(x => x.Name === state.folder)) throw new Error('Benchmark folder remains after cleanup');
    report.cleanup = { verified: true, at: new Date().toISOString(), permanent: true }; save();
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
  if (process.argv.includes('--cleanup')) {
    try { await cleanup(); emit({ event: 'cleanup', verified: true }); }
    catch (e) { report.cleanup = { verified: false, error: redact(e.message, secrets) }; save(); process.exitCode = 1; }
    return;
  }
  if (phase === 'all' && (state.created || report.runs.length)) throw new Error('Refusing to replay a used benchmark state; clean up and use a new run');
  report.completedPhases ||= [];
  if (phase !== 'all' && phaseOrder.indexOf(phase) !== report.completedPhases.length) throw new Error('Refusing to replay or skip a benchmark phase');
  const suite = process.env.BENCHMARK_SUITE || 'full';
  if (!['full', 'smoke'].includes(suite)) throw new Error('Invalid suite');
  async function hash(file) { const h = crypto.createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
  async function payload(file, bytes) {
    const fd = fs.openSync(file, 'wx', 0o600), block = Buffer.alloc(Math.min(bytes, 4 * MiB));
    try { for (let n = 0; n < bytes; n += block.length) { crypto.randomFillSync(block); fs.writeSync(fd, block, 0, Math.min(block.length, bytes - n)); } }
    finally { fs.closeSync(fd); }
    return { bytes, sha256: await hash(file) };
  }
  let number = report.runs.length;
  const verifiedTools = new Set();
  async function verifyDownload(trial, remote, source, firstFile) {
    const destination = path.join(privateDir, 'verify.bin');
    const verifier = trial.tool === 'rfork' ? 'megatools' : 'rfork';
    if (trial.phase !== 'smoke' && report.verificationDownloadBlocked) {
      report.checks.push({ kind: 'sha256', trial: trial.name, tool: trial.tool, verifier, matches: null, error: 'Skipped after an explicit MEGA download-quota response; upload result is separate' });
      save(); return;
    }
    const result = verifier === 'megatools'
      ? await execute(bin.megatools, ['get', '--config', megaConfig, '--reload', '--no-ask-password', '--disable-resume', '--no-progress', '--path', destination, `/Root/${remote}/${firstFile}`], { timeout: 120000 })
      : await rc(['copyto', `benchmark:${remote}/${firstFile}`, destination, '--ignore-times'], { timeout: 120000 });
    const check = { kind: 'sha256', trial: trial.name, tool: trial.tool, verifier, matches: null, seconds: result.seconds, timedOut: result.timedOut, downloadLimitSeconds: 120 };
    if (result.code !== 0) {
      check.error = (result.timedOut ? 'Verification exceeded its 120-second limit. ' : '') + (redact(result.stderr, secrets).slice(-1200) || 'Verification download failed');
      if (/quota|EOVERQUOTA|HTTP[^\n]*509/i.test(result.stderr)) report.verificationDownloadBlocked = true;
    }
    else {
      check.expected = await hash(source); check.actual = await hash(destination); check.matches = check.expected === check.actual;
      if (check.matches && !trial.batch && trial.bytes === GiB) verifiedTools.add(trial.tool);
    }
    report.checks.push(check); fs.rmSync(destination, { force: true }); save();
    if (check.matches === false) throw new Error('Independent SHA-256 mismatch');
    if (trial.phase === 'smoke' && check.matches !== true) throw new Error('Small-file integrity preflight failed');
  }
  async function trial(spec, source) {
    if (interrupted) throw new Error('Interrupted');
    if ((Date.now() - Date.parse(report.startedAt)) / 60000 > 265) throw new Error('Suite time budget exhausted; preserving partial results');
    const name = 'trial-' + String(++number).padStart(3, '0'), remote = `${state.folder}/${name}`;
    const run = { ...spec, name, settings: settings(spec.tool, spec.workers), startedAt: new Date().toISOString(), success: false, sizeVerified: false };
    report.runs.push(run); save();
    emit({ event: 'trial-start', name, phase: spec.phase, tool: spec.tool, settings: run.settings, bytes: spec.bytes });
    requireSuccess(await rc(['mkdir', `benchmark:${remote}`]), 'Destination setup');
    const home = path.join(privateDir, name), trialConfig = path.join(privateDir, name + '.conf');
    freshConfig(trialConfig);
    let result;
    const at = performance.now();
    try {
      let env = { ...childEnv, HOME: home, TMPDIR: home };
      if (spec.tool === 'megacmd') {
        const startedServer = await startServer(home); env = startedServer.env;
        report.binaries.megacmd.version ||= startedServer.version;
        requireSuccess(await execute(bin.megacmd, ['login', email, password], { env }), 'MEGAcmd login');
        requireSuccess(await execute(bin.megacmd, ['speedlimit', '-u', '0'], { env }), 'MEGAcmd unlimited upload');
        requireSuccess(await execute(bin.megacmd, ['speedlimit', '--upload-connections', String(spec.workers)], { env }), 'MEGAcmd connections');
        const actual = requireSuccess(await execute(bin.megacmd, ['speedlimit', '--upload-connections'], { env }), 'MEGAcmd connection readback');
        run.connectionReadback = redact(actual.trim(), secrets);
        const count = actual.match(/(?:^|\D)(\d+)\s*$/);
        if (!count || Number(count[1]) !== spec.workers) throw new Error('MEGAcmd rejected or clamped requested connection count');
      } else fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const args = command(spec.tool, { source, folder: state.folder, name, workers: spec.workers, config: spec.tool === 'megatools' ? megaConfig : trialConfig, batch: spec.batch });
      result = await execute(bin[spec.tool], args, { env, timeout: 900000, sample: true, onSample: observation => { run.lastObserved = observation; save(); } });
      // Stop the clock on confirmed foreground command close, before listing/download/quit.
      run.seconds = (performance.now() - at) / 1000;
      run.commandSeconds = result.seconds;
      const { stdout, stderr, ...numeric } = result;
      Object.assign(run, numeric, { seconds: run.seconds });
      requireSuccess(result, 'Upload');
      run.success = true;
    } catch (e) {
      run.seconds ??= (performance.now() - at) / 1000;
      run.error = redact(e.message, secrets);
    } finally { await stopServer(); }
    const files = await list(`benchmark:${remote}`);
    const expected = spec.batch ? fs.readdirSync(source).sort().map(n => ({ name: path.basename(source) + '/' + n, bytes: fs.statSync(path.join(source, n)).size })) : [{ name: 'payload.bin', bytes: spec.bytes }];
    // MEGAcmd's directory put preserves the directory name; other commands target its contents.
    const normalized = files.map(f => ({ name: f.Path, bytes: f.Size }));
    const wants = expected.map(f => ({ name: spec.batch && spec.tool !== 'megacmd' ? f.name.slice(f.name.indexOf('/') + 1) : f.name, bytes: f.bytes }));
    run.remoteFileCount = files.length;
    run.sizeVerified = wants.length === files.length && wants.every(w => normalized.some(f => f.name === w.name && f.bytes === w.bytes));
    if (run.success && !run.sizeVerified) { run.success = false; run.error = 'Remote file names/sizes do not match payload'; }
    run.MBps = run.success && run.sizeVerified ? spec.bytes / run.seconds / 1e6 : null;
    save();
    if (run.success && (spec.phase === 'smoke' || (spec.phase === 'baseline' && spec.round === 1) || spec.phase === 'batch')) {
      const first = wants[0].name;
      await verifyDownload(run, remote, spec.batch ? path.join(source, path.basename(first)) : source, first);
    }
    // Delete each trial permanently so the full sweep only needs one payload's storage.
    await remove(`benchmark:${remote}`);
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(trialConfig, { force: true });
    save(); emit({ event: 'trial-end', name, phase: spec.phase, tool: spec.tool, workers: spec.workers, seconds: run.seconds, MBps: run.MBps, success: run.success, error: run.error });
    if (spec.phase === 'smoke' && !run.success) throw new Error(`${spec.tool} small-file upload preflight failed`);
    if (interrupted) throw new Error('Interrupted; stopped suite after scoped reconciliation');
  }
  try {
    report.suite = suite;
    report.environment = { commit: process.env.GITHUB_SHA || null, runURL: process.env.GITHUB_SERVER_URL && `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      runnerOS: process.env.RUNNER_OS, runnerImage: process.env.ImageOS || null, runnerImageVersion: process.env.ImageVersion || null,
      os: fs.readFileSync('/etc/os-release', 'utf8').trim(), kernel: os.release(), arch: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version,
      timing: 'monotonic; fresh session setup through foreground upload process close; destination preparation and verification excluded',
      resourceMeasurement: 'one-second process samples; MEGAcmd upload includes server; container network bytes are diagnostic only' };
    report.binaries = {};
    for (const [tool, file] of Object.entries(bin)) report.binaries[tool] = { path: path.relative(root, file), bytes: fs.statSync(file).size, sha256: await hash(file) };
    report.binaries.rfork.version = requireSuccess(await execute(bin.rfork, ['version']), 'rfork version').trim();
    report.binaries.megatools.version = requireSuccess(await execute(bin.megatools, ['put', '--version']), 'megatools version').trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bin/rfork-bundle/manifest.json'), 'utf8'));
    if (report.binaries.rfork.sha256 !== manifest.targets.find(t => t.os === 'linux').sha256) throw new Error('Bundled rfork fingerprint differs from its manifest');
    const quota = JSON.parse(requireSuccess(await rc(['about', 'benchmark:', '--json']), 'Account storage preflight'));
    report.quotaBefore = { total: quota.total, used: quota.used, available: quota.total - quota.used };
    if (!Number.isSafeInteger(report.quotaBefore.available) || report.quotaBefore.available < 2 * GiB) throw new Error('Need at least 2 GiB actual free storage');
    const folders = JSON.parse(requireSuccess(await rc(['lsjson', 'benchmark:', '--dirs-only']), 'Unique folder preflight'));
    if (!state.created) {
      if (folders.some(f => f.Name === state.folder)) throw new Error('Unique benchmark folder already exists');
      requireSuccess(await rc(['mkdir', `benchmark:${state.folder}`]), 'Benchmark folder setup');
      state.created = true; fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); save();
    }
    const includes = p => phase === 'all' || phase === p;
    if (includes('smoke')) {
      const smallDir = path.join(privateDir, 'smoke'); fs.mkdirSync(smallDir);
      const small = path.join(smallDir, 'payload.bin'); await payload(small, MiB);
      for (const tool of tools) await trial({ phase: 'smoke', round: 1, tool, workers: baseline[tool], bytes: MiB, batch: false }, small);
      fs.rmSync(small); report.completedPhases.push('smoke'); save();
    }
    if (suite === 'full' && (phase === 'all' || phase !== 'smoke')) {
      const source = path.join(privateDir, 'payload.bin');
      if (!fs.existsSync(source)) report.payload = await payload(source, GiB);
      else if (await hash(source) !== report.payload.sha256) throw new Error('Payload changed between benchmark phases');
      save();
      if (includes('baseline')) {
        for (const spec of rounds('baseline')) await trial(spec, source);
        report.fullPayloadVerifiedTools = [...verifiedTools]; report.completedPhases.push('baseline'); save();
      }
      if (includes('tuning')) {
        for (const spec of tuning()) await trial(spec, source);
        report.selected = Object.fromEntries(tools.map(tool => [tool, choose(report.runs, tool)]));
        report.completedPhases.push('tuning'); save();
      }
      if (includes('confirmation')) {
        for (const spec of rounds('confirmation', report.selected)) await trial(spec, source);
        report.completedPhases.push('confirmation'); save();
      }
      if (includes('batch')) {
      // Reuse the same bytes, split outside timing, to compare one file with 16 files.
      const batchDir = path.join(privateDir, 'batch'); fs.mkdirSync(batchDir);
      const input = fs.openSync(source, 'r'), block = Buffer.alloc(64 * MiB);
      try { for (let i = 0; i < 16; i++) { fs.readSync(input, block, 0, block.length, i * block.length); fs.writeFileSync(path.join(batchDir, `part-${String(i).padStart(2, '0')}.bin`), block, { mode: 0o600 }); } }
      finally { fs.closeSync(input); }
      for (const tool of tools) await trial({ phase: 'batch', round: 1, tool, workers: report.selected[tool], bytes: GiB, batch: true }, batchDir);
        report.completedPhases.push('batch'); save();
      }
    }
    report.complete = phase === 'all' || phase === 'batch' || suite === 'smoke';
    // An unsupported exploratory setting is a finding, not a broken suite.
    report.success = report.runs.filter(r => r.phase !== 'tuning').every(r => r.success && r.sizeVerified);
    if (report.complete && !report.success) process.exitCode = 1;
  } catch (e) { report.error = redact(e.message, secrets); report.success = false; process.exitCode = 1; }
  finally {
    if (report.complete || report.error) report.finishedAt = new Date().toISOString(); save();
    if (phase === 'all' || report.error) {
      try { await cleanup(); } catch (e) { report.cleanup = { verified: false, error: redact(e.message, secrets) }; save(); process.exitCode = 1; }
    }
  }
  emit({ event: 'suite-end', complete: report.complete || false, success: report.success || false, cleanup: report.cleanup, error: report.error });
}

module.exports = { main, GiB, MiB, baseline, sweep, settings, rounds, tuning, choose, median, summarize, redact, configEscape, command, assertFolder };
if (require.main === module) main().catch(e => {
  console.error('Benchmark initialization failed: ' + redact(e.message, [process.env.RFORK_MEGA_EMAIL, process.env.RFORK_MEGA_PASSWORD]));
  process.exitCode = 1;
});
