'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { createVpnController } = require('./src/vpn-controller');
const network = require('./src/network-operations');
const { createMailInbox } = require('./src/mail-inbox');
const { createCloudflareSignupMail, signupEmailSource } = require('./src/signup-mail');
const mailInbox = createMailInbox({ directory: () => app.getPath('userData'), safeStorage, network });
const { createProtonVpn } = require('./src/protonvpn');
const { createVpnTerminalLog } = require('./src/vpn-terminal-log');
const { createVpnShutdown } = require('./src/vpn-shutdown');
const { createVpnService } = require('./src/vpn-service');
const { createCatalogStore } = require('./src/vpn-catalog-store');
const { fetchFolderTree } = require('./src/folder-browser');

const { startDownload, abortDownload, skipCurrentDownload, installDownloadVpn } = require('./src/downloader');
const { getBinPath }                   = require('./binPath');
const { validateCheckpointRoot } = require('./src/rfork-checkpoints');
const { createUploadJournal } = require('./src/upload-journal');
const { normalizeRforkSettings } = require('./src/rfork-settings');
const { readRforkManifest } = require('./src/rfork-bundle');
const { reviewUploadRecovery } = require('./src/upload-recovery-review');

const { loadConfig, saveConfig,
  getDataDir, getFileCsv, getAccountCsv, getMediainfoLog, getMediainfoGrabbedLog, getDownloadCsv, getImportCsv, getImportMediainfoLog } = require('./src/config');
  const { getMediaInfoFromUrl } = require('./src/mediainfo-checker');
const { parseCSVLine, deleteCsvRow }   = require('./src/utils');
const { refreshThresholdDays, parseAccountRecords, accountForDisplay } = require('./src/account-refresh-policy');
const { openMegaBrowser, closeMegaBrowser, shutdownMegaBrowser } = require('./src/browser-upload');
const { refreshAccounts, checkAccountsHealth,
  refreshSingleAccount, upgradeAllInsecure, installRefreshVpn,
  cancelRefreshAccounts, cancelSingleAccountRefresh } = require('./src/account-manager');
const { startUpload, cancelCurrentFile, killQueue,
  skipFile, reorderQueue, addFilesToQueue, installUploadVpn } = require('./src/upload-engine');
  const { appendImportRow, browseAccountFiles,
    getAccountFileLinks, checkImportQuota,
    doImportMegaLink }                               = require('./src/import-engine');
    const { startBulkImport, killBulkImportQueue,
      skipBulkImportItem }                             = require('./src/bulk-import-engine');
require('./src/account-creator').installCloudflareSignupMail(createCloudflareSignupMail({
  inbox: mailInbox, directory: () => app.getPath('userData'),
}));
      const { findFileInCloud, getMegacmdFolderLink,
        megaSwitch, megaLogout, shutdownMegaCmdServer }       = require('./src/megacmd');

        // ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

// One adapter/controller owns all network coordination. Disabled startup is inert.
const vpnTerminal = createVpnTerminalLog({ directory: () => path.join(app.getPath('userData'), 'vpn-logs') });
const protonVpn = createProtonVpn({ onTerminalEvent: event => vpnTerminal.record(event) });
let terminalNotifyTimer;
vpnTerminal.onChange(() => {
  if (!terminalNotifyTimer) terminalNotifyTimer = setTimeout(() => {
    terminalNotifyTimer = null; makeSend()('vpn:terminal-changed', true);
  }, 100);
});
let vpnService;
const vpnController = createVpnController({
  adapter: protonVpn,
  // No verified OS protection provider yet: required mode stays unavailable.
});
network.installNetworkOperations(vpnController);
vpnService = createVpnService({ controller: vpnController, adapter: protonVpn, loadConfig, saveConfig,
  catalogStore: createCatalogStore({ directory: () => app.getPath('userData') }) });
installRefreshVpn(vpnService);
installDownloadVpn(vpnService);
installUploadVpn(vpnService);
vpnService.onChange(state => { makeSend()('vpn:state', state); vpnTerminal.recordState(state.controller); });
let terminalQuitting = false, quitRequest = null, shutdownState = null;
const quitSequence = createVpnShutdown({ adapter: protonVpn,
  requireDisconnect: () => Boolean(vpnService.snapshot().preferences.enabled),
  stopWork: async () => {
    cancelRefreshAccounts();
    vpnService.dispose(); vpnController.dispose();
    await Promise.all([network.shutdown(), shutdownMegaBrowser(), shutdownMegaCmdServer()]);
    await mailInbox.dispose();
  },
  onProgress: (phase, message) => {
    shutdownState = { phase, message }; vpnTerminal.record({ kind: 'm3', text: message });
    makeSend()('app:shutdown', shutdownState);
  },
  flush: async () => { clearTimeout(terminalNotifyTimer); await vpnTerminal.dispose(); },
});
function requestQuit() {
  if (terminalQuitting || quitRequest) return quitRequest;
  quitRequest = (async () => {
    while (true) {
      try { await quitSequence.run(); terminalQuitting = true; app.quit(); return; }
      catch (error) {
        // Keep the window and diagnostic terminal available if Proton refuses
        // to disconnect. Never silently exit with the tunnel still enabled.
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        const options = { type: 'error', title: 'VPN disconnect not confirmed',
          message: 'M3 is staying open because Proton VPN disconnection could not be confirmed.',
          detail: (error.message || 'Proton VPN did not respond.') + '\n\nActive work has stopped. Retry, or keep M3 open to inspect the VPN terminal and close it again to retry.',
          buttons: ['Retry disconnect', 'Keep M3 open'], defaultId: 0, cancelId: 1, noLink: true };
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        if (result.response !== 0) return;
      }
    }
  })().catch(error => { console.error('M3 shutdown could not finish: ' + error.message); })
    .finally(() => { quitRequest = null; });
  return quitRequest;
}
app.on('before-quit', event => {
  if (terminalQuitting) return;
  event.preventDefault(); requestQuit();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, requestQuit);

// Helper used by every IPC handler that pushes events to the renderer.
function makeSend() {
  return (ch, data) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
      mainWindow.webContents.send(ch, data);
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 900, minHeight: 580,
    title: 'mega-suite',
    backgroundColor: '#ece8f5',
    icon: path.join(__dirname, 'assets', 'icon-512.png'),
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('close', event => { if (!terminalQuitting) { event.preventDefault(); requestQuit(); } });
  mainWindow.webContents.on('did-finish-load', () => { if (shutdownState) makeSend()('app:shutdown', shutdownState); });
  // mainWindow.webContents.openDevTools();

  // ── Right-click context menu ─────────────────────────────────────────────────
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menuItems = [];

    // Text editing actions — only show when relevant
    if (params.isEditable) {
      menuItems.push(
        { label: 'Cut',        role: 'cut',       enabled: params.selectionText.length > 0 },
        { label: 'Copy',       role: 'copy',      enabled: params.selectionText.length > 0 },
        { label: 'Paste',      role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
      );
    } else if (params.selectionText.trim().length > 0) {
      menuItems.push(
        { label: 'Copy', role: 'copy' },
        { label: 'Select All', role: 'selectAll' },
      );
    }

    // Link actions
    if (params.linkURL) {
      if (menuItems.length) menuItems.push({ type: 'separator' });
      menuItems.push({
        label: 'Copy Link Address',
        click: () => { require('electron').clipboard.writeText(params.linkURL); },
      });
      menuItems.push({
        label: 'Open Link in Browser',
        click: () => shell.openExternal(params.linkURL),
      });
    }

    if (menuItems.length === 0) return; // Nothing useful to show — suppress empty menu
    Menu.buildFromTemplate(menuItems).popup({ window: mainWindow });
  });

  const defaultMenu = Menu.getApplicationMenu();
  const newMenuTemplate = defaultMenu.items.map(item => {
    if (item.label === 'Help') {
      return {
        label: 'Help',
        submenu: [
          {
            label: 'PW = harry.lime',
            enabled: false,
          },
          { type: 'separator' },
          {
            label: 'First Time Setup',
            click: async () => {
              await shell.openExternal('https://drive.proton.me/urls/4654DM9CA8#zB2fiwsttKF8');
            },
          },
          {
            label: 'Documentation',
            click: async () => {
              await shell.openExternal('https://drive.proton.me/urls/675F7R1TDC#sOUBcvG6Ak2g');
            },
          },
          {
            label: "Done, Doing, To Do",
            click: async () => {
              await shell.openExternal('https://drive.proton.me/urls/Q3TW6XZ8EC#ERJ3JUOurcdV');
            },
          },
        ],
      };
    }
    return { role: item.role, label: item.label, submenu: item.submenu };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(newMenuTemplate));

  initCSVFiles();
}

const os = require('os');
const TEMP_DIR = path.join(os.homedir(), 'mega_temp');

function initCSVFiles() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const dataDir = getDataDir();
  if (!dataDir) return;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(getFileCsv()))      fs.writeFileSync(getFileCsv(),      'File Name,File Size,File Link,Folder Link,Email,Password,Upload Date,Folder Name\n');
  if (!fs.existsSync(getAccountCsv()))   fs.writeFileSync(getAccountCsv(),   'Email Address,Password,Bandwidth Used (GB),Date Created,Last Login Date,Account Status,Security Upgrade\n');
  if (!fs.existsSync(getMediainfoLog())) fs.writeFileSync(getMediainfoLog(), '', 'utf8');
  if (!fs.existsSync(getMediainfoGrabbedLog())) fs.writeFileSync(getMediainfoGrabbedLog(), '', 'utf8');
  if (!fs.existsSync(getDownloadCsv()))  fs.writeFileSync(getDownloadCsv(),  'filename,size_bytes,status,time_to_download_sec,timestamp,mega_link,output_dir\n');
  if (!fs.existsSync(getImportCsv()))    fs.writeFileSync(getImportCsv(),    'File Name,File Size,File Link,Folder Link,Email,Password,Import Date,Folder Name\n');
}

// ── Unix binary permission self-heal ──────────────────────────────────────────
// Some zip-based extractors and certain Electron packagers strip the execute
// bit from bundled binaries. Runs once at startup on Linux and macOS.
// Recurses into subdirectories to cover the megacmd/ bundle.
function ensureUnixBinPerms() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  try {
    const binDir = path.dirname(getBinPath('megatools'));
    if (!fs.existsSync(binDir)) return;

    const chmodDir = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // The shared rfork bundle contains notices and validation metadata.
          if (dir === binDir && entry.name === 'rfork-bundle') continue;
          chmodDir(full);
        } else if (entry.isFile()) {
          try { fs.chmodSync(full, 0o755); }
          catch (err) { console.error(`[perms] Could not chmod ${full}:`, err.message); }
        }
      }
    };

    chmodDir(binDir);
  } catch (err) {
    console.error('[perms] ensureUnixBinPerms failed:', err.message);
  }
}

// ── Update check ──────────────────────────────────────────────────────────────
const UPDATE_GIST_URL = 'https://gist.githubusercontent.com/mega-fork/77e65b948ee685ce373e6182ba974772/raw/m3.json';
const UPDATE_PASSWORD = 'harry.lime';

function isNewerVersion(remote, current) {
  const parse = v => (v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [rMaj, rMin, rPat] = parse(remote);
  const [cMaj, cMin, cPat] = parse(current);
  if (rMaj !== cMaj) return rMaj > cMaj;
  if (rMin !== cMin) return rMin > cMin;
  return rPat > cPat;
}

async function checkForUpdate() {
  try {
    const res = await fetch(UPDATE_GIST_URL);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.version) return;
    if (isNewerVersion(data.version, app.getVersion())) {
      makeSend()('app:updateAvailable', { version: data.version, notes: data.notes || '' });
    }
  } catch { /* non-fatal — silently ignore network or parse errors */ }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (shutdownState) return;
  try { await vpnService.restore(); } catch (error) { if (!shutdownState) throw error; return; }
  if (shutdownState) return;
  ensureUnixBinPerms();
  try {
    const bundle = readRforkManifest(app.isPackaged ? process.resourcesPath : __dirname);
    console.info(`[rfork] Bundled ${bundle.version}; ${getBinPath('rclone')}`);
  } catch (error) { console.error('[rfork] Bundle metadata unavailable: ' + error.message); }
  createWindow();
  // Check for updates once the renderer has fully loaded and registered its listeners
  mainWindow.webContents.once('did-finish-load', () => checkForUpdate());
  app.on('activate', () => { if (!shutdownState && !BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (!terminalQuitting) requestQuit(); });

// ── IPC: config ───────────────────────────────────────────────────────────────
ipcMain.handle('load-config', ()        => loadConfig());
ipcMain.handle('save-config', async (_, data) => {
  if (Object.hasOwn(data || {}, 'signupEmailSource')) signupEmailSource(data.signupEmailSource);
  if (Object.hasOwn(data || {}, 'dataDir') && data.dataDir !== loadConfig().dataDir && (network.hasTask('upload') || (getDataDir() && createUploadJournal(getDataDir()).read().length))) throw new Error('Resolve interrupted uploads before changing the data folder.');
  if (Object.hasOwn(data || {}, 'rforkUpload')) {
    const rforkUpload = normalizeRforkSettings(data.rforkUpload);
    const previous = normalizeRforkSettings(loadConfig().rforkUpload);
    if (rforkUpload.checkpointRoot !== previous.checkpointRoot && network.hasTask('upload')) throw new Error('Stop uploads before changing checkpoint storage.');
    if (rforkUpload.checkpointRoot) validateCheckpointRoot(rforkUpload.checkpointRoot);
    data = { ...data, rforkUpload };
  }
  await vpnService.saveApplicationConfig(data); initCSVFiles(); return true;
});

// Mail credentials stay in the main process, separate from ordinary settings.
for (const [channel, action] of Object.entries({
  'mail-state': () => ({ state: mailInbox.state() }),
  'mail-save': input => ({ state: mailInbox.save(input) }),
  'mail-test': input => mailInbox.test(input),
  'mail-sync': input => mailInbox.sync(input),
  'mail-domains': input => mailInbox.domains(input),
  'mail-add-domains': input => mailInbox.addDomains(input),
  'mail-domain-action': input => mailInbox.domainAction(input),
  'mail-disconnect': id => ({ state: mailInbox.disconnect(id) }),
  'mail-list': input => mailInbox.list(input),
  'mail-read': id => mailInbox.read(id),
})) ipcMain.handle(channel, async (event, input) => {
  if (event.sender !== mainWindow?.webContents) return { ok: false, error: 'Unknown inbox window.' };
  try { return { ok: true, ...await action(input) }; }
  catch (error) { return { ok: false, error: error.message || 'Inbox request failed.' }; }
});
ipcMain.handle('mail-export-setup', async event => {
  if (event.sender !== mainWindow?.webContents) return { ok: false, error: 'Unknown inbox window.' };
  try {
    const chosen = await dialog.showOpenDialog(mainWindow, { title: 'Choose where to export mail Worker setup', properties: ['openDirectory', 'createDirectory'] });
    if (chosen.canceled || !chosen.filePaths.length) return { ok: true, canceled: true };
    const destination = await fs.promises.mkdtemp(path.join(chosen.filePaths[0], 'm3-mail-inbox-'));
    await fs.promises.mkdir(path.join(destination, 'migrations'));
    for (const file of ['worker.mjs', 'package.json', 'package-lock.json', 'wrangler.jsonc', 'migrations/0001_inbox.sql', 'migrations/0002_multiple_domains.sql']) {
      await fs.promises.copyFile(path.join(__dirname, 'cloudflare/mail-worker', file), path.join(destination, file));
    }
    await fs.promises.copyFile(path.join(__dirname, 'docs/cloudflare-inbox.md'), path.join(destination, 'SETUP.md'));
    return { ok: true, destination };
  } catch { return { ok: false, error: 'Could not export the mail Worker setup files.' }; }
});

// VPN commands are structured, validated requests; no arbitrary CLI execution.
ipcMain.handle('vpn-get-state', () => vpnService.snapshot());
ipcMain.handle('app-shutdown-state', () => shutdownState);
ipcMain.on('app-retry-quit', requestQuit);
// Raw diagnostics use their own channel, never the public VPN state/errors.
ipcMain.handle('vpn-terminal-read', (_, after) => vpnTerminal.read(after));
ipcMain.handle('vpn-terminal-copy', () => {
  try { clipboard.writeText(vpnTerminal.text()); return { ok: true }; }
  catch { return { ok: false, message: 'The VPN log could not be copied.' }; }
});
ipcMain.handle('vpn-terminal-save', async () => {
  // Capture the export before the user spends time in the file picker.
  const text = vpnTerminal.text();
  try {
    const chosen = await dialog.showSaveDialog(mainWindow, { title: 'Save VPN terminal log',
      defaultPath: 'm3-vpn-terminal-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt',
      filters: [{ name: 'Text log', extensions: ['txt'] }] });
    if (chosen.canceled || !chosen.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(chosen.filePath, text, { mode: 0o600 });
    return { ok: true };
  } catch { return { ok: false, message: 'The VPN log could not be saved.' }; }
});
ipcMain.handle('vpn-diagnose', () => vpnService.diagnose());
ipcMain.handle('vpn-save-settings', (_, settings) => vpnService.saveSettings(settings));
ipcMain.handle('vpn-command', (_, command) => vpnService.command(command));
ipcMain.handle('vpn-cancel-command', (_, id) => vpnService.cancelCommand(id));
ipcMain.handle('vpn-retry', () => vpnService.retryConnection());
ipcMain.handle('vpn-change-pool', (_, selection) => vpnService.changeWaitingPool(selection));
ipcMain.handle('vpn-edit-pool', (_, action) => vpnService.editWaitingPool(action));
ipcMain.handle('vpn-catalog', () => vpnService.getCatalog());
ipcMain.handle('vpn-catalog-search', (_, query) => vpnService.searchCatalog(query));
ipcMain.handle('vpn-pool-preview', (_, selection) => vpnService.previewPool(selection));
ipcMain.handle('vpn-catalog-action', async (_, action) => {
  if (!['import', 'reload', 'reset'].includes(action)) return vpnService.manageCatalog(action);
  if (action !== 'import') return vpnService.manageCatalog(action);
  if (process.platform !== 'linux') return vpnService.manageCatalog(action);
  try {
    const chosen = await dialog.showOpenDialog(mainWindow, { title: 'Import local Proton server catalog', properties: ['openFile'],
      filters: [{ name: 'Server CSV or text list', extensions: ['csv', 'txt'] }] });
    if (chosen.canceled || !chosen.filePaths.length) return { ok: true, canceled: true, state: vpnService.snapshot() };
    return vpnService.manageCatalog('import', chosen.filePaths[0]);
  } catch {
    return { ok: false, error: { code: 'CATALOG_DIALOG_FAILED', message: 'The local catalog file picker could not be opened.' }, state: vpnService.snapshot() };
  }
});

// ── IPC: shared dialogs & shell ───────────────────────────────────────────────
ipcMain.handle('select-folder', async e => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select output folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-txt', async e => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openFile'],
    title: 'Select .txt file of MEGA links',
    filters: [{ name: 'Text files', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  return fs.readFileSync(result.filePaths[0], 'utf8');
});

ipcMain.handle('open-folder',    (_, folderPath) => shell.openPath(folderPath));
ipcMain.handle('open-file',      (_, filePath)   => shell.openPath(filePath));
ipcMain.handle('open-external',  (_, url)        => shell.openExternal(url));
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('browse-mega-folder', async (_event, url) => {
  try {
    const data = await fetchFolderTree(url);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: downloader ───────────────────────────────────────────────────────────
ipcMain.on('start-download', (event, { url, outputDir, relPath, streamMode }) => {
  const cfg        = loadConfig();
  const proxy      = (cfg.proxy || '').trim();
  const maxThreads = Math.max(1, parseInt(cfg.downloadThreads,   10) || 4);
  const chunkSize  = streamMode
  ? Math.max(1, parseInt(cfg.streamingChunkSize, 10) || 100) * 1024 * 1024
  : Math.max(1, parseInt(cfg.downloadChunkSize,  10) || 2147483648);
  const streamMethod = cfg.streamMethod || 'http';
  const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };

  if (!getDataDir()) { send('dl:error', { message: 'No data folder configured. Go to Settings and set a Data Folder before downloading.' }); return; }
  if (!proxy)        { send('dl:error', { message: 'No proxy URL configured. Go to Settings → Workers proxy URL and enter your own Cloudflare Worker URL.' }); return; }

  startDownload(
    { url, outputDir, relPath, proxy, maxThreads, chunkSize, streamMode, streamMethod },
    {
      onLog:             msg  => send('dl:log',             msg),
      onProgress:        data => send('dl:progress',        data),
      onVpnState:        data => send('dl:vpnState',        data),
      onSpeed:           data => send('dl:speed',           data),
      onBatchStart:      data => send('dl:batchStart',      data),
      onFileComplete:    data => send('dl:fileComplete',    data),
      onDecryptProgress: data => send('dl:decryptProgress', data),
      onMediaInfo:       durationMs => send('dl:mediainfo', durationMs),
      onStreamUrl:       data       => send('dl:streamUrl', data),
      onSparsePreview:   data       => send('dl:sparsePreview', data),
      onDone:            data => send('dl:done',            data),
      onError:           err  => send('dl:error',           { message: err.message }),
    }
  );
});

ipcMain.on('abort-download', () => abortDownload());
ipcMain.on('skip-download',  () => skipCurrentDownload());

// ── IPC: download CSV ─────────────────────────────────────────────────────────
ipcMain.handle('write-csv', (_, row) => {
  const { fileName, fileSize, status, durationSec, timestamp, megaUrl, outputDir } = row;
  const csvPath = getDownloadCsv();
  const header  = 'filename,size_bytes,status,time_to_download_sec,timestamp,mega_link,output_dir\n';
  const csvLine = [
    `"${(fileName  || '').replace(/"/g, '""')}"`,
    fileSize, status, durationSec.toFixed(2),
    `"${timestamp}"`,
    `"${(megaUrl   || '').replace(/"/g, '""')}"`,
    `"${(outputDir || '').replace(/"/g, '""')}"`,
  ].join(',') + '\n';
  try {
    if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header, 'utf8');
    fs.appendFileSync(csvPath, csvLine, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update-csv-row', (_, { megaUrl, originalTimestamp, updates }) => {
  try {
    const csvPath = getDownloadCsv();
    if (!fs.existsSync(csvPath)) return { ok: false, error: 'File not found' };
    const raw   = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split('\n');
    let found   = false;
    const rebuilt = lines.map(line => {
      if (!line.trim()) return line;
      const cols = parseCSVLine(line.trim());
      if (cols[4] === originalTimestamp && cols[5] === megaUrl) {
        found = true;
        const fileName  = updates.fileName    !== undefined ? updates.fileName    : cols[0];
        const fileSize  = updates.fileSize    !== undefined ? updates.fileSize    : cols[1];
        const status    = updates.status      !== undefined ? updates.status      : cols[2];
        const duration  = updates.durationSec !== undefined ? Number(updates.durationSec).toFixed(2) : cols[3];
        const timestamp = updates.timestamp   !== undefined ? updates.timestamp   : cols[4];
        return [
          `"${(fileName || '').replace(/"/g, '""')}"`,
          fileSize, status, duration,
          `"${timestamp}"`,
          `"${(megaUrl  || '').replace(/"/g, '""')}"`,
        ].join(',');
      }
      return line;
    });
    if (!found) return { ok: false, error: 'Row not found' };
    fs.writeFileSync(csvPath, rebuilt.join('\n'), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-download-row', (_, { timestamp, megaUrl }) =>
deleteCsvRow(getDownloadCsv(), cols => cols[4] === timestamp && cols[5] === megaUrl));

// ── IPC: read data files ──────────────────────────────────────────────────────
ipcMain.handle('read-links-file', () => {
  try {
    if (!fs.existsSync(getFileCsv())) return [];
    const lines = fs.readFileSync(getFileCsv(), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map(line => {
      const cols = parseCSVLine(line);
      return { name: (cols[0]||'').trim(), size: (cols[1]||'').trim(), link: (cols[2]||'').trim(),
               folderLink: (cols[3]||'').trim(), email: (cols[4]||'').trim(),
               password: (cols[5]||'').trim(), folderName: (cols[7]||'').trim() };
    }).filter(r => r.name && r.link).reverse();
  } catch { return []; }
});

ipcMain.handle('read-import-file', () => {
  try {
    if (!fs.existsSync(getImportCsv())) return [];
    const lines = fs.readFileSync(getImportCsv(), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map(line => {
      const cols = parseCSVLine(line);
      return { name: (cols[0]||'').trim(), size: (cols[1]||'').trim(), link: (cols[2]||'').trim(),
        folderLink: (cols[3]||'').trim(), email: (cols[4]||'').trim(), password: (cols[5]||'').trim(),
                              importDate: (cols[6]||'').trim(), folderName: (cols[7]||'').trim() };
    }).filter(r => r.name && r.link).reverse();
  } catch { return []; }
});

ipcMain.handle('read-downloads-file', () => {
  try {
    if (!fs.existsSync(getDownloadCsv())) return [];
    const lines = fs.readFileSync(getDownloadCsv(), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map(line => {
      const cols = parseCSVLine(line);
      return { fileName: (cols[0]||'').trim(), sizeBytes: (cols[1]||'').trim(), status: (cols[2]||'').trim(),
               durationSec: (cols[3]||'').trim(), timestamp: (cols[4]||'').trim(),
               megaUrl: (cols[5]||'').trim(), outputDir: (cols[6]||'').trim() };
    }).filter(r => r.fileName).reverse();
  } catch { return []; }
});

ipcMain.handle('read-accounts-file', () => {
  try {
    if (!fs.existsSync(getAccountCsv())) return [];
    const days = refreshThresholdDays(loadConfig());
    const now = Date.now();
    return parseAccountRecords(fs.readFileSync(getAccountCsv(), 'utf8'))
      .map(account => accountForDisplay(account, days, now)).reverse();
  } catch { return []; }
});

ipcMain.handle('read-mediainfo', () => {
  try {
    if (!fs.existsSync(getMediainfoLog())) return [];
    return fs.readFileSync(getMediainfoLog(), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).reverse();
  } catch { return []; }
});

// ── IPC: Mediainfo Checker (Download tab) ───────────────────────────────────────
ipcMain.handle('grab-mediainfo', async (_, { url, name }) => {
  try {
    const mediainfo = await getMediaInfoFromUrl(url);
    const record = {
      fileName:  (name || url || '').trim(),
               fileLink:  url,
               checkedAt: new Date().toLocaleString(),
               mediainfo,
    };
    try {
      fs.appendFileSync(getMediainfoGrabbedLog(), JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
      console.error('[mediainfo-checker] Could not write to mediainfo_grabbed.ndjson:', e.message);
    }
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('read-mediainfo-grabbed', () => {
  try {
    if (!fs.existsSync(getMediainfoGrabbedLog())) return [];
    return fs.readFileSync(getMediainfoGrabbedLog(), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).reverse();
  } catch { return []; }
});

// ── IPC: Mediainfo (Imported Links tab) ──────────────────────────────────────
// Imported links are always standard MEGA file links (never folder links), so
// this skips the link-type detection the Download tab's checker needs and
// calls getMediaInfoFromUrl() directly. Records are upserted (keyed by
// fileLink) so both the first "Get Mediainfo" grab and a later retry write to
// the same line in mediainfo_import.ndjson — matching 1:1 against the
// corresponding row in import_log.csv.
ipcMain.handle('grab-import-mediainfo', async (_, { url, name }) => {
  try {
    const mediainfo = await getMediaInfoFromUrl(url);
    const record = {
      fileName:  (name || url || '').trim(),
               fileLink:  url,
               checkedAt: new Date().toLocaleString(),
               mediainfo,
    };
    try {
      const logPath  = getImportMediainfoLog();
      const existing = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
      : [];
      const rebuilt = existing.filter(l => {
        try { return JSON.parse(l).fileLink !== url; } catch { return true; }
      });
      rebuilt.push(JSON.stringify(record));
      fs.writeFileSync(logPath, rebuilt.join('\n') + '\n', 'utf8');
    } catch (e) {
      console.error('[import-mediainfo] Could not write to mediainfo_import.ndjson:', e.message);
    }
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('read-import-mediainfo', () => {
  try {
    if (!fs.existsSync(getImportMediainfoLog())) return [];
    return fs.readFileSync(getImportMediainfoLog(), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).reverse();
  } catch { return []; }
});

// ── IPC: delete rows ──────────────────────────────────────────────────────────
ipcMain.handle('delete-link-row', (_, { name, link }) =>
deleteCsvRow(getFileCsv(), cols => cols[0].trim() === name && cols[2].trim() === link));

ipcMain.handle('delete-import-row', (_, { name, link }) =>
deleteCsvRow(getImportCsv(), cols => cols[0].trim() === name && cols[2].trim() === link));

ipcMain.handle('delete-account-row', (_, { email }) =>
deleteCsvRow(getAccountCsv(), cols => cols[0].trim() === email));

// ── IPC: uploader file selection ──────────────────────────────────────────────
ipcMain.handle('select-files', async e => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openFile', 'multiSelections'], title: 'Select files to upload',
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('upload-select-folder', async e => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openDirectory'], title: 'Select folder to upload',
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('get-file-sizes', (_, paths) => {
  const result = {};
  for (const p of paths) { try { result[p] = fs.statSync(p).size; } catch { result[p] = 0; } }
  return result;
});

// ── IPC: OMDB ─────────────────────────────────────────────────────────────────
ipcMain.handle('omdb-search', async (_, { query, type }) => {
  const cfg    = loadConfig();
  const apiKey = (cfg.omdbApiKey || '').trim();
  if (!apiKey) throw new Error('OMDB API key not configured. Go to Settings → Integrations.');
  const typeParam = type ? `&type=${type}` : '';
  return (await net.fetch(`https://www.omdbapi.com/?apikey=${apiKey}&r=JSON&s=${encodeURIComponent(query)}${typeParam}`)).json();
});

ipcMain.handle('omdb-get', async (_, { imdbId }) => {
  const cfg    = loadConfig();
  const apiKey = (cfg.omdbApiKey || '').trim();
  if (!apiKey) throw new Error('OMDB API key not configured. Go to Settings → Integrations.');
  return (await net.fetch(`https://www.omdbapi.com/?apikey=${apiKey}&i=${encodeURIComponent(imdbId)}&plot=full&r=json`)).json();
});

// ── IPC: upload engine controls ───────────────────────────────────────────────
ipcMain.on('cancel-current-file', () => cancelCurrentFile());
ipcMain.on('kill-queue',          () => killQueue());
ipcMain.on('skip-pending-file',   (_, { file }) => skipFile(file));
ipcMain.on('reorder-queue',       (_, { order }) => reorderQueue(order));

ipcMain.on('start-upload', (_, args) => {
  startUpload(args, makeSend());
});

ipcMain.handle('rfork-settings-info', () => ({ version: readRforkManifest(app.isPackaged ? process.resourcesPath : __dirname).version, checkpointRoot: path.join(app.getPath('userData'), 'rfork-checkpoints') }));
ipcMain.handle('rfork-checkpoint-location', async () => {
  if (network.hasTask('upload')) throw new Error('Stop uploads before choosing checkpoint storage.');
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a private local checkpoint location', properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  return validateCheckpointRoot(path.join(result.filePaths[0], 'm3-rfork-checkpoints'));
});
ipcMain.handle('rfork-recovery-list', () => getDataDir() ? createUploadJournal(getDataDir()).read().map(entry => ({
  id: entry.id, account: entry.account, destination: entry.destination, source: entry.source,
  bytes: entry.bytes, state: entry.state, resumable: Boolean(entry.checkpoint), checkpoint: entry.checkpoint || '',
})) : []);
ipcMain.handle('rfork-recovery-resume', async (_, args) => {
  if (!args || typeof args.id !== 'string' || (args.password !== undefined && typeof args.password !== 'string')) return { ok: false, error: 'Choose a retained transfer.' };
  return require('./src/upload-engine').resumeSavedUpload(args, makeSend());
});
ipcMain.handle('rfork-recovery-discard', async (event, id) => {
  if (network.hasTask('upload') || reviewingUploadRecovery) return { ok: false, error: 'Wait for upload/recovery to stop.' };
  reviewingUploadRecovery = true;
  try {
    const journal = createUploadJournal(getDataDir());
    const record = journal.read().find(entry => entry.id === id);
    if (!record) return { ok: false, error: 'Transfer changed; refresh recovery.' };
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: 'warning', title: 'Inspect destination before discarding recovery',
      message: 'This upload may already exist on MEGA.',
      detail: `Account: ${record.account}\nDestination: /${record.destination}\nSource: ${record.source}\n\nKeep this hold if the outcome is unknown. If keeping the remote file, remove the source from the pending queue. Only allow a fresh upload after verifying the remote destination is absent or removing that remote copy. Private checkpoint files will be retained.`,
      buttons: ['Keep recovery hold', 'I inspected the destination — discard hold'], defaultId: 0, cancelId: 0,
    });
    if (result.response !== 1) return { ok: false, error: 'Recovery hold retained.' };
    if (network.hasTask('upload') || JSON.stringify(journal.read().find(entry => entry.id === id)) !== JSON.stringify(record)) return { ok: false, error: 'Transfer changed; inspect again.' };
    journal.clear(id); return { ok: true };
  } finally { reviewingUploadRecovery = false; }
});

let reviewingUploadRecovery = false;
ipcMain.handle('review-upload-recovery', async event => {
  if (reviewingUploadRecovery) return { ok: false, error: 'An upload review is already open.' };
  reviewingUploadRecovery = true;
  try {
    return await reviewUploadRecovery({ directory: getDataDir, busy: () => network.hasTask('upload'),
      confirm: async detail => {
        const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning', title: 'Inspect interrupted uploads',
          message: 'An earlier upload may already be saved on MEGA.',
          detail: detail + '\n\nMake sure the earlier M3/rfork processes have stopped. Before retrying a listed file, verify that its remote destination is absent or remove the remote copy. If keeping a completed remote file, remove its local file from this upload queue. Allow uploads only after checking these destinations.',
          buttons: ['Keep uploads paused', 'I inspected the files — allow uploads'], defaultId: 0, cancelId: 0,
        });
        return result.response === 1;
      },
    });
  } catch (error) { return { ok: false, error: error.message }; }
  finally { reviewingUploadRecovery = false; }
});

ipcMain.handle('add-to-upload-queue', (_, { paths }) => addFilesToQueue(paths));

// ── IPC: bulk import engine controls ──────────────────────────────────────────
ipcMain.on('start-bulk-import',        (_, args) => startBulkImport(args, makeSend()));
ipcMain.on('kill-bulk-import-queue',   () => killBulkImportQueue());
ipcMain.on('skip-bulk-import-item',    (_, { item }) => skipBulkImportItem(item));

// ── IPC: browser upload ───────────────────────────────────────────────────────
ipcMain.handle('open-mega-browser', async (_, { email, password }) => {
  await openMegaBrowser(email || '', password || '', makeSend());
  return true;
});

ipcMain.handle('close-mega-browser', async () => {
  await closeMegaBrowser();
  return true;
});

// ── IPC: account management ───────────────────────────────────────────────────
ipcMain.on('refresh-accounts',      (_, { mode })             => refreshAccounts(mode, makeSend()));
ipcMain.on('refresh-single-account',(_, { email, password })  => refreshSingleAccount(email, password, makeSend()));
ipcMain.on('cancel-account-refresh', () => cancelRefreshAccounts());
ipcMain.on('cancel-single-account-refresh', (_, { email }) => cancelSingleAccountRefresh(email));
ipcMain.on('upgrade-all-insecure',  ()                        => upgradeAllInsecure(makeSend()));
ipcMain.handle('check-accounts-health', () => checkAccountsHealth());

// ── IPC: View & Import ────────────────────────────────────────────────────────

ipcMain.handle('browse-account-files',   async (_event, args) => browseAccountFiles(args));
ipcMain.handle('get-account-file-links', async (_event, args) => getAccountFileLinks(args));
ipcMain.handle('check-import-quota',     async (_event, args) => checkImportQuota(args));
ipcMain.handle('import-mega-link',       async (_event, args) => doImportMegaLink(args));

// ── IPC: Generate folder link ─────────────────────────────────────────────────
// Logs into the account that owns the file, runs mega-exec find to locate the
// file's parent folder, exports that folder to get a shareable link, then writes
// the link back into upload_log.csv and marks Security Upgrade → Yes in
// account_log.csv (only when it was previously 'No').
ipcMain.handle('generate-folder-link', network.wrap('folder-link', async (_, { name, link, email, password }) => {
  try {
    await megaSwitch(email, password);

    let folderPath;
    try {
      folderPath = await findFileInCloud(name);
    } catch (findErr) {
      try { await megaLogout(); } catch { /* ignore */ }
      return { ok: false, error: `Could not find file in cloud drive: ${findErr.message}` };
    }

    const folderLink = await getMegacmdFolderLink(folderPath);
    try { await megaLogout(); } catch { /* ignore */ }

    if (!folderLink) {
      return { ok: false, error: 'MEGAcmd did not return a folder link' };
    }

    // Update upload_log.csv — write the folder link into column index 3
    const fileCsvPath = getFileCsv();
    if (fs.existsSync(fileCsvPath)) {
      const lines   = fs.readFileSync(fileCsvPath, 'utf8').split('\n');
      const rebuilt = lines.map((line, idx) => {
        if (idx === 0 || !line.trim()) return line;
        const cols = parseCSVLine(line.trim());
        if ((cols[0] || '').trim() === name && (cols[2] || '').trim() === link) {
          const newCols = [...cols];
          while (newCols.length < 8) newCols.push('');
          newCols[3] = folderLink;
          return newCols.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',');
        }
        return line;
      });
      fs.writeFileSync(fileCsvPath, rebuilt.join('\n'), 'utf8');
    }

    // Update account_log.csv — flip Security Upgrade from 'No' → 'Yes' only
    const accountCsvPath = getAccountCsv();
    if (fs.existsSync(accountCsvPath)) {
      const lines   = fs.readFileSync(accountCsvPath, 'utf8').split('\n');
      const rebuilt = lines.map((line, idx) => {
        if (idx === 0 || !line.trim()) return line;
        const cols = parseCSVLine(line.trim());
        if ((cols[0] || '').trim() === email &&
          (cols[6] || '').trim().toLowerCase() === 'no') {
          const newCols = [...cols];
        while (newCols.length < 7) newCols.push('');
        newCols[6] = 'Yes';
          return newCols.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',');
          }
          return line;
      });
      fs.writeFileSync(accountCsvPath, rebuilt.join('\n'), 'utf8');
    }

    return { ok: true, folderLink };
  } catch (e) {
    try { await megaLogout(); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}, error => ({ ok: false, error: error.message })));

// ── IPC: Generate folder link (Imported Links tab) ───────────────────────────
// Identical to generate-folder-link above, but writes into import_log.csv's
// Folder Link column (index 3) instead of upload_log.csv's.
ipcMain.handle('generate-import-folder-link', network.wrap('folder-link', async (_, { name, link, email, password }) => {
  try {
    await megaSwitch(email, password);

    let folderPath;
    try {
      folderPath = await findFileInCloud(name);
    } catch (findErr) {
      try { await megaLogout(); } catch { /* ignore */ }
      return { ok: false, error: `Could not find file in cloud drive: ${findErr.message}` };
    }

    const folderLink = await getMegacmdFolderLink(folderPath);
    try { await megaLogout(); } catch { /* ignore */ }

    if (!folderLink) {
      return { ok: false, error: 'MEGAcmd did not return a folder link' };
    }

    // Update import_log.csv — write the folder link into column index 3
    const importCsvPath = getImportCsv();
    if (fs.existsSync(importCsvPath)) {
      const lines   = fs.readFileSync(importCsvPath, 'utf8').split('\n');
      const rebuilt = lines.map((line, idx) => {
        if (idx === 0 || !line.trim()) return line;
        const cols = parseCSVLine(line.trim());
        if ((cols[0] || '').trim() === name && (cols[2] || '').trim() === link) {
          const newCols = [...cols];
          while (newCols.length < 8) newCols.push('');
          newCols[3] = folderLink;
          return newCols.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',');
        }
        return line;
      });
      fs.writeFileSync(importCsvPath, rebuilt.join('\n'), 'utf8');
    }

    // Update account_log.csv — flip Security Upgrade from 'No' → 'Yes' only
    const accountCsvPath = getAccountCsv();
    if (fs.existsSync(accountCsvPath)) {
      const lines   = fs.readFileSync(accountCsvPath, 'utf8').split('\n');
      const rebuilt = lines.map((line, idx) => {
        if (idx === 0 || !line.trim()) return line;
        const cols = parseCSVLine(line.trim());
        if ((cols[0] || '').trim() === email &&
          (cols[6] || '').trim().toLowerCase() === 'no') {
          const newCols = [...cols];
        while (newCols.length < 7) newCols.push('');
        newCols[6] = 'Yes';
          return newCols.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(',');
          }
          return line;
      });
      fs.writeFileSync(accountCsvPath, rebuilt.join('\n'), 'utf8');
    }

    return { ok: true, folderLink };
  } catch (e) {
    try { await megaLogout(); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}, error => ({ ok: false, error: error.message })));
