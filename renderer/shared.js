'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════
const queue     = [];   // [{ id, url, outDir, relPath, status, displayName, fileSize, pct, speed, fullPath, folderPath, errorMsg }]
let   nextId    = 0;
let   running   = false;
let   currentUrl = '';
let   currentOutDir = '';
let   dlLqDragSrcId = null;
let   dataDirPath   = '';   // mirrors cfg.dataDir — updated on init and on save
// View & Import IIFE interface — populated by the viewImport IIFE on init.
// Declared here (outer scope) so both the upload IIFE and the viewImport IIFE
// can read/write it after all IIFEs have executed.
let _viewImport = null;

// Mediainfo Checker IIFE interfaces — same pattern as _viewImport above, so
// the single-select folder-browser modal can hand a chosen file back to the
// main checker bar without the two IIFEs needing a shared closure.
let _micRunCheck          = null; // (url, name) => Promise — runs a check and renders the result
let _micOpenFolderBrowser = null; // (url) => void — opens the modal pre-filled & auto-fetched

// Keyed by megaUrl — tracks retried downloads so dl:done/dl:error can update
// the existing CSV row instead of appending a new one.
// Value: { csvPath, originalTimestamp }
const pendingRetries = new Map();

// Progress tracking
const P = {
  fileName: '', fileSize: 0, receivedBytes: 0,
  chunk: 0, totalChunks: 0,
  startTime: 0,
  // sliding window for speed
  windowBytes: 0, windowTime: 0,
  speed: 0,           // bytes/sec EMA
  peakSpeed: 0,       // highest EMA sample across the whole queue run
  minSpeed: Infinity, // lowest non-zero EMA sample (warmup-excluded)
  warmupEndTime: 0,   // minSpeed is not updated until this timestamp passes
  // batch (per URL item — reset by onBatchStart)
  totalFiles: 0, totalBytes: 0,
  completedFiles: 0, completedBytes: 0, failedFiles: 0, unknownSizeFiles: 0,
  // queue-level accumulators (reset when a new queue run starts in startElapsedTimer)
  queueCompletedBytes: 0,
  queueCompletedFiles: 0,
  fileDurations: [],  // ms per completed non-skipped file
  fileSizes: [],      // bytes per completed non-skipped file
};
let elapsedTimer    = null;
let queueStartTime  = 0;   // wall-clock time when the current queue run started

// ═══════════════════════════════════════════════════════════════════════════════
// DOM refs
// ═══════════════════════════════════════════════════════════════════════════════
const outDirInput  = document.getElementById('outDirInput');
const bulkTextarea = document.getElementById('bulkTextarea');
const loadTxtBtn   = document.getElementById('loadTxtBtn');
const addBulkBtn   = document.getElementById('addBulkBtn');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const queueList    = document.getElementById('queueList');
const queueEmpty   = document.getElementById('queueEmpty');
const queueCount   = document.getElementById('queueCount');
const browseDirBtn  = document.getElementById('browseDirBtn');
const clearDoneBtn  = document.getElementById('clearDoneBtn');
const statusPill   = document.getElementById('statusPill');
const statusText   = document.getElementById('statusText');
const logEl        = document.getElementById('log');
const logScroller  = document.querySelector('.log-scroller');
const clearLogBtn  = document.getElementById('clearLogBtn');
const openOutBtn   = document.getElementById('openOutBtn');
const dlLqList     = document.getElementById('dlLqList');
const dlLqEmpty    = document.getElementById('dlLqEmpty');

const progCard     = document.getElementById('progCard');
const progFilename = document.getElementById('progFilename');
const progSize     = document.getElementById('progSize');
const progIdx      = document.getElementById('progIdx');
const progFill     = document.getElementById('progFill');
const progPct      = document.getElementById('progPct');
const chunkRow     = document.getElementById('chunkRow');
const statSpeed    = document.getElementById('statSpeed');
const statEta      = document.getElementById('statEta');
const statElapsed  = document.getElementById('statElapsed');
const statChunkLbl    = document.getElementById('statChunkLbl');
const statChunk       = document.getElementById('statChunk');
const statDecryptWrap = document.getElementById('statDecryptWrap');
const statDecrypt     = document.getElementById('statDecrypt');
const batchBar     = document.getElementById('batchBar');
const batchText    = document.getElementById('batchText');
const batchFill    = document.getElementById('batchFill');
const batchBytes   = document.getElementById('batchBytes');

// ═══════════════════════════════════════════════════════════════════════════════
// Icon variables
// ═══════════════════════════════════════════════════════════════════════════════

const refreshIcon = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin: 0 2px;">
<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
<path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
</svg>
`;

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════════
function fmtBytes(b) {
  if (b === undefined || b === null) return '—';
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  if (b < 1099511627776) return (b / 1073741824).toFixed(2) + ' GB';
  return (b / 1099511627776).toFixed(2) + ' TB';
}
function fmtQueueBytes(uploaded, total) {
  const units = [' B', ' KB', ' MB', ' GB', ' TB'];
  let ui = 0, t = total;
  while (t >= 1024 && ui < units.length - 1) { t /= 1024; ui++; }
  const div = Math.pow(1024, ui);
  return '[' + (uploaded / div).toFixed(1) + '/' + (total / div).toFixed(1) + units[ui] + ']';
}
function fmtSpeed(bps) {
  if (!bps || bps < 0) return '— B/s';
  return fmtBytes(bps) + '/s';
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtEta(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec > 86400) return '>1 day';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Status
// ═══════════════════════════════════════════════════════════════════════════════
statusPill.addEventListener('click', () => {
  document.querySelector('.tab[data-tab="download"]')?.click();
  document.getElementById('dl-tabProgress')?.click();
});

function setStatus(state, txt, detail = '') {
  statusPill.className = 'status-pill ' + state;
  statusText.textContent = txt;
  statusPill.title = detail;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Log
// ═══════════════════════════════════════════════════════════════════════════════
function lineClass(raw) {
  const s = raw.replace(/\x1b\[[0-9;]*m/g,'').trimStart();
  if (s.startsWith('ERROR'))    return 'll-error';
  if (s.startsWith('NOTICE'))   return 'll-notice';
  if (s.startsWith('DONE'))     return 'll-done';
  if (s.startsWith('DECRYPT'))  return 'll-decrypt';
  if (s.startsWith('DOWNLOAD')) return 'll-download';
  if (s.startsWith('CHUNKS'))   return 'll-chunks';
  return '';
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g,''); }

function appendLog(raw, cls) {
  const clean = stripAnsi(raw);
  if (!clean.trim()) return;
  // Remove placeholder if present
  const placeholder = logEl.querySelector('.log-empty');
  if (placeholder) placeholder.remove();
  const el = document.createElement('span');
  el.className = 'll ' + (cls || lineClass(raw));
  el.textContent = clean;
  logEl.appendChild(el);
  logScroller.scrollTop = logScroller.scrollHeight;
}
function sysLog(msg) { appendLog('› ' + msg, 'll-sys'); }

// ── Toast notification ─────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, durationMs = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), durationMs);
}

// Flash the output-folder input to draw the user's eye to it
function flashOutputFolder() {
  outDirInput.classList.remove('field-error');          // reset in case already applied
  void outDirInput.offsetWidth;                         // force reflow so animation restarts
  outDirInput.classList.add('field-error');
  setTimeout(() => outDirInput.classList.remove('field-error'), 2600);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Account banner (global header widget — shared chrome, not Upload-tab-specific)
// ═══════════════════════════════════════════════════════════════════════════════
// Moved here from renderer/upload.js (Task E) so renderer/bulk-import.js's
// bi:account listener can call the same global function without duplicating it.
function updateAccountBanner(email, password, usageKb) {
  const widget  = document.getElementById('hdrAccountWidget');
  const emailEl = document.getElementById('hdrAccEmail');
  const passEl  = document.getElementById('hdrAccPass');
  const usageEl = document.getElementById('hdrAccUsedGb');
  const barFill = document.getElementById('hdrAccBarFill');

  const MAX_KB = 20 * 1024 * 1024;
  const usedGb = ((usageKb || 0) / 1024 / 1024).toFixed(2);
  const pct    = Math.min(100, ((usageKb || 0) / MAX_KB) * 100).toFixed(1);

  emailEl.textContent = email || '—';
  passEl.textContent  = password || '—';
  usageEl.textContent = usedGb;
  usageEl.dataset.usageKb = (usageKb || 0).toString();
  barFill.style.width = pct + '%';
  barFill.className   = 'hdr-acc-bar-fill' +
  (parseFloat(pct) >= 90 ? ' full' : parseFloat(pct) >= 65 ? ' high' : '');

  emailEl.onclick = () => {
    navigator.clipboard.writeText(email).catch(() => {});
    emailEl.textContent = '✓ Copied'; emailEl.classList.add('copied');
    setTimeout(() => { emailEl.textContent = email; emailEl.classList.remove('copied'); }, 1400);
  };
  passEl.onclick = () => {
    navigator.clipboard.writeText(password).catch(() => {});
    passEl.textContent = '✓ Copied'; passEl.classList.add('copied');
    setTimeout(() => { passEl.textContent = password; passEl.classList.remove('copied'); }, 1400);
  };

  widget.classList.add('visible');
}

// ── Scroll-anchor utility ─────────────────────────────────────────────────────
// Calls renderFn(), then nudges the nearest scrollable ancestor so that
// anchorEl sits at exactly the same viewport position it had before the render.
// Prevents the pagination bar from drifting when list heights change between pages.
function preserveScrollAnchor(anchorEl, renderFn) {
  const topBefore = anchorEl.getBoundingClientRect().top;
  renderFn();
  const delta = anchorEl.getBoundingClientRect().top - topBefore;
  if (delta === 0) return;
  let node = anchorEl.parentElement;
  while (node && node !== document.documentElement) {
    const { overflow, overflowY } = getComputedStyle(node);
    if (/auto|scroll/.test(overflow) || /auto|scroll/.test(overflowY)) {
      node.scrollTop += delta;
      return;
    }
    node = node.parentElement;
  }
  document.documentElement.scrollTop += delta;
}
