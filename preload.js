'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── Config ──────────────────────────────────────────────────────────────────
  loadConfig: ()     => ipcRenderer.invoke('load-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  rforkSettingsInfo: () => ipcRenderer.invoke('rfork-settings-info'),
  chooseRforkCheckpointRoot: () => ipcRenderer.invoke('rfork-checkpoint-location'),
  listRforkRecovery: () => ipcRenderer.invoke('rfork-recovery-list'),
  resumeRforkUpload: args => ipcRenderer.invoke('rfork-recovery-resume', args),
  discardRforkRecovery: id => ipcRenderer.invoke('rfork-recovery-discard', id),
  reviewUploadRecovery: () => ipcRenderer.invoke('review-upload-recovery'),

  mailState: () => ipcRenderer.invoke('mail-state'),
  mailSave: connection => ipcRenderer.invoke('mail-save', connection),
  mailTest: input => ipcRenderer.invoke('mail-test', input),
  mailSync: input => ipcRenderer.invoke('mail-sync', input),
  mailDomains: input => ipcRenderer.invoke('mail-domains', input),
  mailAddDomains: input => ipcRenderer.invoke('mail-add-domains', input),
  mailDomainAction: input => ipcRenderer.invoke('mail-domain-action', input),
  mailDisconnect: id => ipcRenderer.invoke('mail-disconnect', id),
  mailList: query => ipcRenderer.invoke('mail-list', query),
  mailRead: id => ipcRenderer.invoke('mail-read', id),
  mailExportSetup: () => ipcRenderer.invoke('mail-export-setup'),

  // Proton VPN (Linux)
  vpnGetState: () => ipcRenderer.invoke('vpn-get-state'),
  shutdownState: () => ipcRenderer.invoke('app-shutdown-state'),
  retryQuit: () => ipcRenderer.send('app-retry-quit'),
  vpnTerminalRead: after => ipcRenderer.invoke('vpn-terminal-read', after),
  vpnTerminalCopy: () => ipcRenderer.invoke('vpn-terminal-copy'),
  vpnTerminalSave: () => ipcRenderer.invoke('vpn-terminal-save'),
  vpnDiagnose: () => ipcRenderer.invoke('vpn-diagnose'),
  vpnSaveSettings: settings => ipcRenderer.invoke('vpn-save-settings', settings),
  vpnCommand: command => ipcRenderer.invoke('vpn-command', command),
  vpnCancelCommand: id => ipcRenderer.invoke('vpn-cancel-command', id),
  vpnRetry: () => ipcRenderer.invoke('vpn-retry'),
  vpnChangePool: selection => ipcRenderer.invoke('vpn-change-pool', selection),
  vpnEditPool: action => ipcRenderer.invoke('vpn-edit-pool', action),
  vpnCatalog: () => ipcRenderer.invoke('vpn-catalog'),
  vpnCatalogSearch: query => ipcRenderer.invoke('vpn-catalog-search', query),
  vpnPoolPreview: selection => ipcRenderer.invoke('vpn-pool-preview', selection),
  vpnCatalogAction: action => ipcRenderer.invoke('vpn-catalog-action', action),

  // ── Dialogs & File System (Shared) ──────────────────────────────────────────
  selectFolder:       ()           => ipcRenderer.invoke('select-folder'),
  selectTxt:          ()           => ipcRenderer.invoke('select-txt'),
  openFolder:         (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openFile:           (filePath)   => ipcRenderer.invoke('open-file',   filePath),
  readLinksFile:      ()           => ipcRenderer.invoke('read-links-file'),
  readAccountsFile:   ()           => ipcRenderer.invoke('read-accounts-file'),
  readMediaInfo:      ()           => ipcRenderer.invoke('read-mediainfo'),
  readDownloadsFile:  ()           => ipcRenderer.invoke('read-downloads-file'),
  readImportFile:     ()           => ipcRenderer.invoke('read-import-file'),
  grabImportMediainfo: (args)      => ipcRenderer.invoke('grab-import-mediainfo', args),
  readImportMediainfo: ()          => ipcRenderer.invoke('read-import-mediainfo'),

  // ── Downloader ──────────────────────────────────────────────────────────────
  startDownload:         (args) => ipcRenderer.send('start-download', args),
  skipCurrentDownload:   ()     => ipcRenderer.send('skip-download'),
  writeCsv:              (row)  => ipcRenderer.invoke('write-csv', row),
  updateCsvRow:       (args) => ipcRenderer.invoke('update-csv-row', args),
  deleteDownloadRow:  (args) => ipcRenderer.invoke('delete-download-row', args),
  browseMegaFolder: (url) => ipcRenderer.invoke('browse-mega-folder', url),
  grabMediainfo:        (args) => ipcRenderer.invoke('grab-mediainfo', args),
  readMediainfoGrabbed: ()     => ipcRenderer.invoke('read-mediainfo-grabbed'),

  // ── Uploader ────────────────────────────────────────────────────────────────
  selectFiles:          ()      => ipcRenderer.invoke('select-files'),
  getFileSizes:         (paths) => ipcRenderer.invoke('get-file-sizes', paths),
  uploadSelectFolder:   ()      => ipcRenderer.invoke('upload-select-folder'),
  startUpload:          (args)  => ipcRenderer.send('start-upload', args),
  cancelCurrentFile:    ()      => ipcRenderer.send('cancel-current-file'),
  abortDownload:        ()      => ipcRenderer.send('abort-download'),
  skipPendingFile:      (file)  => ipcRenderer.send('skip-pending-file', { file }),
  reorderQueue:         (order) => ipcRenderer.send('reorder-queue', { order }),
  addToUploadQueue:     (paths) => ipcRenderer.invoke('add-to-upload-queue', { paths }),
  killQueue:            ()      => ipcRenderer.send('kill-queue'),
  openMegaBrowser:      (args)  => ipcRenderer.invoke('open-mega-browser',  args),
  closeMegaBrowser:     ()      => ipcRenderer.invoke('close-mega-browser'),
  deleteLinkRow:        (args)  => ipcRenderer.invoke('delete-link-row', args),
  deleteImportRow:      (args)  => ipcRenderer.invoke('delete-import-row', args),
  generateFolderLink:   (args)  => ipcRenderer.invoke('generate-folder-link', args),

  // Resolves a File object (e.g. from drag-and-drop) to its absolute path.
  // Uses webUtils.getPathForFile which works correctly under contextIsolation.
  getPathForFile: (file) => {
    try {
      return webUtils ? webUtils.getPathForFile(file) : (file.path || '');
    } catch {
      return file.path || '';
    }
  },

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ── OMDB ────────────────────────────────────────────────────────────────────
  omdbSearch: (query, type) => ipcRenderer.invoke('omdb-search', { query, type }),
  omdbGet:    (imdbId)      => ipcRenderer.invoke('omdb-get',    { imdbId }),

  // ── View & Import ─────────────────────────────────────────────────────────────
  browseAccountFiles:  (args) => ipcRenderer.invoke('browse-account-files',  args),
  getAccountFileLinks: (args) => ipcRenderer.invoke('get-account-file-links', args),
  importMegaLink:      (args) => ipcRenderer.invoke('import-mega-link',      args),
  checkImportQuota:    (args) => ipcRenderer.invoke('check-import-quota',    args),
  generateImportFolderLink: (args) => ipcRenderer.invoke('generate-import-folder-link', args),

  // ── Bulk Import ──────────────────────────────────────────────────────────────
  startBulkImport:      (args) => ipcRenderer.send('start-bulk-import', args),
  killBulkImportQueue:  ()     => ipcRenderer.send('kill-bulk-import-queue'),
  skipBulkImportItem:   (item) => ipcRenderer.send('skip-bulk-import-item', { item }),

  // ── Account Refresh ──────────────────────────────────────────────────────────
  refreshAccounts:        (mode)             => ipcRenderer.send('refresh-accounts', { mode }),
  cancelAccountRefresh:  ()                 => ipcRenderer.send('cancel-account-refresh'),
  cancelSingleAccountRefresh: (email)       => ipcRenderer.send('cancel-single-account-refresh', { email }),
  refreshSingleAccount:   (email, password)  => ipcRenderer.send('refresh-single-account', { email, password }),
  checkAccountsHealth:    ()                 => ipcRenderer.invoke('check-accounts-health'),
  upgradeAllInsecure:     ()                 => ipcRenderer.send('upgrade-all-insecure'),
  deleteAccountRow:       (args)             => ipcRenderer.invoke('delete-account-row', args),

  // ── Event listener (renderer receives messages from main) ───────────────────
  on: (channel, callback) => {
    // Using the secure allowlist approach to prevent arbitrary IPC channel execution
    const allowed = [
      // Downloader channels
      'dl:log', 'dl:progress', 'dl:batchStart', 'dl:fileComplete',
      'dl:decryptProgress', 'dl:done', 'dl:error', 'dl:mediainfo', 'dl:streamUrl',
      'dl:vpnState', 'dl:speed', 'dl:sparsePreview',
      // Uploader channels
      'up:log', 'up:status', 'up:progress', 'up:vpnState', 'up:account', 'up:link', 'up:fileError', 'up:complete', 'up:fileSkipped', 'up:folderLink', 'up:group',
      'up:archiveProgress', 'up:archiveDone',
      // Browser-upload channels
      'up:browserReady', 'up:browserClosed',
      // Account refresh channels
      'up:refreshLog', 'up:refreshProgress', 'up:refreshDone', 'up:refreshSingleDone', 'up:upgradeAllDone',
      // Bulk Import channels
      'bi:log', 'bi:status', 'bi:account', 'bi:folderLink', 'bi:link',
      'bi:itemError', 'bi:itemSkipped', 'bi:complete',
      'app:updateAvailable', 'app:shutdown', 'vpn:state', 'vpn:terminal-changed',
    ];

    if (allowed.includes(channel)) {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    } else {
      console.warn(`IPC channel "${channel}" is not allowed.`);
    }
  },
});
