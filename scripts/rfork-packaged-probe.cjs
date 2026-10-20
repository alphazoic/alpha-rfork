'use strict';

// Executed by the external inspector harness inside the actual packaged app.
// No test switches or fixtures are shipped in the application's entry point.
module.exports = async function probe({ directory, live, resumeAfterRestart = false }) {
  const { app, BrowserWindow } = require('electron');
  const { createRequire } = require('module');
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const assert = require('assert/strict');
  const req = createRequire(path.join(app.getAppPath(), 'main.js'));
  const config = req('./src/config');
  assert.equal(app.isPackaged, true);
  assert.equal(path.resolve(config.getDataDir()), path.resolve(path.join(directory, 'data')));
  const checks = [];
  const check = (name, details = {}) => checks.push({ name, passed: true, ...details });
  const bundle = req('./src/rfork-bundle').verifyRforkBundle({ root: process.resourcesPath,
    platform: { linux: 'linux', win32: 'win', darwin: 'mac' }[process.platform], packaged: true })[0];
  const binary = req('./binPath').getBinPath('rclone');
  assert.equal(binary, bundle.executable); check('packaged resolver, hash, architecture, notices and evidence', { sha256: bundle.sha256 });
  const { runCommand } = req('./src/proc-utils');
  const { rforkEnvironment } = req('./src/rfork-environment');
  const version = await runCommand(binary, ['version'], { env: rforkEnvironment() });
  assert.equal(version.split(/\r?\n/)[0], 'rfork ' + bundle.version); check('native packaged helper execution');
  const obscured = await req('./src/rclone').obscurePass('packaged fixture ünicode');
  assert.ok(obscured && !obscured.includes('fixture')); check('native stdin password obscuring');
  const window = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  assert.ok(window);
  for (let i = 0; i < 120; i++) {
    if (await window.webContents.executeJavaScript('document.readyState === "complete" && typeof window.api === "object"')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const ui = await window.webContents.executeJavaScript(`(async () => ({
    labels: [...document.querySelectorAll('[data-tool="rclone"] .tool-order-name')].map(e => e.textContent),
    config: await window.api.loadConfig(), review: typeof window.api.reviewUploadRecovery
  }))()`);
  assert.equal(ui.labels.length, 3); assert.ok(ui.labels.every(x => x === 'rfork'));
  assert.deepEqual(ui.config.toolOrderUpload, ['rclone', 'megacmd', 'megatools']);
  assert.equal(ui.review, 'function'); check('packaged renderer, preload and saved provider order');
  const settingsResult = await window.webContents.executeJavaScript(`(async () => {
    const draft = { workers: 5, bundling: true, bundleSizeMiB: 2.5, pacingMs: 0, dataRetries: 0,
      diagnostics: true, readBufferMiB: 0, stallSeconds: 0, checkpointIntervalSeconds: 0 };
    window.rforkSettingsUI.apply(draft);
    await doSaveSettings();
    const saved = (await window.api.loadConfig()).rforkUpload;
    let rejected = false;
    try { await window.api.saveConfig({rforkUpload:{workers:99}}); } catch { rejected = true; }
    const afterInvalid = (await window.api.loadConfig()).rforkUpload;
    window.rforkSettingsUI.apply({resume:true});
    const bufferDisabled = document.getElementById('cfg-rfork-readBufferMiB').disabled;
    document.getElementById('cfg-rfork-https').checked = false;
    document.getElementById('cfg-rfork-https').dispatchEvent(new Event('change'));
    let conflict = false; try { window.rforkSettingsUI.readDraft(); } catch { conflict = true; }
    document.querySelector('[data-rfork-reset]').click();
    const defaults = window.rforkSettingsUI.readDraft();
    window.rforkSettingsUI.apply(saved);
    return {saved,afterInvalid,rejected,bufferDisabled,conflict,defaults};
  })()`);
  assert.equal(settingsResult.saved.workers, 5); assert.equal(settingsResult.saved.bundleSizeMiB, 2.5);
  assert.equal(settingsResult.saved.pacingMs, 0); assert.equal(settingsResult.saved.readBufferMiB, 0);
  assert.equal(settingsResult.saved.dataRetries, 0); assert.equal(settingsResult.saved.stallSeconds, 0);
  assert.equal(settingsResult.saved.checkpointIntervalSeconds, 0);
  assert.deepEqual(settingsResult.afterInvalid, settingsResult.saved);
  assert.ok(settingsResult.rejected && settingsResult.bufferDisabled && settingsResult.conflict);
  assert.equal(settingsResult.defaults.workers, 8); assert.equal(settingsResult.defaults.bundling, false);
  check('rfork UI save, explicit zeros, custom bundle size, invalid IPC rejection, dependencies and reset');
  await window.webContents.reload();
  for (let i = 0; i < 120; i++) {
    try { if (await window.webContents.executeJavaScript('window.rforkSettingsUI && document.getElementById("cfg-rfork-workers").value === "5"')) break; } catch { /* Wait for the reloaded renderer. */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const restored = await window.webContents.executeJavaScript('window.rforkSettingsUI.readDraft()');
  assert.deepEqual(restored, settingsResult.saved); check('rfork settings survive renderer reload');
  if (!live) return { checks, live: false, sha256: bundle.sha256 };

  const email = process.env.RFORK_MEGA_EMAIL, password = process.env.RFORK_MEGA_PASSWORD;
  assert.ok(email && password, 'Testing account secrets are missing');
  const env = rforkEnvironment(email, await req('./src/rclone').obscurePass(password));
  const csv = value => '"' + String(value).replace(/"/g, '""') + '"';
  fs.writeFileSync(config.getAccountCsv(), 'Email Address,Password,Bandwidth Used (GB),Date Created,Last Login Date,Account Status,Security Upgrade\n' +
    [email, password, '0', new Date().toISOString(), '', 'Active', 'No'].map(csv).join(',') + '\n', { mode: 0o600 });
  const folder = resumeAfterRestart ? JSON.parse(fs.readFileSync(path.join(directory, 'remote.json'), 'utf8')).folder : 'm3-ci-' + crypto.randomUUID();
  // Persist the unique remote prefix for an independent always() cleanup step.
  fs.writeFileSync(path.join(directory, 'remote.json'), JSON.stringify({ folder }), { mode: 0o600 });
  const verifier = process.env.M3_STOCK_VERIFIER;
  assert.ok(verifier && fs.existsSync(verifier), 'Independent stock verifier is missing');
  const stock = async args => runCommand(verifier, [...args, '--mega-use-https=true', '--retries', '1'], { env });
  const rfork = async args => runCommand(binary, [...args, '--mega-use-https=true', '--retries', '1'], { env });
  let cleaned = false, retainForRestart = false;
  // Guard account creation only. Real packaged authentication, setup, usage,
  // upload, process management, link generation, CSV and journal code all run.
  const creator = req('./src/account-creator');
  const originalCreator = creator.registerMegaAccount;
  creator.registerMegaAccount = async () => { throw Object.assign(new Error('CI forbids creating accounts'), { vpnInterrupted: true }); };
  delete require.cache[req.resolve('./src/upload-engine')];
  let engine = req('./src/upload-engine');
  creator.registerMegaAccount = originalCreator;
  const events = [], diagnosticEvents = [];
  const send = (channel, data) => {
    // Keep only status counters in memory. Never persist raw logs or credentials.
    if (channel === 'up:link') events.push({ channel, name: data.name, link: data.link });
    if (channel === 'up:log' && typeof data === 'string' && data.startsWith('[rfork diagnostics] ')) { try { diagnosticEvents.push(JSON.parse(data.slice('[rfork diagnostics] '.length))); } catch {} }
  };
  const upload = queue => engine.startUpload({ queue, manualEmail: email, manualPassword: password,
    folderName: folder, uploadToolOrder: ['rclone'], createToolOrder: [] }, send);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const journal = req('./src/upload-journal').createUploadJournal(config.getDataDir());
  try {
    if (resumeAfterRestart) {
      const pending = JSON.parse(fs.readFileSync(path.join(directory, 'resume-pending.json'), 'utf8'));
      checks.unshift(...pending.checks);
      const retained = journal.read().find(item => item.id === pending.id);
      assert.ok(retained && retained.checkpoint === pending.checkpoint);
      assert.ok(fs.existsSync(retained.source));
      config.saveConfig({ ...config.loadConfig(), rforkUpload: { ...config.loadConfig().rforkUpload, resume: false, bandwidthMiB: 0 } });
      // Lose application CSV recording after the provider commits, then restart
      // the engine. The same committed checkpoint must finish without new data.
      const journalModule = req('./src/upload-journal');
      const originalRecord = journalModule.recordUploadCompletion;
      let loseRecord = true;
      journalModule.recordUploadCompletion = (...args) => { if (loseRecord) { loseRecord = false; throw new Error('fixture: lost application recording'); } return originalRecord(...args); };
      delete require.cache[req.resolve('./src/upload-engine')]; engine = req('./src/upload-engine');
      try {
        const first = await engine.resumeSavedUpload({ id: retained.id }, send);
        assert.equal(first.ok, false); assert.match(first.error, /lost application recording/);
        const committed = journal.read().find(item => item.id === retained.id);
        assert.equal(committed.state, 'committed'); assert.ok(committed.node);
        const counters = diagnosticEvents.find(value => value?.restoredAcknowledgedBytes > 0);
        assert.ok(counters && counters.restoredAcknowledgedBytes < retained.bytes, 'No authenticated partial progress was restored');
        check('actual M3 restart retains original checkpoint and restores authenticated progress', { restoredBytes: counters.restoredAcknowledgedBytes, pendingBytes: counters.pendingSourceBytes });
      } finally { journalModule.recordUploadCompletion = originalRecord; }
      delete require.cache[req.resolve('./src/upload-engine')]; engine = req('./src/upload-engine');
      const second = await engine.resumeSavedUpload({ id: retained.id }, send);
      assert.equal(second.ok, true); assert.equal(second.restoredAcknowledgedBytes, retained.bytes); assert.equal(second.pendingSourceBytes, 0);
      assert.equal(journal.read().length, 0);
      const downloaded = path.join(directory, 'resumed-download.bin');
      await stock(['copyto', ':mega:' + retained.destination, downloaded]);
      assert.equal(hash(downloaded), pending.sha256);
      check('independent stock download SHA-256 after M3 restart/resume', { bytes: retained.bytes, sha256: pending.sha256 });
      const tree = JSON.parse(await stock(['lsjson', ':mega:' + folder, '--files-only']));
      assert.equal(tree.filter(item => item.Name === path.basename(retained.source)).length, 1);
      const rows = fs.readFileSync(config.getFileCsv(), 'utf8').trim().split(/\r?\n/).slice(1).map(req('./src/utils').parseCSVLine);
      assert.equal(rows.filter(row => row[0] === path.basename(retained.source)).length, 1);
      check('committed tombstone survives lost application recording without duplicate upload or CSV row');
      return { checks, live: true, cleanup: true, sha256: bundle.sha256 };
    }
    const files = [];
    for (const [name, bytes] of [['payload ünicode.bin', 64 * 1024 * 1024], ['empty.bin', 0]]) {
      const file = path.join(directory, name); const fd = fs.openSync(file, 'w');
      for (let left = bytes; left > 0; left -= Math.min(left, 1024 * 1024)) fs.writeSync(fd, crypto.randomBytes(Math.min(left, 1024 * 1024)));
      fs.closeSync(fd); files.push(file);
    }
    await upload(files);
    assert.equal(events.length, 2, 'M3 did not confirm both uploads');
    assert.ok(events.every(e => /^https:\/\/mega\.(nz|co\.nz)\//.test(e.link)), 'Share links missing');
    assert.equal(journal.read().length, 0);
    const csvRows = () => {
      const lines = fs.readFileSync(config.getFileCsv(), 'utf8').trim().split(/\r?\n/);
      assert.equal(lines.shift(), 'File Name,File Size,File Link,Folder Link,Email,Password,Upload Date,Folder Name');
      return lines.map(req('./src/utils').parseCSVLine);
    };
    const rows = csvRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row[0]).sort(), files.map(file => path.basename(file)).sort());
    assert.ok(rows.every(row => row[4] === email && row[5] === password && row[7] === folder));
    check('M3 upload, empty file, share links, CSV and cleared journal');
    const tree = await req('./src/import-engine').browseAccountFiles({ email, password });
    assert.equal(tree.ok, true); assert.equal(tree.tool, 'rclone');
    for (const file of files) {
      const name = path.basename(file), destination = path.join(directory, 'download-' + name);
      assert.ok(tree.data.files.some(f => f.handle === '/' + folder + '/' + name));
      await stock(['copyto', ':mega:' + folder + '/' + name, destination]);
      assert.equal(hash(destination), hash(file)); check('independent stock download SHA-256', { file: name, bytes: fs.statSync(file).size, sha256: hash(file) });
    }
    const usage = await req('./src/account-usage').queryActualUsageKb(email, password, 'rclone');
    assert.ok(Number.isFinite(usage) && usage >= 64 * 1024); check('M3 browsing and usage');
    let refreshed;
    await req('./src/account-manager').refreshSingleAccount(email, password, (channel, data) => { if (channel === 'up:refreshSingleDone') refreshed = data; });
    assert.equal(refreshed?.outcome, 'success'); check('M3 forced-rfork account refresh');
    const links = await req('./src/import-engine').getAccountFileLinks({ email, password,
      paths: ['/' + folder + '/' + path.basename(files[0])], tool: 'rclone' });
    assert.ok(links.ok && links.links.length === 1 && /^https:\/\/mega\./.test(links.links[0].url));
    check('M3 browse-to-share-link consumer');

    // Interrupt after real upload progress. The original source and hold must
    // survive; even a second Start must never submit it automatically again.
    const interrupted = path.join(directory, 'interrupted.bin');
    fs.writeFileSync(interrupted, crypto.randomBytes(128 * 1024 * 1024));
    let stopped = false, childClosed = false, uploadChildren = 0;
    const network = req('./src/network-operations'), originalSpawn = network.spawnNetwork;
    network.spawnNetwork = (...args) => {
      const child = originalSpawn(...args);
      if (args[0] === binary && args[1][0] === 'copyto') {
        uploadChildren++;
        child.once('close', () => { childClosed = true; });
        let pending = '';
        child.stderr.on('data', chunk => {
          pending = (pending + chunk.toString()).slice(-65536);
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) {
            try { if (JSON.parse(line).stats?.bytes > 0 && !stopped) { stopped = true; engine.killQueue(); } } catch { /* Ignore diagnostics. */ }
          }
        });
      }
      return child;
    };
    const completedBefore = events.length;
    try {
      await upload([interrupted]);
      assert.ok(stopped && childClosed); assert.ok(fs.existsSync(interrupted));
      assert.equal(events.length, completedBefore); assert.equal(journal.read().length, 1);
      await upload([interrupted]); assert.equal(events.length, completedBefore); assert.equal(journal.read().length, 1);
      assert.equal(uploadChildren, 1, 'A second Start launched another upload');
      assert.equal(csvRows().length, 2);
    } finally { network.spawnNetwork = originalSpawn; }
    check('Stop waits for closure, retains source and journal; restart stays held');
    // The ordinary interrupted case is finished; its private hold is test-owned.
    for (const entry of journal.read()) journal.clear(entry.id);
    config.saveConfig({ ...config.loadConfig(), rforkUpload: { workers: 2, resume: true,
      bundling: true, bundleSizeMiB: 1, pacingMs: 10, diagnostics: true,
      bandwidthMiB: 1, statsSeconds: 0.1, checkpointIntervalSeconds: 0.05 } });
    const source = path.join(directory, 'resume-source.bin');
    fs.writeFileSync(source, crypto.randomBytes(9 * 1024 * 1024 + 31));
    let interruptedResume = false, stateSize = null, timer;
    network.spawnNetwork = (...args) => {
      const child = originalSpawn(...args);
      if (args[0] === binary && args[1][0] === 'backend') {
        timer = setInterval(() => {
          try {
            const record = journal.read()[0];
            const size = fs.statSync(path.join(record.checkpoint, 'state')).size;
            if (stateSize === null) stateSize = size;
            else if (size > stateSize && !interruptedResume) { interruptedResume = true; clearInterval(timer); engine.killQueue(); }
          } catch { /* Wait for the private initial state; never read its contents. */ }
        }, 10);
        child.once('close', () => clearInterval(timer));
      }
      return child;
    };
    try { await upload([source]); } finally { clearInterval(timer); network.spawnNetwork = originalSpawn; }
    assert.ok(interruptedResume, 'Resume interruption window was missed');
    const retained = journal.read()[0]; assert.ok(retained?.checkpoint); assert.equal(retained.source, source);
    const treeAfterStop = JSON.parse(await stock(['lsjson', ':mega:' + folder, '--files-only']));
    assert.ok(!treeAfterStop.some(item => item.Name === path.basename(source)));
    check('M3 checkpoint upload stopped before publication and retained original source/state');
    fs.writeFileSync(path.join(directory, 'resume-pending.json'), JSON.stringify({ id: retained.id,
      checkpoint: retained.checkpoint, sha256: hash(source), checks }), { mode: 0o600 });
    retainForRestart = true;
    return { checks, live: true, cleanup: null, needsRestart: true, sha256: bundle.sha256 };

  } finally {
    if (!retainForRestart) {
    await rfork(['purge', ':mega:' + folder, '--mega-hard-delete=true']);
    const folders = JSON.parse(await stock(['lsjson', ':mega:', '--dirs-only']));
    assert.ok(!folders.some(x => x.Name === folder)); cleaned = true;
    for (const entry of journal.read()) journal.clear(entry.id);
    }
  }
  return { checks, live: true, cleanup: cleaned, sha256: bundle.sha256 };
};
