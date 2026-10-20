'use strict';

// Launch the unmodified packaged application, then attach a local-only main
// process inspector. The production app has no CI entry point or test mode.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

async function main() {
  const args = process.argv.slice(2), live = args.includes('--live'), resumeAfterRestart = args.includes('--resume-after-restart');
  const executable = args.find(a => !a.startsWith('--'));
  if (!executable) throw new Error('Usage: node scripts/test-rfork-package.cjs /absolute/packaged/M3 [--live]');
  const resources = process.platform === 'darwin' ? path.resolve(executable, '../../Resources') : path.join(path.dirname(path.resolve(executable)), 'resources');
  const contents = require('@electron/asar').listPackage(path.join(resources, 'app.asar')).map(file => file.replace(/\\/g, '/'));
  for (const file of ['/src/rfork-upload.js', '/src/rfork-output.js', '/src/upload-journal.js', '/binPath.js']) {
    if (!contents.includes(file)) throw new Error('Packaged application is missing ' + file);
  }
  if (contents.some(file => /^\/(rfork|rclone-1\.75\.2|validation-output)\//.test(file))) throw new Error('Source checkout or validation output leaked into app.asar');
  const directory = process.env.M3_VALIDATION_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'm3-package-'));
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true });
  if (!resumeAfterRestart) fs.writeFileSync(path.join(directory, 'mega-dl-config.json'), JSON.stringify({
    dataDir: path.join(directory, 'data'), tempDir: path.join(directory, 'temp'),
    accountThresholdGb: 1000, splitThresholdGb: 1000, defaultTab: 'settings',
    toolOrderUpload: ['rclone', 'megacmd', 'megatools'], toolOrderView: ['rclone'], toolOrderRefresh: ['rclone'],
    vpn: { enabled: false, uploadRecoveryEnabled: false },
  }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (!live) { delete env.RFORK_MEGA_EMAIL; delete env.RFORK_MEGA_PASSWORD; }
  const child = spawn(path.resolve(executable), ['--inspect=127.0.0.1:0', '--user-data-dir=' + directory,
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let socket, timer, stderr = '', nextId = 0;
  const pending = new Map();
  let closed = false; child.once('close', () => { closed = true; });
  const request = (method, params = {}, timeout = 15000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeoutId = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out: ' + method)); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timeoutId); resolve(value); }, reject: error => { clearTimeout(timeoutId); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const reportFile = process.env.M3_VALIDATION_REPORT || path.join(directory, 'package-report.json');
  const report = { schemaVersion: 1, platform: process.platform, arch: process.arch,
    commit: process.env.GITHUB_SHA || null, live, passed: false };
  try {
    const inspector = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Packaged app inspector did not start')), 30000);
      child.once('error', reject);
      child.once('close', code => reject(new Error('Packaged app closed before inspector: ' + code)));
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-16384);
        const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    socket = new WebSocket(inspector);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', raw => {
      const message = JSON.parse(raw); const task = pending.get(message.id);
      if (!task) return; pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
    });
    socket.on('close', () => { for (const task of pending.values()) task.reject(new Error('Inspector disconnected')); pending.clear(); });
    console.log('Attached to packaged app inspector.');
    // Wait for Electron's normal main module and window to finish starting.
    let ready = false;
    for (let i = 0; i < 240; i++) {
      const result = await request('Runtime.evaluate', { expression: 'typeof process !== "undefined" && !!process.mainModule && process.mainModule.require("electron").app.isReady() && process.mainModule.require("electron").BrowserWindow.getAllWindows().length > 0', returnByValue: true });
      if (result.exceptionDetails) throw new Error('Inspector readiness: ' + result.exceptionDetails.exception?.description);
      if (result.result?.value === true) { ready = true; break; }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw new Error('Packaged application did not become ready');
    console.log('Packaged main process and window are ready.');
    const script = path.resolve(__dirname, 'rfork-packaged-probe.cjs');
    const result = await request('Runtime.evaluate', { expression: `process.mainModule.require(${JSON.stringify(script)})(${JSON.stringify({ directory, live, resumeAfterRestart })})`, awaitPromise: true, returnByValue: true }, live ? 1200000 : 60000);
    if (result.exceptionDetails) {
      let detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      for (const secret of [env.RFORK_MEGA_EMAIL, env.RFORK_MEGA_PASSWORD].filter(Boolean)) detail = detail.split(secret).join('[redacted]');
      detail = detail.replace(/https:\/\/mega\.(?:nz|co\.nz)\/[^\s]+/g, '[share link]');
      detail = detail.replace(/:mega,[^\s]+/g, '[MEGA remote]').replace(/--mega-pass(?:=|\s+)\S+/g, '--mega-pass [redacted]');
      throw new Error('Packaged probe failed: ' + detail.slice(0, 2000));
    }
    if (!result.result?.value?.checks?.length) throw new Error('Probe returned no checks');
    Object.assign(report, result.result.value, { passed: !result.result.value.needsRestart });
  } catch (error) {
    report.error = error.message; process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    if (socket?.readyState === WebSocket.OPEN) {
      await request('Runtime.evaluate', { expression: 'process.mainModule.require("electron").app.exit(0)' }, 1000).catch(() => {});
      socket.close();
    }
    if (!closed) {
      await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 5000))]);
      if (!closed) child.kill('SIGKILL');
    }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    // Live credentials/CSV stay only in an isolated temporary profile. The
    // workflow's always() cleanup consumes remote.json before removing it.
    if (!process.env.M3_VALIDATION_PROFILE && !report.needsRestart) fs.rmSync(directory, { recursive: true, force: true });
  }
  if (report.needsRestart && !process.exitCode) {
    console.log('Restarting the actual packaged app with its retained checkpoint.');
    await new Promise((resolve, reject) => {
      const restarted = spawn(process.execPath, [__filename, executable, '--live', '--resume-after-restart'], {
        env: { ...process.env, M3_VALIDATION_PROFILE: directory, M3_VALIDATION_REPORT: reportFile }, stdio: 'inherit',
      });
      restarted.once('error', reject);
      restarted.once('close', code => { if (code === 0) resolve(); else reject(new Error('Restarted packaged recovery failed')); });
    });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
