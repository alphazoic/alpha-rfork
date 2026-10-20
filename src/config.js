'use strict';

const { app } = require('electron');
const path    = require('path');
const fs      = require('fs');

// ── Config file location ──────────────────────────────────────────────────────
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'mega-dl-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); }
  catch { return {}; }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(data, null, 2), 'utf8');
}

// ── Data-dir path helpers ─────────────────────────────────────────────────────
// All user data files live under the folder the user picks in Settings.
// getDataDir() always reads fresh from the on-disk config, so a save → reuse
// in the same session picks up the new path without requiring a restart.
function getDataDir() { return (loadConfig().dataDir || '').trim(); }

const DATA_FILES = {
  fileCsv:             'upload_log.csv',
  accountCsv:          'account_log.csv',
  mediainfoLog:        'mediainfo_log.ndjson',
  mediainfoGrabbedLog: 'mediainfo_grabbed.ndjson',
  downloadCsv:         'download_log.csv',
  importCsv:           'import_log.csv',
  importMediainfoLog:  'mediainfo_import.ndjson',
};

function getDataFile(key) { return path.join(getDataDir(), DATA_FILES[key]); }

const getFileCsv             = () => getDataFile('fileCsv');
const getAccountCsv          = () => getDataFile('accountCsv');
const getMediainfoLog        = () => getDataFile('mediainfoLog');
const getMediainfoGrabbedLog = () => getDataFile('mediainfoGrabbedLog');
const getDownloadCsv         = () => getDataFile('downloadCsv');
const getImportCsv           = () => getDataFile('importCsv');
const getImportMediainfoLog  = () => getDataFile('importMediainfoLog');

module.exports = {
  loadConfig, saveConfig,
  getDataDir, getDataFile,
  getFileCsv, getAccountCsv, getMediainfoLog, getMediainfoGrabbedLog, getDownloadCsv, getImportCsv, getImportMediainfoLog,
};
