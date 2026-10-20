'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createVpnController } = require('./vpn-controller');
const { createVpnService } = require('./vpn-service');
const { createNetworkOperations } = require('./network-operations');
const { createDownloadSession } = require('./download-session');
const { downloadTransfer } = require('./download-transfer');
const { normalizeVpnSettings } = require('./vpn-settings');
const { selectPreferredTarget, ProtonVpnError } = require('./protonvpn');
const { referenceMac, key, iv } = require('../scripts/mega-test-data.cjs');
const { openDownloadStaging, downloadStagingIdentity } = require('./download-staging');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function attribute(name) {
  const raw = Buffer.from('MEGA' + JSON.stringify({ n: name }));
  const padded = Buffer.alloc(Math.ceil(raw.length / 16) * 16); raw.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'hex'), Buffer.alloc(16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64url');
}
async function fixture(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'm3-download-'));
  const plain = Buffer.alloc(options.size ?? 96); for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
  function fileData(plain) {
    const cipher = crypto.createCipheriv('aes-128-ctr', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const last = Buffer.concat([Buffer.from(iv.slice(0, 16), 'hex'), Buffer.from(referenceMac(plain), 'hex')]);
    const first = Buffer.from(key, 'hex'); for (let i = 0; i < 16; i++) first[i] ^= last[i];
    return { plain, encrypted, fullKey: Buffer.concat([first, last]).toString('base64url') };
  }
  const { encrypted, fullKey } = fileData(plain);
  const entries = (options.names || ['first.bin', 'second.bin']).map((name, index) => ({ name, handle: 'F' + index,
    ...fileData(options.distinct ? Buffer.from(plain.map(byte => (byte + index * 53) % 256)) : plain) }));
  const wrap = value => {
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'hex'), null); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(value), cipher.final()]).toString('base64url');
  };
  const connections = new Set(), requests = [], states = [], files = [], logs = [], done = [], errors = [], streams = [], progress = [], previews = [], media = [], batches = [], commands = [];
  let route = 'CH#1', switches = 0, apiCalls = 0, dataCalls = 0, liveResponses = 0;
  const entered = deferred(), waiting = deferred(), releaseConnect = deferred();
  const server = http.createServer((req, res) => {
    if (req.url === '/api') {
      apiCalls++; const parts = []; req.on('data', data => parts.push(data));
      req.on('end', () => {
        const command = JSON.parse(Buffer.concat(parts))[0];
        commands.push(command);
        if (options.folder && command.a === 'f') {
          const nodes = [{ h: 'ROOT', p: 'outside', t: 1, k: 'ROOT:' + wrap(Buffer.from(key, 'hex')), a: attribute('group') }];
          for (const entry of entries) nodes.push({ h: entry.handle, p: 'ROOT', t: 0,
            k: 'ROOT:' + wrap(Buffer.from(entry.fullKey, 'base64url')), a: attribute(entry.name), s: entry.plain.length });
          options.onNodes?.(nodes, { wrap, attribute, entries });
          res.end(JSON.stringify([{ f: nodes }]));
        } else res.end(JSON.stringify([{ at: attribute(options.fileName || 'sample.bin'), s: plain.length,
          g: 'https://cdn.invalid/' + (command.n || 'single') + '/token' + apiCalls }]));
      }); return;
    }
    dataCalls++; liveResponses++;
    res.once('close', () => liveResponses--);
    const range = /\/(\d+)-(\d+)$/.exec(req.url);
    const base = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : plain.length - 1;
    const retained = req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)[1]) : 0;
    const handle = options.folder ? entries.find(entry => req.url.includes('/' + entry.handle + '/'))?.handle : 'single';
    requests.push({ base, end, retained, route, handle }); entered.resolve();
    if (options.failData?.[handle] > 0) { options.failData[handle]--; res.writeHead(503); res.end(); return; }
    if (options.expired && dataCalls === 1) { res.writeHead(403); res.end(); return; }
    const offset = options.ignoreRange ? 0 : retained;
    const payload = options.folder ? entries.find(entry => req.url.includes('/' + entry.handle + '/')).encrypted : encrypted;
    const body = Buffer.from(payload.subarray(base + offset, end + 1));
    if (options.corrupt) body[0] ^= 1;
    const headers = { 'Content-Length': body.length };
    if (offset) headers['Content-Range'] = `bytes ${base + offset}-${end}/${plain.length}`;
    res.writeHead(offset ? 206 : 200, headers); res.flushHeaders();
    const stalled = options.stall && (route === 'CH#1' || options.stallAlways) && (!options.stallBase || base === options.stallBase) &&
      (!options.stallFile || req.url.includes(options.stallFile));
    if (stalled) {
      if (!options.zero) res.write(body.subarray(0, 16));
      return;
    }
    if (options.trickle && route === 'CH#1') {
      let at = 0;
      const timer = setInterval(() => { if (at === body.length) { clearInterval(timer); res.end(); } else res.write(body.subarray(at, ++at)); }, 5);
      res.on('close', () => clearInterval(timer)); return;
    }
    res.end(body);
  });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = 'http://127.0.0.1:' + server.address().port;
  const capabilities = { commands: { connect: true, status: true }, selectors: { server: true, country: true, random: true } };
  const adapter = {
    async getStatus() { if (options.statusError) throw new ProtonVpnError('COMMAND_FAILED', 'status', 0);
      return { state: route ? 'connected' : 'disconnected', server: route ? { id: route } : null }; },
    async inspect() { return capabilities; },
    async selectPreferredTarget(pool) { return selectPreferredTarget(pool, capabilities); },
    async connect(target, { signal }) {
      assert.equal(controller.snapshot().activeOperations.length, 0);
      switches++; if (options.connectEntered) options.connectEntered.resolve();
      if (options.blockConnect) await Promise.race([releaseConnect.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      if (options.failConnect) throw new ProtonVpnError('AUTH_REQUIRED');
      if (options.failConnections > 0) {
        options.failConnections--; route = null;
        const error = new ProtonVpnError('CONNECTION_FAILED'); error.terminationConfirmed = true; throw error;
      }
      route = target.server || 'DE#2';
      return this.getStatus();
    },
  };
  const controller = createVpnController({ adapter, ...options.controllerOptions });
  const network = createNetworkOperations(controller);
  let config = { proxy, vpn: normalizeVpnSettings({ enabled: true, required: false, downloadRecoveryEnabled: true,
    downloadThresholdBps: 1000000, downloadDurationMs: 40, warmupMs: 0, averagingMs: 20,
    recoveryCooldownMs: 0, preferredServers: ['CH#1', 'DE#2'], ...options.vpn }) };
  const service = createVpnService({ controller, adapter, catalogStore: require('../scripts/vpn-test-catalog.cjs'), platform: 'linux', loadConfig: () => config, saveConfig: next => { config = next; } });
  await service.restore();
  const filename = path.join(__dirname, 'downloader.js');
  const mocks = {
    './network-operations': network,
    'fs/promises': { ...fsp, rename: async (from, to) => {
      if (options.renameFailures > 0 && to === path.join(dir, options.fileName || 'sample.bin')) {
        options.renameFailures--; throw Object.assign(new Error('Publication blocked by fixture'), { code: 'EACCES' });
      }
      return fsp.rename(from, to);
    } },
    https: { request: (_url, opts, callback) => http.request(proxy + '/api', opts, callback) },
    './download-session': { createDownloadSession: args => {
      const session = createDownloadSession({ ...args, tickMs: 10 });
      if (options.fastRetries) {
        let retryTime = 0;
        const activeNow = session.activeNow.bind(session);
        session.sleep = async ms => { retryTime += ms; };
        if (options.retryWindowMs) session.activeNow = () => activeNow() + retryTime;
      }
      return session;
    } },
    './mediainfo-poller': { startMediainfoPoller: (filename, callback) => {
      const record = { filename, callback, stopped: false }; media.push(record);
      return { async stop() { record.stopped = true; if (options.mediaStop) await options.mediaStop(record); } };
    } },
    './stream-server': options.streamServer || { registerStream: async value => { streams.push(['register', value.streamId]); return 'http://127.0.0.1/fixture-stream'; },
      markChunkReady: (id, index) => streams.push(['ready', id, index]), unregisterStream: (id, cleanup) => {
        streams.push(['unregister', id]); if (options.deferPlaybackCleanup) pendingPlayback.push(cleanup); else cleanup();
      } },
  };
  const pendingPlayback = [];
  function loadDownloader() {
    const module = { exports: {} };
    // Bound the failed-queue clock only in fixtures that exercise exhaustion.
    const source = fs.readFileSync(filename, 'utf8').replace('const MAX_RETRY_DURATION_MS = 8 * 60 * 60 * 1_000;',
      options.retryWindowMs ? `const MAX_RETRY_DURATION_MS = ${options.retryWindowMs};` : '$&');
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename })(
      id => Object.hasOwn(mocks, id) ? mocks[id] : require(id.startsWith('.') ? path.resolve(__dirname, id) : id), module, module.exports);
    module.exports.installDownloadVpn(service); return module.exports;
  }
  let downloader = loadDownloader();
  const callbacks = { onLog: message => { logs.push(message); options.onLog?.(message, downloader); }, onProgress: value => progress.push(value), onBatchStart: data => batches.push(data),
    onFileComplete: data => { files.push(data); options.onFileComplete?.(data, downloader); }, onDone: data => done.push(data), onError: error => errors.push(error), onDecryptProgress: data => options.onDecryptProgress?.(data, downloader),
    onMediaInfo: data => options.onMediaInfo?.(data),
    onSparsePreview: data => { previews.push(data); options.onPreview?.(data, downloader); },
    onVpnState: state => { states.push(state); if (state.state === 'attention' || state.message?.includes('candidates are exhausted') || state.message?.includes('configured limit')) waiting.resolve(); options.onState?.(state, downloader); }, onSpeed() {} };
  t.after(async () => {
    downloader.abortDownload(); service.dispose(); controller.dispose();
    for (const cleanup of pendingPlayback.splice(0)) await cleanup();
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve)); await fsp.rm(dir, { recursive: true, force: true });
  });
  return { dir, plain, encrypted, entries, callbacks, requests, states, files, logs, done, errors, controller, service, network, streams, progress, previews, media, batches, commands, entered, waiting, pendingPlayback,
    switches: () => switches, apiCalls: () => apiCalls, dataCalls: () => dataCalls, liveResponses: () => liveResponses, setRoute: value => { route = value; },
    releaseConnect: releaseConnect.resolve, downloader,
    reload() { downloader = loadDownloader(); this.downloader = downloader; },
    async staging() {
      return openDownloadStaging(downloadStagingIdentity({ outPath: path.join(dir, options.fileName || 'sample.bin'), fileSize: plain.length,
        fileKey: key, fileIv: iv, metaMacHex: referenceMac(plain).toUpperCase(), postBody: JSON.stringify([{ a: 'g', p: 'TEST', g: 1 }]),
        apiUrl: 'https://g.api.mega.co.nz/cs', chunkSize: this.args.chunkSize, mode: 'normal' }));
    },
    async retained() {
      for (const name of await fsp.readdir(dir)) if (name.startsWith('.m3-download-')) {
        const candidate = path.join(dir, name, 'encrypted', '0.part');
        if (fs.existsSync(candidate)) return candidate;
      }
      throw new Error('No retained encrypted cache');
    },
    args: { url: options.folder ? 'https://mega.nz/folder/ROOT#' + Buffer.from(key, 'hex').toString('base64url') : 'https://mega.nz/file/TEST#' + fullKey,
      outputDir: dir, proxy, maxThreads: options.threads || 4, chunkSize: options.chunkSize || 1024, streamMode: options.streamMode, streamMethod: options.streamMethod || 'http' },
    run() { return downloader.startDownload(this.args, callbacks); } };
}

test('a failed status poll during an advancing stream preserves the transfer and its final integrity without switching', async t => {
  const options = { trickle: true, streamMode: true }, f = await fixture(t, options);
  const work = f.run(); await f.entered.promise; options.statusError = true;
  await f.controller.poll(); assert.equal(f.controller.snapshot().state, 'checking');
  assert.ok(f.controller.snapshot().activeOperations.every(operation => !operation.interrupted));
  options.statusError = false; await f.controller.poll(); await work;
  assert.equal(f.switches(), 0); assert.equal(f.files.length, 1); assert.equal(f.done[0].failedFiles, 0);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('persistent status uncertainty recovers a partial download automatically and preserves its final MAC', async t => {
  let f;
  const options = { stall: true, controllerOptions: { statusGraceMs: 15 },
    vpn: { downloadDurationMs: 10000, preferredServers: ['DE#2'] },
    onState(state) { if (state.state === 'recovering' && options.statusError) { options.statusError = false; f.setRoute(null); } } };
  f = await fixture(t, options); const work = f.run(); await f.entered.promise;
  let partial;
  for (let i = 0; i < 80; i++) {
    partial = await f.retained().catch(() => null);
    if (partial && fs.statSync(partial).size === 16) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(fs.statSync(partial).size, 16);
  options.statusError = true; await f.controller.poll(); await work;
  assert.equal(f.switches(), 1); assert.equal(f.files.length, 1); assert.equal(f.done[0].failedFiles, 0);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].retained, 16);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});

test('zero-progress and sustained low speed recover via the Worker path and resume encrypted bytes', async t => {
  for (const zero of [true, false]) {
    const f = await fixture(t, { stall: true, zero }); await f.run();
    assert.equal(f.switches(), 1); assert.equal(f.done[0].failedFiles, 0); assert.equal(f.files.length, 1);
    assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
    assert.equal(f.requests[1].retained, zero ? 0 : 16);
    assert.ok(f.states.some(state => state.state === 'recovering'));
    assert.ok(f.states.some(state => state.state === 'resuming')); assert.equal(f.errors.length, 0);
  }
});
test('failed VPN candidates and a later retry round preserve the partial download and final integrity', async t => {
  const f = await fixture(t, { stall: true, failConnections: 1, vpn: { preferredServers: ['CH#1', 'DE#2', 'US#3'],
    connectionRetry: { initialDelayMs: 0, maxCandidates: 1, roundRetryDelayMs: 20 } } });
  await f.run();
  assert.equal(f.switches(), 2); assert.equal(f.files.length, 1); assert.equal(f.done[0].failedFiles, 0);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].route, 'US#3'); assert.equal(f.requests[1].retained, 16);
  assert.ok(f.states.some(state => state.message?.includes('candidates are exhausted')));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('a 200 response ignoring Range restarts from zero without duplicating retained data', async t => {
  const f = await fixture(t, { stall: true, ignoreRange: true }); await f.run();
  assert.equal(f.requests[1].retained, 16); assert.equal(f.done[0].failedFiles, 0);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('expired download URLs are refreshed without spending the VPN recovery budget', async t => {
  const f = await fixture(t, { expired: true }); await f.run();
  assert.equal(f.switches(), 0); assert.ok(f.apiCalls() >= 3); assert.equal(f.done[0].failedFiles, 0);
});
test('completed chunk checkpoints and a partial encrypted next chunk survive recovery', async t => {
  const f = await fixture(t, { chunkSize: 32, stall: true, stallBase: 32 });
  const stage = await f.staging();
  await fsp.writeFile(stage.plaintext, f.plain.subarray(0, 32));
  await stage.writeCheckpoints([0]); await stage.close();
  await f.run();
  assert.ok(f.requests.every(request => request.base !== 0));
  assert.ok(f.requests.some(request => request.base === 32 && request.retained === 16));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
  assert.equal(f.done[0].failedFiles, 0);
});
test('streaming defers speed switching while data advances and keeps one stream registration', async t => {
  const f = await fixture(t, { trickle: true, streamMode: true, chunkSize: 32 }); await f.run();
  assert.equal(f.switches(), 0); assert.ok(f.states.some(state => state.state === 'deferred'));
  assert.equal(f.streams.filter(item => item[0] === 'register').length, 1);
  assert.equal(f.streams.filter(item => item[0] === 'ready').length, 3);
  assert.ok(f.progress.filter(item => item.chunk === 3).every(item => item.receivedBytes <= 64));
  assert.ok(f.progress.some(item => item.completedChunks?.includes(3) && !item.completedChunks.includes(2)));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('streaming resumes a genuine stall without restarting its local playback registration', async t => {
  const f = await fixture(t, { stall: true, streamMode: true, chunkSize: 32 }); await f.run();
  assert.equal(f.switches(), 1); assert.equal(f.streams.filter(item => item[0] === 'register').length, 1);
  assert.equal(f.streams.filter(item => item[0] === 'ready').length, 3);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('Stop and Skip during a connection change cannot restart the canceled download', async t => {
  for (const skipped of [true, false]) {
    const connectEntered = deferred(), f = await fixture(t, { stall: true, blockConnect: true, connectEntered });
    const work = f.run(); await connectEntered.promise;
    if (skipped) f.downloader.skipCurrentDownload(); else f.downloader.abortDownload();
    await work; f.releaseConnect(); await turn();
    assert.equal(f.done.length, 1); assert.equal(f.done[0].skipped, skipped); assert.equal(f.done[0].canceled, !skipped);
    assert.equal(f.dataCalls(), 1); assert.equal(f.files.length, 0);
    assert.equal(f.service.snapshot().transferring, false);
  }
});
test('speed recovery waits for unrelated work and canceling the queued download leaves that work alive', async t => {
  const f = await fixture(t, { stall: true });
  const holding = await f.controller.acquire({ kind: 'upload', resources: ['megacmd-session'] });
  const queued = deferred(); f.service.onChange(state => { if (state.controller.pendingSwitches) queued.resolve(); });
  const work = f.run(); await queued.promise;
  assert.equal(f.switches(), 0); assert.equal(holding.signal.aborted, false);
  f.downloader.abortDownload(); await work; holding.release(); await turn();
  assert.equal(f.switches(), 0); assert.equal(f.done[0].canceled, true);
});
test('failed VPN recovery holds data for manual intervention instead of advancing or marking the file complete', async t => {
  for (const options of [{ failConnect: true }, { vpn: { preferredServers: ['CH#1'] } }]) {
    const f = await fixture(t, { stall: true, ...options });
    const work = f.run(); await f.waiting.promise;
    assert.equal(f.done.length, 0); assert.equal(f.files.length, 0);
    assert.ok(['waiting', 'attention'].includes(f.controller.snapshot().state));
    assert.ok((await fsp.stat(await f.retained())).size > 0);
    f.downloader.skipCurrentDownload(); await work; assert.equal(f.done[0].skipped, true);
  }
});
test('corrupt ciphertext fails the real MAC before final publication', async t => {
  const f = await fixture(t, { corrupt: true, onLog: (message, downloader) => {
    if (message.includes('integrity verification failed')) downloader.abortDownload();
  } });
  await f.run();
  assert.equal(f.files.filter(item => item.success && !item.skipped).length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'sample.bin')), false);
  assert.ok(f.logs.some(message => message.includes('integrity verification failed')));
});
test('download recovery remains inert when VPN control is disabled', async t => {
  const f = await fixture(t, { vpn: { enabled: false } }); await f.run();
  assert.equal(f.switches(), 0); assert.equal(f.done[0].failedFiles, 0); assert.equal(f.states.length, 0);
});

test('tunnel loss resumes streaming and shares an already-running automatic reconnect', async t => {
  for (const autoRecover of [false, true]) {
    const f = await fixture(t, { stall: true, streamMode: true, chunkSize: 32, vpn: { autoRecover } });
    const work = f.run(); await f.entered.promise; f.controller.reportTunnelLoss(); await work;
    assert.equal(f.switches(), 1); assert.equal(f.done[0].failedFiles, 0);
    assert.equal(f.streams.filter(item => item[0] === 'register').length, 1);
    assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
  }
});
test('overlapping transfer alarms share one switch and canceling one caller preserves another', async t => {
  const connectEntered = deferred(), f = await fixture(t, { stall: true, blockConnect: true, connectEntered });
  const one = createDownloadSession({ network: f.network, service: f.service, tickMs: 10 });
  const two = createDownloadSession({ network: f.network, service: f.service, tickMs: 10 });
  const transfer = (session, dest) => session.run(async observe => {
    let retained = 0; try { retained = (await fsp.stat(dest)).size; } catch {}
    return downloadTransfer(f.args.proxy + '/https://cdn.invalid/shared', dest, { network: f.network, expectedBytes: f.plain.length,
      startByte: retained, signal: observe.signal, monitored: true, onStarted: observe.start, onBytes: observe.add });
  }, { transfer: true });
  const a = transfer(one, path.join(f.dir, 'one.enc')), b = transfer(two, path.join(f.dir, 'two.enc'));
  const canceled = assert.rejects(a, error => error.skipped === true);
  await connectEntered.promise; one.cancel(true); await canceled; f.releaseConnect(); await b;
  assert.equal(f.switches(), 1); assert.deepEqual(await fsp.readFile(path.join(f.dir, 'two.enc')), f.encrypted);
  await one.close(); await two.close();
});
test('recovery budget exhaustion holds the download instead of repeatedly retrying on the old route', async t => {
  const f = await fixture(t, { stall: true, stallAlways: true, vpn: { maxRecoverySwitches: 1 } });
  const work = f.run(); await f.waiting.promise;
  assert.equal(f.switches(), 1); assert.equal(f.dataCalls(), 2);
  assert.equal(f.controller.snapshot().state, 'waiting'); assert.equal(f.files.length, 0);
  f.downloader.abortDownload(); await work; assert.equal(f.done[0].canceled, true);
});
test('a same-size corrupt completed file is verified and replaced rather than skipped', async t => {
  const f = await fixture(t); await fsp.writeFile(path.join(f.dir, 'sample.bin'), Buffer.alloc(f.plain.length));
  await f.run(); assert.equal(f.files[0].skipped, false);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('transfer policy stays fixed through local work while unrelated settings can save', async t => {
  const f = await fixture(t); const session = createDownloadSession({ network: f.network, service: f.service });
  assert.equal((await f.service.saveSettings({ downloadRecoveryEnabled: false })).error.code, 'BUSY');
  await f.service.saveApplicationConfig({ defaultTab: 'settings' });
  await session.close(); assert.equal((await f.service.saveSettings({ downloadRecoveryEnabled: false })).ok, true);
});
test('parallel folder files share recovery and emit exactly one completion per file', async t => {
  const f = await fixture(t, { folder: true, stall: true }); await f.run();
  assert.equal(f.switches(), 1); assert.equal(f.done[0].totalFiles, 2); assert.equal(f.files.length, 2);
  assert.equal(new Set(f.files.map(file => file.fileName)).size, 2);
  for (const name of ['first.bin', 'second.bin']) assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group', name)), f.plain);
});
test('canceling folder recovery retains completed files and reports the original batch size', async t => {
  const f = await fixture(t, { folder: true, stall: true, stallFile: 'F1', threads: 1, onState: (state, downloader) => {
    if (state.state === 'recovering') downloader.abortDownload();
  } }); await f.run();
  assert.equal(f.done[0].totalFiles, 2); assert.equal(f.done[0].completedFiles, 1); assert.equal(f.done[0].canceled, true);
  assert.equal(f.files.length, 1); assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group', 'first.bin')), f.plain);
  assert.equal(fs.existsSync(path.join(f.dir, 'group', 'second.bin')), false);
});
test('retry after resolving an action-required failure resumes the same retained download', async t => {
  const options = { stall: true, failConnect: true }, f = await fixture(t, options);
  const work = f.run(); await f.waiting.promise; options.failConnect = false;
  assert.equal(f.service.retryConnection().ok, true);
  await work; assert.equal(f.files.length, 1); assert.equal(f.done[0].failedFiles, 0);
  assert.ok(f.requests.some(request => request.retained === 16));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('stale checkpoints cannot skip missing or truncated cached plaintext', async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t, { chunkSize: 32 });
    const stage = await f.staging();
    await stage.writeCheckpoints([0, 32]);
    if (existing) await fsp.writeFile(stage.plaintext, f.plain.subarray(0, 16));
    await stage.close();
    await f.run(); assert.ok(f.requests.some(request => request.base === 0));
    assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
    assert.equal(f.done[0].failedFiles, 0);
  }
});

test('temporary suffix collisions preserve distinct files in both orders and with parallel downloads', async t => {
  for (const suffix of ['.bin', '.enc', '.control', '.0.enc']) {
    for (const reverse of [false, true]) for (const threads of [1, 4]) for (const chunkSize of [32, 1024]) {
      const names = ['file' + suffix, 'file']; if (reverse) names.reverse();
      const f = await fixture(t, { folder: true, names, distinct: true, threads, chunkSize,
        fastRetries: true, vpn: { enabled: false } });
      await f.run(); assert.equal(f.done[0].failedFiles, 0); assert.equal(f.files.length, 2);
      for (const entry of f.entries) assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group', entry.name)), entry.plain);
    }
  }
});
test('duplicate final destinations fail before any folder data is written', async t => {
  const f = await fixture(t, { folder: true, names: ['same.bin', 'same.bin'], distinct: true, vpn: { enabled: false } });
  await f.run(); assert.equal(f.done[0].totalFiles, 2); assert.equal(f.done[0].failedFiles, 2);
  assert.equal(f.dataCalls(), 0); assert.equal(f.files.length, 2);
  assert.ok(f.logs.some(message => message.includes('Multiple folder files map to the same output path')));
});

test('folder key failures retain the requested total while healthy siblings verify and publish', async t => {
  const mutations = [
    ['FILE_KEY_MISSING', node => { delete node.k; }],
    ['FILE_KEY_MISSING', node => { node.k = ''; }],
    ['FILE_KEY_FORMAT', node => { node.k = { invalid: true }; }],
    ['FILE_KEY_FORMAT', node => { node.k = 'ROOT:!!!'; }],
    ['FILE_KEY_FORMAT', node => { node.k = 'ROOT:' + 'A'.repeat(43) + '!'; }],
    ['FILE_KEY_LENGTH', (node, helpers) => { node.k = 'ROOT:' + helpers.wrap(Buffer.alloc(16)); }],
    ['FILE_KEY_LENGTH', (node, helpers) => { node.k = 'ROOT:' + helpers.wrap(Buffer.alloc(48)); }],
  ];
  for (const [code, mutate] of mutations) {
    const f = await fixture(t, { folder: true, vpn: { enabled: false },
      onNodes(nodes, helpers) { mutate(nodes.find(node => node.h === 'F1'), helpers); } });
    await f.run();
    assert.equal(f.batches[0].totalFiles, 2); assert.equal(f.batches[0].totalBytes, 192);
    assert.equal(f.done.length, 1); assert.equal(f.done[0].totalFiles, 2);
    assert.equal(f.done[0].failedFiles, 1); assert.equal(f.done[0].succeededFiles, 1);
    assert.equal(f.files.length, 2); assert.equal(new Set(f.files.map(file => file.nodeHandle)).size, 2);
    const failed = f.files.find(file => file.nodeHandle === 'F1');
    assert.equal(failed.errorCode, code); assert.equal(failed.success, false); assert.equal(failed.skipped, false);
    assert.equal(failed.fileName, 'group/file-F1');
    assert.equal(f.commands.filter(command => command.a === 'g' && command.n === 'F1').length, 0);
    assert.equal(f.dataCalls(), 1); assert.equal(f.errors.length, 0);
    assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group/first.bin')), f.plain);
    assert.deepEqual(await fsp.readdir(path.join(f.dir, 'group')), ['first.bin']);
    assert.equal(f.logs.some(message => message.includes('retry queue')), false);
  }
});

test('an all-unusable folder fails promptly without file requests, output directories, or secret key logs', async t => {
  for (const decryptFailure of [false, true]) {
    const f = await fixture(t, { folder: true, vpn: { enabled: false },
      onNodes(nodes) { if (!decryptFailure) for (const node of nodes.filter(node => node.t === 0)) delete node.k; } });
    if (decryptFailure) f.args.url = 'https://mega.nz/folder/ROOT#' + '@'.repeat(22);
    await f.run();
    assert.equal(f.done[0].totalFiles, 2); assert.equal(f.done[0].failedFiles, 2);
    assert.equal(f.done[0].succeededFiles, 0); assert.equal(f.files.length, 2);
    assert.ok(f.files.every(file => file.errorCode === (decryptFailure ? 'FILE_KEY_DECRYPT' : 'FILE_KEY_MISSING')));
    assert.equal(f.commands.length, 1); assert.equal(f.dataCalls(), 0);
    assert.deepEqual(await fsp.readdir(f.dir), []);
    for (const entry of f.entries) assert.equal(f.logs.join('\n').includes(entry.fullKey), false);
  }
});

test('folder selection includes unusable descendants only within the requested scope', async t => {
  for (const scope of ['whole', 'subfolder', 'relative', 'file', 'absent']) {
    const f = await fixture(t, { folder: true, names: ['first.bin', 'second.bin', 'outside.bin'], vpn: { enabled: false },
      onNodes(nodes, { wrap, attribute }) {
        nodes.push({ h: 'CHILD', p: 'ROOT', t: 1, k: 'ROOT:' + wrap(Buffer.from(key, 'hex')), a: attribute('selected') },
          { h: 'DEEP', p: 'CHILD', t: 1, k: 'ROOT:' + wrap(Buffer.from(key, 'hex')), a: attribute('deep') },
          { h: 'OTHER', p: 'ROOT', t: 1, k: 'ROOT:' + wrap(Buffer.from(key, 'hex')), a: attribute('other') });
        for (const node of nodes.filter(node => node.t === 0)) {
          node.p = node.h === 'F2' ? 'OTHER' : 'DEEP';
          if (node.h !== 'F0') delete node.k;
        }
      } });
    if (scope === 'subfolder') f.args.url += '/folder/CHILD';
    if (scope === 'relative') f.args.relPath = 'SELECTED/deep';
    if (scope === 'file') f.args.url += '/file/F1';
    if (scope === 'absent') f.args.url += '/file/MISSING';
    await f.run();
    if (scope === 'absent') {
      assert.equal(f.batches.length, 0); assert.equal(f.files.length, 0);
      assert.ok(f.logs.some(message => message.includes('handle not found'))); continue;
    }
    const total = scope === 'whole' ? 3 : scope === 'file' ? 1 : 2;
    assert.equal(f.batches[0].totalFiles, total); assert.equal(f.done[0].totalFiles, total);
    assert.equal(f.done[0].failedFiles, scope === 'whole' ? 2 : 1);
    assert.equal(f.files.length, total); assert.equal(f.files.some(file => file.nodeHandle === 'F2'), scope === 'whole');
    assert.equal(f.dataCalls(), scope === 'file' ? 0 : 1);
    assert.equal(f.logs.some(message => message.includes('handle not found')), false);
  }
});

test('unavailable folder names make relative-path selection fail explicitly instead of excluding files', async t => {
  const f = await fixture(t, { folder: true, vpn: { enabled: false }, onNodes(nodes) {
    nodes.push({ h: 'CHILD', p: 'ROOT', t: 1 });
    for (const node of nodes.filter(node => node.t === 0)) { node.p = 'CHILD'; delete node.k; }
  } });
  f.args.relPath = 'selected'; await f.run();
  assert.equal(f.done[0].failedFiles, 1); assert.equal(f.batches.length, 0);
  assert.ok(f.logs.some(message => message.includes('Cannot resolve requested path')));
  assert.equal(f.dataCalls(), 0); assert.deepEqual(await fsp.readdir(f.dir), []);
});

test('failed reporting labels cannot collide with a healthy destination or merge file results', async t => {
  const f = await fixture(t, { folder: true, names: ['file-F1', 'bad.bin'], vpn: { enabled: false },
    onNodes(nodes) { delete nodes.find(node => node.h === 'F1').k; } });
  await f.run(); assert.equal(f.done[0].failedFiles, 1); assert.equal(f.done[0].succeededFiles, 1);
  assert.equal(f.files.length, 2); assert.equal(f.files[0].fileName, f.files[1].fileName);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group/file-F1')), f.plain);
});

test('metadata failure counts survive recovered and exhausted transfer retry queues', async t => {
  for (const recover of [true, false]) {
    const f = await fixture(t, { folder: true, fastRetries: true, retryWindowMs: recover ? 300000 : 1,
      failData: { F0: recover ? 20 : 100 }, vpn: { enabled: false },
      onNodes(nodes) { delete nodes.find(node => node.h === 'F1').k; } });
    await f.run();
    assert.equal(f.done[0].totalFiles, 2); assert.equal(f.done[0].failedFiles, recover ? 1 : 2);
    assert.equal(f.done[0].succeededFiles, recover ? 1 : 0); assert.equal(f.files.length, 2);
    assert.equal(f.files.filter(file => file.nodeHandle === 'F1').length, 1);
    assert.equal(f.dataCalls(), recover ? 21 : 20);
    assert.ok(f.logs.some(message => message.includes(recover ? 'RECOVERED' : 'permanently failed')));
  }
});

test('folder output preflight preserves key failures and counts every file it prevents downloading', async t => {
  const f = await fixture(t, { folder: true, names: ['same.bin', 'same.bin', 'bad.bin'], vpn: { enabled: false },
    onNodes(nodes) { delete nodes.find(node => node.h === 'F2').k; } });
  await f.run(); assert.equal(f.done[0].totalFiles, 3); assert.equal(f.done[0].failedFiles, 3);
  assert.equal(f.files.filter(file => file.errorCode === 'FILE_KEY_MISSING').length, 1);
  assert.equal(f.files.filter(file => file.errorCode === 'FOLDER_OUTPUT_CONFLICT').length, 2);
  assert.equal(f.dataCalls(), 0); assert.deepEqual(await fsp.readdir(f.dir), []);
});

test('Stop and Skip in the failed transfer queue preserve earlier key failures', async t => {
  for (const skip of [false, true]) {
    const f = await fixture(t, { folder: true, fastRetries: true, failData: { F0: 100 }, vpn: { enabled: false },
      onNodes(nodes) { delete nodes.find(node => node.h === 'F1').k; },
      onLog(message, downloader) {
        if (message.includes('before round')) {
          if (skip) downloader.skipCurrentDownload(); else downloader.abortDownload();
        }
      } });
    await f.run(); assert.equal(f.done[0].totalFiles, 2); assert.equal(f.done[0].failedFiles, 1);
    assert.equal(f.done[0].skipped, skip); assert.equal(f.done[0].canceled, !skip);
    assert.equal(f.files.filter(file => !file.success && !file.skipped && !file.canceled).length, 1);
    assert.equal(f.dataCalls(), 20);
  }
});

test('Stop and Skip preserve emitted key failures and the selected batch total', async t => {
  for (const skip of [false, true]) {
    for (const duringTransfer of [false, true]) {
      const f = await fixture(t, { folder: true, names: ['first.bin', 'bad.bin', 'third.bin'], threads: 1,
        stall: duringTransfer, vpn: { enabled: false },
        onNodes(nodes) { delete nodes.find(node => node.h === 'F1').k; },
        onFileComplete(data, downloader) {
          if (data.errorCode && !duringTransfer) {
            if (skip) downloader.skipCurrentDownload(); else downloader.abortDownload();
          }
        } });
      const work = f.run();
      if (duringTransfer) {
        await f.entered.promise;
        if (skip) f.downloader.skipCurrentDownload(); else f.downloader.abortDownload();
      }
      await work;
      assert.equal(f.done.length, 1); assert.equal(f.done[0].totalFiles, 3);
      assert.equal(f.done[0].failedFiles, 1); assert.equal(f.done[0].skipped, skip); assert.equal(f.done[0].canceled, !skip);
      assert.equal(f.files.filter(file => file.errorCode).length, 1);
      assert.equal(f.files.some(file => file.success), false);
      assert.equal(new Set(f.files.map(file => file.nodeHandle)).size, f.files.length);
      assert.equal(f.dataCalls(), duringTransfer ? 1 : 0);
    }
  }
});

test('fresh Retry refetches repaired folder metadata and verifies previously unavailable files', async t => {
  let broken = true;
  const f = await fixture(t, { folder: true, vpn: { enabled: false },
    onNodes(nodes) { if (broken) delete nodes.find(node => node.h === 'F1').k; } });
  await f.run(); assert.equal(f.done[0].failedFiles, 1);
  broken = false; await f.run();
  assert.equal(f.done[1].totalFiles, 2); assert.equal(f.done[1].failedFiles, 0); assert.equal(f.done[1].succeededFiles, 2);
  assert.equal(f.commands.filter(command => command.a === 'f').length, 2);
  assert.equal(f.dataCalls(), 2); assert.equal(f.files.filter(file => file.skipped && file.success).length, 1);
  for (const entry of f.entries) assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group', entry.name)), entry.plain);
});

test('supported share-key entries and unreadable attributes retain verification and fallback names', async t => {
  const f = await fixture(t, { folder: true, vpn: { enabled: false }, onNodes(nodes) {
    const first = nodes.find(node => node.h === 'F0'), second = nodes.find(node => node.h === 'F1');
    first.k = 'OTHER:' + 'A'.repeat(43) + '/' + first.k;
    second.k = Buffer.from(second.k.split(':')[1], 'base64url').toString('base64'); second.a = 'invalid-attribute';
  } });
  await f.run(); assert.equal(f.done[0].failedFiles, 0); assert.equal(f.files.length, 2);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group/first.bin')), f.plain);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group/file-F1')), f.plain);
});

test('a valid-length wrong folder file key still has to pass the MAC', async t => {
  const f = await fixture(t, { folder: true, names: ['wrong.bin'], fastRetries: true, retryWindowMs: 1, vpn: { enabled: false },
    onNodes(nodes, { wrap }) { nodes.find(node => node.h === 'F0').k = 'ROOT:' + wrap(Buffer.alloc(32)); } });
  await f.run(); assert.equal(f.done[0].failedFiles, 1); assert.equal(f.files.length, 1);
  assert.equal(f.files[0].errorCode, undefined); assert.equal(f.dataCalls(), 4);
  assert.ok(f.logs.some(message => message.includes('integrity verification failed')));
  assert.equal(fs.existsSync(path.join(f.dir, 'group/file-F0')), false);
});

test('unusable nodes with unavailable sizes remain files with explicitly unknown sizes', async t => {
  const f = await fixture(t, { folder: true, vpn: { enabled: false }, onNodes(nodes) {
    const failed = nodes.find(node => node.h === 'F1'); delete failed.k; delete failed.s;
  } });
  await f.run(); assert.equal(f.batches[0].totalFiles, 2); assert.equal(f.batches[0].totalBytes, 96);
  assert.equal(f.batches[0].unknownSizeFiles, 1); assert.equal(f.files.find(file => file.errorCode).sizeKnown, false);
  assert.equal(f.done[0].failedFiles, 1);
});

test('legacy partial-looking files and directories are never adopted or cleaned up', async t => {
  const f = await fixture(t, { vpn: { enabled: false }, chunkSize: 32 });
  const names = ['sample.bin.bin', 'sample.bin.enc', 'sample.bin.control', 'sample.bin.0.enc', 'sample.m3u'];
  for (const name of names) await fsp.writeFile(path.join(f.dir, name), 'KEEP-' + name);
  const directory = path.join(f.dir, 'sample.bin.stream_chunks'); await fsp.mkdir(directory);
  await fsp.writeFile(path.join(directory, 'mine'), 'KEEP-DIRECTORY');
  await f.run(); assert.equal(f.done[0].failedFiles, 0);
  for (const name of names) assert.equal(await fsp.readFile(path.join(f.dir, name), 'utf8'), 'KEEP-' + name);
  assert.equal(await fsp.readFile(path.join(directory, 'mine'), 'utf8'), 'KEEP-DIRECTORY');
});
test('a new-layout partial download resumes after stop and loading a fresh downloader module', async t => {
  const options = { stall: true, vpn: { enabled: false } }, f = await fixture(t, options);
  const work = f.run(); await f.entered.promise;
  let partial;
  for (let i = 0; i < 80; i++) {
    partial = await f.retained().catch(() => null);
    if (partial && (await fsp.stat(partial)).size === 16) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await fsp.stat(partial)).size, 16);
  f.downloader.abortDownload(); await work;
  options.stall = false; f.reload(); await f.run();
  assert.equal(f.done[1].failedFiles, 0); assert.equal(f.requests[1].retained, 16);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('corrupt retained plaintext is discarded before a verified retry', async t => {
  const f = await fixture(t, { chunkSize: 32, fastRetries: true, vpn: { enabled: false } });
  const stage = await f.staging();
  await fsp.writeFile(stage.plaintext, Buffer.alloc(32, 0xff)); await stage.writeCheckpoints([0]); await stage.close();
  await f.run(); assert.equal(f.done[0].failedFiles, 0);
  assert.ok(f.logs.some(line => /integrity verification failed/.test(line)));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('HTTP playlists and chunks cannot overwrite user files or a later playback attempt', async t => {
  const f = await fixture(t, { streamMode: true, chunkSize: 32, deferPlaybackCleanup: true, vpn: { enabled: false } });
  const playlist = path.join(f.dir, 'sample.m3u'), chunks = path.join(f.dir, 'sample.bin.stream_chunks');
  await fsp.writeFile(playlist, 'USER PLAYLIST'); await fsp.mkdir(chunks); await fsp.writeFile(path.join(chunks, 'mine'), 'USER DATA');
  const events = []; f.callbacks.onStreamUrl = value => events.push(value);
  await f.run(); await f.run();
  assert.equal(events.length, 2); assert.notEqual(events[0].m3uPath, events[1].m3uPath);
  assert.equal(events[0].outputFolder, f.dir); assert.equal(events[1].outputFolder, f.dir);
  assert.equal(await fsp.readFile(playlist, 'utf8'), 'USER PLAYLIST');
  assert.equal(await fsp.readFile(path.join(chunks, 'mine'), 'utf8'), 'USER DATA');
  await f.pendingPlayback.shift()();
  // The callback starts asynchronous owned cleanup; wait for that attempt only.
  for (let i = 0; i < 80 && fs.existsSync(events[0].m3uPath); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(events[0].m3uPath), false); assert.equal(fs.existsSync(events[1].m3uPath), true);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});
test('streaming preserves real playlist names, shared movie basenames and encrypted-suffix names', async t => {
  for (const streamMethod of ['http', 'sparse']) {
    const f = await fixture(t, { folder: true, streamMode: true, streamMethod, chunkSize: 32,
      names: ['movie.m3u', 'movie.mkv', 'movie.mp4', 'file.0.enc', 'file'], distinct: true, vpn: { enabled: false }, fastRetries: true });
    await f.run(); assert.equal(f.done[0].failedFiles, 0); assert.equal(f.files.length, 5);
    for (const entry of f.entries) assert.deepEqual(await fsp.readFile(path.join(f.dir, 'group', entry.name)), entry.plain);
  }
});
test('failed publication keeps the existing output and owned verified plaintext for retry', async t => {
  const options = { renameFailures: 1, fastRetries: true, vpn: { enabled: false },
    onLog: (message, downloader) => { if (message.includes('Publication blocked by fixture')) downloader.abortDownload(); } };
  const f = await fixture(t, options), filename = path.join(f.dir, 'sample.bin'), original = Buffer.alloc(f.plain.length, 255);
  await fsp.writeFile(filename, original); await f.run();
  assert.equal(f.files.length, 0); assert.equal(f.done[0].canceled, true);
  assert.deepEqual(await fsp.readFile(filename), original);
  const stage = await f.staging(); assert.deepEqual(await fsp.readFile(stage.plaintext), f.plain); await stage.close();
  f.reload(); await f.run(); assert.equal(f.done[1].failedFiles, 0);
  assert.deepEqual(await fsp.readFile(filename), f.plain);
});
test('a real HTTP playback reader draining after Stop cannot delete a subsequent download', async t => {
  let server;
  const module = { exports: {} }, filename = path.join(__dirname, 'stream-server.js');
  const localHttp = { ...http, createServer: handler => { server = http.createServer(handler); return server; } };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    id => id === 'http' ? localHttp : require(id), module, module.exports);
  t.after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
  const options = { streamMode: true, chunkSize: 32, stall: true, stallBase: 32, streamServer: module.exports, vpn: { enabled: false } };
  const f = await fixture(t, options), received = deferred();
  let client, firstPlaylist;
  f.callbacks.onStreamUrl = value => {
    if (firstPlaylist) return;
    firstPlaylist = value.m3uPath;
    client = http.get(value.url, response => { response.once('data', () => { f.downloader.abortDownload(); received.resolve(); }); response.on('error', () => {}); });
    client.on('error', () => {});
  };
  const work = f.run(); await received.promise; await work;
  assert.equal(f.done[0].canceled, true); assert.equal(fs.existsSync(firstPlaylist), true);
  options.stall = false; f.reload(); await f.run();
  assert.equal(f.done[1].failedFiles, 0);
  client.destroy();
  for (let i = 0; i < 80 && fs.existsSync(firstPlaylist); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(firstPlaylist), false);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});

test('sparse previews keep the media extension and publish only verified bytes, including edge sizes', async t => {
  for (const size of [0, 1, 16, 17, 96]) {
    let reader, f;
    const options = { size, fileName: 'nested/movie.mkv', streamMode: true, streamMethod: 'sparse', chunkSize: 32, vpn: { enabled: false },
      onPreview(data) {
        if (data.state === 'available') {
          assert.equal(path.extname(data.previewPath), '.mkv');
          assert.equal(fs.existsSync(data.finalPath), false);
          reader = fs.openSync(data.previewPath, 'r');
        }
      } };
    f = await fixture(t, options); await f.run();
    assert.equal(f.done[0].failedFiles, 0); assert.equal(f.files.length, 1);
    assert.deepEqual(await fsp.readFile(path.join(f.dir, options.fileName)), f.plain);
    assert.equal(f.previews.at(-1).state, 'published');
    if (reader !== undefined) { assert.deepEqual(fs.readFileSync(reader), f.plain); fs.closeSync(reader); }
    assert.ok(f.media.every(record => record.stopped && record.filename !== path.join(f.dir, options.fileName)));
    assert.equal(fs.existsSync(f.previews[0].previewPath), false);
  }
});

test('corrupt sparse streams never publish or destroy an existing output after all quick retries', async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t, { corrupt: true, fileName: 'movie.mkv', streamMode: true, streamMethod: 'sparse',
      chunkSize: 32, fastRetries: true, vpn: { enabled: false } });
    const finalPath = path.join(f.dir, 'movie.mkv'), original = Buffer.alloc(f.plain.length, 255);
    if (existing) await fsp.writeFile(finalPath, original);
    await f.run(); assert.equal(f.done[0].failedFiles, 1); assert.equal(f.files.length, 0);
    if (existing) assert.deepEqual(await fsp.readFile(finalPath), original); else assert.equal(fs.existsSync(finalPath), false);
    assert.equal(f.previews.filter(event => event.state === 'started').length, 4);
    assert.equal(f.previews.filter(event => event.state === 'published').length, 0);
    assert.equal(f.previews.filter(event => event.state === 'invalidated' && event.reason === 'integrity').length, 4);
    for (const event of f.previews) assert.equal(fs.existsSync(event.previewPath), false);
    assert.ok(f.media.every(record => record.stopped));
  }
});

test('sparse streaming verifies and skips an existing valid output without allocating a preview', async t => {
  const f = await fixture(t, { streamMode: true, streamMethod: 'sparse', vpn: { enabled: false } });
  await fsp.writeFile(path.join(f.dir, 'sample.bin'), f.plain); await f.run();
  assert.equal(f.dataCalls(), 0); assert.equal(f.media.length, 0); assert.equal(f.files[0].skipped, true);
  assert.deepEqual(f.previews.map(event => event.state), ['started', 'published']);
});

test('Stop and Skip invalidate sparse previews, preserve old outputs, and suppress late MediaInfo', async t => {
  for (const skip of [false, true]) {
    const durations = [], f = await fixture(t, { streamMode: true, streamMethod: 'sparse', chunkSize: 32, vpn: { enabled: false },
      onMediaInfo: data => durations.push(data), onPreview: (data, downloader) => {
        if (data.state === 'available') { if (skip) downloader.skipCurrentDownload(); else downloader.abortDownload(); }
      } });
    const original = Buffer.alloc(f.plain.length, 254), filename = path.join(f.dir, 'sample.bin');
    await fsp.writeFile(filename, original); await f.run();
    assert.equal(f.done[0].skipped, skip); assert.equal(f.done[0].canceled, !skip);
    assert.deepEqual(await fsp.readFile(filename), original); assert.equal(f.files.length, 0);
    assert.equal(f.previews.at(-1).state, 'invalidated');
    assert.equal(fs.existsSync(f.previews[0].previewPath), false);
    for (const record of f.media) record.callback(60000);
    assert.deepEqual(durations, []);
  }
});

test('sparse publication retry re-verifies retained plaintext across a fresh downloader without fetching data again', async t => {
  const options = { renameFailures: 1, fastRetries: true, streamMode: true, streamMethod: 'sparse', vpn: { enabled: false },
    onLog: (message, downloader) => { if (message.includes('Publication blocked by fixture')) downloader.abortDownload(); } };
  const f = await fixture(t, options); await f.run();
  assert.equal(f.files.length, 0); assert.equal(f.previews.at(-1).state, 'invalidated');
  const preview = f.previews[0].previewPath, calls = f.dataCalls();
  assert.deepEqual(await fsp.readFile(preview), f.plain);
  f.reload(); await f.run(); assert.equal(f.done[1].failedFiles, 0); assert.equal(f.dataCalls(), calls);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});

test('retained pending-publication markers cannot bypass a sparse MAC reread', async t => {
  const options = { renameFailures: 1, fastRetries: true, streamMode: true, streamMethod: 'sparse', vpn: { enabled: false },
    onLog: (message, downloader) => { if (message.includes('Publication blocked by fixture')) downloader.abortDownload(); } };
  const f = await fixture(t, options); await f.run();
  const calls = f.dataCalls(); await fsp.writeFile(f.previews[0].previewPath, Buffer.alloc(f.plain.length));
  f.reload(); await f.run(); assert.equal(f.done[1].failedFiles, 0); assert.ok(f.dataCalls() > calls);
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});

test('sparse VPN recovery keeps the same preview and completed chunk indices', async t => {
  const f = await fixture(t, { streamMode: true, streamMethod: 'sparse', chunkSize: 32, stall: true, stallBase: 32 });
  await f.run(); assert.equal(f.switches(), 1); assert.equal(f.done[0].failedFiles, 0);
  assert.equal(new Set(f.previews.map(event => event.attemptId)).size, 1);
  assert.ok(f.progress.some(event => event.completedChunks?.includes(3) && !event.completedChunks.includes(2)));
  assert.deepEqual(await fsp.readFile(path.join(f.dir, 'sample.bin')), f.plain);
});

test('unconfirmed MediaInfo shutdown prevents sparse publication and defers cleanup', async t => {
  const f = await fixture(t, { streamMode: true, streamMethod: 'sparse', fastRetries: true, vpn: { enabled: false },
    mediaStop: async () => { throw Object.assign(new Error('Unconfirmed reader fixture'), { code: 'MEDIAINFO_UNCONFIRMED' }); } });
  await f.run(); assert.equal(f.done[0].failedFiles, 1); assert.equal(f.files.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'sample.bin')), false);
  assert.ok(f.previews.filter(event => event.state === 'invalidated').length);
  for (const event of f.previews.filter(event => event.state === 'started')) assert.equal(fs.existsSync(event.previewPath), true);
});

test('Stop during a sparse MAC reread removes the preview without changing the destination', async t => {
  const f = await fixture(t, { streamMode: true, streamMethod: 'sparse', vpn: { enabled: false },
    onDecryptProgress: (_data, downloader) => downloader.abortDownload() });
  const original = Buffer.alloc(f.plain.length, 253), filename = path.join(f.dir, 'sample.bin');
  await fsp.writeFile(filename, original); await f.run();
  assert.equal(f.files.length, 0); assert.equal(f.done[0].canceled, true);
  assert.deepEqual(await fsp.readFile(filename), original);
  assert.equal(f.previews.at(-1).state, 'invalidated'); assert.equal(fs.existsSync(f.previews[0].previewPath), false);
});

test('sparse cleanup refuses changed ownership while keeping corrupt bytes out of final output', async t => {
  const roots = new Set();
  const f = await fixture(t, { streamMode: true, streamMethod: 'sparse', corrupt: true, fastRetries: true, vpn: { enabled: false },
    onPreview: data => {
      if (data.state === 'invalidated') {
        const root = path.dirname(data.previewPath); roots.add(root);
        fs.writeFileSync(path.join(root, 'manifest.json'), '{}');
      }
    } });
  await f.run(); assert.equal(f.done[0].failedFiles, 1); assert.equal(fs.existsSync(path.join(f.dir, 'sample.bin')), false);
  assert.ok(f.logs.some(line => line.includes('Download cache cleanup deferred')));
  for (const root of roots) assert.equal(fs.existsSync(root), true);
  assert.equal(f.previews.filter(data => data.state === 'published').length, 0);
});

test('mismatched, missing, and short 206 bodies are rejected before a resumed file is accepted', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'm3-range-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const contentRange of ['bytes 2-7/8', '', 'bytes 4-6/8']) {
    const server = http.createServer((req, res) => { res.writeHead(206, { ...(contentRange ? { 'Content-Range': contentRange } : {}), 'Content-Length': 4 }); res.end('DATA'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const controller = createVpnController(), network = createNetworkOperations(controller);
    const dest = path.join(dir, 'partial'); await fsp.writeFile(dest, 'HEAD');
    await assert.rejects(network.run('download', signal => downloadTransfer('http://127.0.0.1:' + server.address().port, dest,
      { network, expectedBytes: 8, startByte: 4, signal })), /Content-Range/);
    assert.equal(await fsp.readFile(dest, 'utf8'), 'HEAD');
    controller.dispose(); await new Promise(resolve => server.close(resolve));
  }
  const server = http.createServer((req, res) => {
    res.writeHead(206, { 'Content-Range': 'bytes 4-7/8', 'Content-Length': 4, Connection: 'close' }); res.end('D');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = createVpnController(), network = createNetworkOperations(controller), dest = path.join(dir, 'short');
  await fsp.writeFile(dest, 'HEAD');
  await assert.rejects(network.run('download', signal => downloadTransfer('http://127.0.0.1:' + server.address().port, dest,
    { network, expectedBytes: 8, startByte: 4, signal })), /aborted|Incomplete/);
  assert.ok((await fsp.stat(dest)).size < 8);
  controller.dispose(); await new Promise(resolve => server.close(resolve));
});
