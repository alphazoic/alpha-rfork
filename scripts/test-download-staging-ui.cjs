'use strict';
// Real Electron shell/preload/renderers; local IPC fixtures replace transfers,
// player launches, and folder launches. No MEGA or live VPN work is performed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

(async () => {
  const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-staging-ui-'));
  const output = path.join(profile, 'downloads'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(profile, 'mega-dl-config.json'), JSON.stringify({ dataDir: output, defaultOutputDir: output,
    defaultTab: 'download', proxy: 'https://unused.invalid', streamMethod: 'http', launchWhenReady: true }));
  const preload = path.join(profile, 'preload.cjs'), launcher = path.join(profile, 'launcher.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'preload.js'))});
    const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('stagingQa', { event: (channel, data) => ipcRenderer.invoke('staging-qa-event', channel, data),
      opened: () => ipcRenderer.invoke('staging-qa-opened') });`);
  fs.writeFileSync(launcher, `
    const electron = require('electron'), { app, ipcMain, Menu } = electron;
    const path = require('path'), Module = require('module');
    app.setPath('userData', ${JSON.stringify(profile)});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'File', submenu: [] }, { label: 'Help', submenu: [] }]));
    global.fetch = async () => ({ ok: false });
    const cp = require('child_process'), originalSpawn = cp.spawn;
    cp.spawn = (name, ...args) => { if (/protonvpn/.test(name)) throw new Error('Live Proton forbidden'); return originalSpawn(name, ...args); };
    const NativeWindow = electron.BrowserWindow, fixtureElectron = Object.create(electron);
    Object.defineProperty(fixtureElectron, 'BrowserWindow', { value: class extends NativeWindow {
      constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, preload: ${JSON.stringify(preload)}, sandbox: false } }); }
      loadFile(file, options) { return super.loadFile(path.isAbsolute(file) ? file : path.join(${JSON.stringify(root)}, file), options); }
    } });
    const originalLoad = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'electron') return fixtureElectron;
      const loaded = originalLoad.call(this, id, ...args);
      if (id === './src/protonvpn' || id === './protonvpn') return { ...loaded, createProtonVpn: () => ({
        getProcessState: () => ({ blocked: false }), shutdown: async () => ({ state: 'disconnected' }),
        inspect: async () => ({ commands: {}, selectors: {} }),
        connect: async () => { throw new Error('Live Proton forbidden'); },
        disconnect: async () => ({ state: 'disconnected' }),
        getStatus: async () => ({ state: 'disconnected' }) }) };
      return loaded;
    };
    require(${JSON.stringify(path.join(root, 'main.js'))});
    const opened = [];
    for (const channel of ['open-file', 'open-folder']) { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_, filename) => { opened.push({ channel, filename }); return true; }); }
    for (const channel of ['start-download', 'abort-download', 'skip-download']) ipcMain.removeAllListeners(channel);
    ipcMain.on('start-download', (event, args) => { if (args.url.includes('/folder/')) return;
      event.sender.send('dl:batchStart', { totalFiles: 1, totalBytes: 96 });
      event.sender.send('dl:progress', { fileName: 'movie.mkv', fileSize: 96, receivedBytes: 64, chunk: 3, totalChunks: 3 }); });
    ipcMain.handle('staging-qa-event', (event, channel, data) => { event.sender.send('dl:' + channel, data); return true; });
    ipcMain.handle('staging-qa-opened', () => opened);
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['--no-sandbox', '--disable-background-networking', '--disable-component-update',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', launcher],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser, page, stderr = '';
  child.stdout.resume();
  const endpoint = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron debugging endpoint timed out.\n' + stderr)), 20000);
    child.stderr.on('data', bytes => { stderr += bytes; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited: ' + code + '\n' + stderr)); });
  });
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: await endpoint });
    for (let i = 0; i < 100; i++) {
      page = (await browser.pages()).find(item => item.url().endsWith('/index.html'));
      if (page) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(output => window.stagingQa && outDirInput.value === output, {}, output);
    await page.evaluate(output => {
      document.getElementById('streamModeCheckbox').checked = true;
      document.getElementById('cfg-streamMethod').value = 'http';
      document.getElementById('cfg-launchWhenReady').checked = true;
      addToQueue('https://mega.nz/file/TESTTEST#' + 'A'.repeat(43), output, ''); startBtn.click();
    }, output);
    await page.waitForSelector('.lq-active');
    const playlist = path.join(output, '.m3-download-fixture', 'playback-fixture', 'playlist.m3u');
    fs.mkdirSync(path.dirname(playlist), { recursive: true }); fs.writeFileSync(playlist, '#EXTM3U\n');
    await page.evaluate(data => window.stagingQa.event('streamUrl', data), { url: 'http://127.0.0.1/fixture', m3uPath: playlist, outputFolder: output });
    await page.waitForFunction(() => document.querySelector('.lq-active .act-play'));
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 1);
    await page.click('.lq-active .act-play'); await page.click('.lq-active .act-folder');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 3);
    assert.deepEqual(await page.evaluate(() => window.stagingQa.opened()), [
      { channel: 'open-file', filename: playlist }, { channel: 'open-file', filename: playlist }, { channel: 'open-folder', filename: output }]);
    await page.screenshot({ path: '/tmp/m3-download-staging-ui.png' });
    await page.evaluate(() => window.stagingQa.event('fileComplete', { fileName: 'movie.mkv', fileSize: 96, success: true, skipped: false, duration: 1 }));
    await page.evaluate(() => window.stagingQa.event('done', { totalFiles: 1, failedFiles: 0, duration: 1 }));
    await page.waitForSelector('.lq-done .act-play'); await page.click('.lq-done .act-play');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 4);
    assert.deepEqual((await page.evaluate(() => window.stagingQa.opened()))[3], { channel: 'open-file', filename: path.join(output, 'movie.mkv') });
    const event = (channel, data) => page.evaluate(({ channel, data }) => window.stagingQa.event(channel, data), { channel, data });
    const opened = () => page.evaluate(() => window.stagingQa.opened());
    const startSparse = async () => {
      await page.waitForFunction(() => !startBtn.disabled);
      await page.evaluate(output => {
        document.getElementById('cfg-streamMethod').value = 'sparse';
        addToQueue('https://mega.nz/file/TESTTEST#' + 'B'.repeat(43), output, ''); startBtn.click();
      }, output);
      await page.waitForSelector('.lq-active');
      assert.equal(await page.$('.lq-active .act-play'), null);
    };
    const sparse = (attemptId, state) => ({ attemptId, state, fileName: 'movie.mkv', outputFolder: output,
      previewPath: path.join(output, '.m3-download-fixture', attemptId, 'preview.mkv'), finalPath: path.join(output, 'movie.mkv') });
    await startSparse();
    const first = sparse('sparse-one', 'started'); fs.mkdirSync(path.dirname(first.previewPath), { recursive: true }); fs.writeFileSync(first.previewPath, 'PREVIEW');
    await event('sparsePreview', first); await event('sparsePreview', { ...first, state: 'available' });
    await page.waitForSelector('.lq-active .sparse-preview-note');
    await page.evaluate(() => { P.speed = 1000; });
    await event('mediainfo', { durationMs: 60000, fileName: first.fileName, attemptId: first.attemptId });
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 5);
    await page.click('.lq-active .act-play'); await page.click('.lq-active .act-folder');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 7);
    assert.deepEqual((await opened()).slice(4), [{ channel: 'open-file', filename: first.previewPath },
      { channel: 'open-file', filename: first.previewPath }, { channel: 'open-folder', filename: output }]);
    await page.screenshot({ path: '/tmp/m3-sparse-preview-ui.png' });
    await event('sparsePreview', { ...first, state: 'invalidated', reason: 'integrity' });
    await event('sparsePreview', { ...first, state: 'available' });
    await event('mediainfo', { durationMs: 60000, fileName: first.fileName, attemptId: first.attemptId });
    assert.equal(await page.$('.lq-active .act-play'), null); assert.equal((await opened()).length, 7);
    const second = sparse('sparse-two', 'started'); fs.mkdirSync(path.dirname(second.previewPath), { recursive: true }); fs.writeFileSync(second.previewPath, 'RETRY');
    await event('sparsePreview', second); await event('sparsePreview', { ...second, state: 'available' });
    await event('mediainfo', { durationMs: 60000, fileName: first.fileName, attemptId: first.attemptId });
    assert.equal(await page.evaluate(() => P.videoDurationMs), null);
    await event('mediainfo', { durationMs: 60000, fileName: second.fileName, attemptId: second.attemptId });
    assert.equal((await opened()).length, 7); // A quick retry cannot auto-launch another player window.
    await page.click('.lq-active .act-play');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 8);
    assert.equal((await opened()).at(-1).filename, second.previewPath);
    fs.renameSync(second.previewPath, second.finalPath);
    await event('sparsePreview', { ...second, state: 'published' });
    await event('sparsePreview', { ...first, state: 'invalidated' });
    await page.click('.lq-active .act-play');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 9);
    assert.equal((await opened()).at(-1).filename, second.finalPath);
    await event('fileComplete', { fileName: 'movie.mkv', fileSize: 96, success: true, duration: 1 });
    await event('done', { totalFiles: 1, failedFiles: 0, duration: 1 });
    for (const terminal of ['stop', 'skip', 'error']) {
      await startSparse(); const preview = sparse('sparse-' + terminal, 'started');
      await event('sparsePreview', preview); await event('sparsePreview', { ...preview, state: 'available' });
      await page.waitForSelector('.lq-active .act-play');
      if (terminal === 'stop') { await page.click('#stopBtn'); await event('done', { totalFiles: 1, failedFiles: 0, canceled: true }); }
      else if (terminal === 'skip') { await page.click('.lq-active .q-btn.del'); await event('done', { totalFiles: 1, failedFiles: 0, skipped: true }); }
      else await event('error', { message: 'Fixture sparse failure' });
      await event('sparsePreview', { ...preview, state: 'available' });
      assert.equal(await page.$('.lq-active .act-play'), null);
      assert.equal(await page.$('.lq-failed .act-play, .lq-skipped .act-play'), null);
      assert.equal((await opened()).length, 9);
    }
    await startSparse(); await event('batchStart', { totalFiles: 2, totalBytes: 192 });
    const folderFirst = { ...sparse('folder-first', 'started'), fileName: 'first.mkv', finalPath: path.join(output, 'first.mkv') };
    await event('progress', { fileName: folderFirst.fileName, fileSize: 96, receivedBytes: 64, chunk: 3, totalChunks: 3 });
    await event('sparsePreview', folderFirst); await event('sparsePreview', { ...folderFirst, state: 'available' });
    await event('sparsePreview', { ...folderFirst, state: 'published' });
    await event('fileComplete', { fileName: folderFirst.fileName, fileSize: 96, success: true, duration: 1 });
    const folderSecond = { ...sparse('folder-second', 'started'), fileName: 'second.mkv', finalPath: path.join(output, 'second.mkv') };
    await event('sparsePreview', folderSecond);
    assert.equal(await page.$('.lq-active .act-play'), null);
    await event('mediainfo', { fileName: folderFirst.fileName, attemptId: folderFirst.attemptId, durationMs: 60000 });
    await event('sparsePreview', { ...folderFirst, state: 'available' });
    assert.equal(await page.evaluate(() => P.videoDurationMs), null);
    assert.equal(await page.$('.lq-active .act-play'), null);
    await event('progress', { fileName: folderSecond.fileName, fileSize: 96, receivedBytes: 64, chunk: 3, totalChunks: 3 });
    await event('sparsePreview', { ...folderSecond, state: 'available' });
    await page.click('.lq-active .act-play');
    await page.waitForFunction(async () => (await window.stagingQa.opened()).length === 10);
    assert.equal((await opened()).at(-1).filename, folderSecond.previewPath);
    await event('error', { message: 'End of folder fixture' });
    await page.evaluate(() => { while (queue.length) removeQueue(0); clearLogBtn.click(); });

    const startFolder = async id => {
      await page.waitForFunction(() => !startBtn.disabled);
      const url = 'https://mega.nz/folder/' + id + '#' + 'C'.repeat(22);
      await page.evaluate(({ url, output }) => {
        document.getElementById('streamModeCheckbox').checked = false;
        addToQueue(url, output, ''); startBtn.click();
      }, { url, output });
      await page.waitForSelector('.lq-active');
      return url;
    };
    const keyFailure = handle => ({ nodeHandle: handle, fileName: 'group/file-' + handle, fileSize: 96,
      success: false, skipped: false, canceled: false, duration: 0,
      errorCode: 'FILE_KEY_MISSING', errorMessage: 'No decryptable file key is present in the share.' });
    const historyFor = url => page.evaluate(async url => (await window.api.readDownloadsFile()).filter(row => row.megaUrl === url), url);
    const mixedUrl = await startFolder('MIXED');
    await event('batchStart', { totalFiles: 2, totalBytes: 192 });
    await event('log', 'ERROR   | group/file-BAD: FILE_KEY_MISSING — No decryptable file key is present in the share.');
    await event('fileComplete', keyFailure('BAD'));
    assert.deepEqual(await page.evaluate(() => ({ files: P.completedFiles, failed: P.failedFiles, bytes: P.completedBytes,
      queueBytes: P.queueCompletedBytes, queueFiles: P.queueCompletedFiles, durations: P.fileDurations, sizes: P.fileSizes })),
    { files: 1, failed: 1, bytes: 0, queueBytes: 0, queueFiles: 0, durations: [], sizes: [] });
    assert.equal(await page.$('.lq-active .act-play'), null);
    await event('progress', { fileName: 'group/good.bin', fileSize: 96, receivedBytes: 96, chunk: 1, totalChunks: 1 });
    await event('fileComplete', { nodeHandle: 'GOOD', fileName: 'group/good.bin', fileSize: 96, success: true, duration: 10 });
    await event('done', { totalFiles: 2, failedFiles: 1, duration: 10 });
    await page.waitForFunction(() => statusText.textContent === 'Downloads: 1 failed');
    assert.equal(await page.$eval('#batchText', el => el.textContent), 'Files settled: 2 / 2 · 1 failed');
    assert.equal(await page.$eval('#batchBytes', el => el.textContent), 'Verified: 96 B / 192 B');
    assert.equal(await page.$eval('#batchBar', el => el.classList.contains('has-failures')), true);
    assert.deepEqual((await historyFor(mixedUrl)).map(row => [row.fileName, row.status]).sort(), [['file-BAD', 'error'], ['good.bin', 'success']]);
    assert.equal(await page.evaluate(() => P.queueCompletedBytes), 96);
    assert.equal(await page.$('.lq-failed .act-play'), null);
    assert.match(await page.$eval('.lq-failed', el => el.textContent), /file-BAD: No decryptable file key/);
    await page.screenshot({ path: '/tmp/m3-folder-key-failure-ui.png' });

    const allFailedUrl = await startFolder('ALLFAILED');
    await event('batchStart', { totalFiles: 2, totalBytes: 192 });
    await event('fileComplete', keyFailure('BAD0')); await event('fileComplete', keyFailure('BAD1'));
    await event('done', { totalFiles: 2, failedFiles: 2, duration: 10 });
    await page.waitForFunction(() => statusText.textContent === 'Downloads: 2 failed');
    assert.equal(await page.$eval('#batchText', el => el.textContent), 'Files settled: 2 / 2 · 2 failed');
    assert.equal(await page.$eval('#batchBytes', el => el.textContent), 'Verified: 0 B / 192 B');
    assert.equal(await page.evaluate(() => P.queueCompletedBytes), 0);
    assert.deepEqual((await historyFor(allFailedUrl)).map(row => row.status), ['error', 'error']);

    // Use the real history Retry button: terminal results update its CSV row
    // in place, and file callbacks during the retry cannot append duplicates.
    await page.waitForFunction(() => !startBtn.disabled);
    await page.click('#dl-tabHistory');
    await page.waitForFunction(() => [...document.querySelectorAll('.dl-hist-item')].some(el => el.textContent.includes('file-BAD0')));
    await page.evaluate(() => [...document.querySelectorAll('.dl-hist-item')].find(el => el.textContent.includes('file-BAD0')).querySelector('.dl-hi-retry').click());
    await page.click('#dl-tabProgress'); await page.click('#startBtn'); await page.waitForSelector('.lq-active');
    await event('batchStart', { totalFiles: 2, totalBytes: 192 });
    for (const handle of ['BAD0', 'BAD1']) await event('fileComplete', { nodeHandle: handle, fileName: 'group/repaired-' + handle,
      fileSize: 96, success: true, duration: 10 });
    await event('done', { totalFiles: 2, failedFiles: 0, duration: 20 });
    await page.waitForFunction(() => statusText.textContent === 'Downloads: complete');
    const retriedRows = await historyFor(allFailedUrl);
    assert.equal(retriedRows.length, 2); assert.deepEqual(retriedRows.map(row => row.status).sort(), ['error', 'success']);
    assert.equal(await page.$eval('#batchBar', el => el.classList.contains('has-failures')), false);
    assert.equal(await page.$eval('#batchBytes', el => el.textContent), 'Verified: 192 B / 192 B');

    for (const terminal of ['canceled', 'skipped']) {
      await page.waitForFunction(() => !startBtn.disabled);
      await page.click('#dl-tabHistory');
      await page.waitForFunction(() => [...document.querySelectorAll('.dl-hist-item')].some(el => el.textContent.includes('file-BAD1')));
      await page.evaluate(() => [...document.querySelectorAll('.dl-hist-item')].find(el => el.textContent.includes('file-BAD1')).querySelector('.dl-hi-retry').click());
      await page.click('#dl-tabProgress'); await page.click('#startBtn'); await page.waitForSelector('.lq-active');
      await event('batchStart', { totalFiles: 2, totalBytes: 192 });
      await event('fileComplete', keyFailure('BAD1'));
      if (terminal === 'canceled') await page.click('#stopBtn');
      else await page.click('.lq-active .q-btn.del');
      await event('done', { totalFiles: 2, failedFiles: 1, duration: 10, [terminal]: true });
      const rows = await historyFor(allFailedUrl);
      assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.status).sort(), ['error', 'success']);
      assert.equal(await page.evaluate(url => pendingRetries.has(url), allFailedUrl), false);
      assert.equal(await page.evaluate(() => queue.at(-1).status), 'error');
    }

    await startFolder('UNKNOWNSIZE');
    await event('batchStart', { totalFiles: 2, totalBytes: 96, unknownSizeFiles: 1 });
    await event('fileComplete', { ...keyFailure('BAD'), fileSize: 0, sizeKnown: false });
    await event('fileComplete', { nodeHandle: 'EXISTS', fileName: 'group/existing.bin', fileSize: 96, success: true, skipped: true });
    await event('done', { totalFiles: 2, failedFiles: 1, duration: 10 });
    assert.match(await page.$eval('#batchBytes', el => el.textContent), /96 B \/ 96 B known \(\+1 size unknown\)/);
    assert.equal(await page.evaluate(() => P.completedFiles), 2);
    assert.equal(await page.evaluate(() => P.queueCompletedBytes), 0);
    for (const terminal of ['canceled', 'skipped']) {
      await startFolder('INTERRUPTED-' + terminal);
      await event('batchStart', { totalFiles: 3, totalBytes: 288 });
      await event('fileComplete', keyFailure('BAD'));
      if (terminal === 'canceled') await page.click('#stopBtn');
      else await page.click('.lq-active .q-btn.del');
      await event('done', { totalFiles: 3, failedFiles: 1, duration: 10, [terminal]: true });
      assert.equal(await page.evaluate(() => queue.at(-1).status), 'error');
      assert.match(await page.evaluate(() => queue.at(-1).errorMsg), /No decryptable file key/);
      assert.equal(await page.evaluate(() => P.completedFiles), 1);
      assert.equal(await page.evaluate(() => P.completedBytes), 0);
      assert.equal(await page.$eval('#statusText', el => el.textContent), 'Downloads: 1 failed');
    }
    assert.deepEqual(errors, []);
    console.log('Electron download UI passed: HTTP and sparse playback lifecycle; mixed/all key failures, settled/verified byte totals, CSV error rows, history Retry without duplicate rows, unknown sizes and verified existing outputs. Screenshots: /tmp/m3-download-staging-ui.png, /tmp/m3-sparse-preview-ui.png, /tmp/m3-folder-key-failure-ui.png');
  } catch (error) {
    if (page) {
      console.error(JSON.stringify(await page.evaluate(() => ({ fixture: Boolean(window.stagingQa), output: document.getElementById('outDirInput')?.value }))));
      console.error('Expected output: ' + output);
      await page.screenshot({ path: '/tmp/m3-download-staging-ui-error.png' });
    }
    console.error(stderr.slice(-2000)); throw error;
  } finally {
    browser?.disconnect(); child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
