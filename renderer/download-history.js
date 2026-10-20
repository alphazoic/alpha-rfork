'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Download — sub-tab switching (Progress | Downloaded Files)
// ═══════════════════════════════════════════════════════════════════════════════
function dlShowSubtab(active) {
  document.getElementById('dl-tabProgress').classList.toggle('active', active === 'progress');
  document.getElementById('dl-tabHistory').classList.toggle('active',  active === 'history');
  document.getElementById('dl-tabMediaInfoChecker').classList.toggle('active', active === 'mediacheck');
  document.getElementById('dl-dashPanel').style.display      = active === 'progress' ? 'flex' : 'none';
  document.getElementById('dl-historyPanel').style.display   = active === 'history'  ? '' : 'none';
  document.getElementById('dl-mediaInfoCheckerPanel').style.display = active === 'mediacheck' ? 'flex' : 'none';
  document.getElementById('dl-openDownloadCsv').style.display = active === 'history' ? '' : 'none';
  document.getElementById('mic-historyBtn').style.display     = active === 'mediacheck' ? '' : 'none';
}

document.getElementById('dl-tabProgress').addEventListener('click', () => dlShowSubtab('progress'));
document.getElementById('dl-tabMediaInfoChecker').addEventListener('click', () => dlShowSubtab('mediacheck'));

// ── Downloaded Files pagination state ─────────────────────────────────────────
let _dlHistoryAll    = [];   // full download history entries from the most recent fetch
let dlHistoryPage    = 1;    // 1-based current page number
let dlHistoryPerPage = 25;   // rows per page — overwritten from saved settings in init()

// Renders only the slice of _dlHistoryAll that belongs to the current
// dlHistoryPage (sized by dlHistoryPerPage) into #dl-historyList.
function renderDlHistoryPage() {
  const listEl = document.getElementById('dl-historyList');
  if (!listEl) return;
  listEl.style.minHeight = listEl.offsetHeight + 'px';
  listEl.innerHTML = '';
  const start       = (dlHistoryPage - 1) * dlHistoryPerPage;
  const pageEntries = _dlHistoryAll.slice(start, start + dlHistoryPerPage);
  pageEntries.forEach(e => listEl.appendChild(buildDownloadHistItem(e)));
  renderDlHistoryPagination();
  listEl.style.minHeight = '';
}

// Updates the pager text and prev/next disabled state against the full
// history list, and hides itself entirely when there's only one page.
function renderDlHistoryPagination() {
  const pagination = document.getElementById('dl-historyPagination');
  const pageInfo    = document.getElementById('dl-historyPageInfo');
  const prevBtn     = document.getElementById('dl-historyPrevBtn');
  const nextBtn     = document.getElementById('dl-historyNextBtn');
  if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;
  if (_dlHistoryAll.length === 0) {
    pagination.style.display = 'none';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(_dlHistoryAll.length / dlHistoryPerPage));
  pagination.style.display = totalPages > 1 ? 'flex' : 'none';
  pageInfo.textContent      = `Page ${dlHistoryPage} of ${totalPages}`;
  prevBtn.disabled          = dlHistoryPage <= 1;
  nextBtn.disabled          = dlHistoryPage >= totalPages;
}

document.getElementById('dl-historyPrevBtn')?.addEventListener('click', () => {
  if (dlHistoryPage <= 1) return;
  dlHistoryPage--;
  preserveScrollAnchor(document.getElementById('dl-historyPagination'), renderDlHistoryPage);
});
document.getElementById('dl-historyNextBtn')?.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(_dlHistoryAll.length / dlHistoryPerPage));
  if (dlHistoryPage >= totalPages) return;
  dlHistoryPage++;
  preserveScrollAnchor(document.getElementById('dl-historyPagination'), renderDlHistoryPage);
});

document.getElementById('dl-tabHistory').addEventListener('click', async () => {
  dlShowSubtab('history');
  const listEl  = document.getElementById('dl-historyList');
  const emptyEl = document.getElementById('dl-historyEmpty');
  dlHistoryPage = 1;
  listEl.innerHTML = '';
  emptyEl.style.display = '';
  emptyEl.textContent = 'Loading download history…';
  try {
    const entries = await window.api.readDownloadsFile();
    if (entries && entries.length > 0) {
      emptyEl.style.display = 'none';
      _dlHistoryAll = entries;
      renderDlHistoryPage();
    } else {
      _dlHistoryAll = [];
      emptyEl.textContent = 'No download history found. Downloads are recorded after each file completes.';
    }
  } catch {
    _dlHistoryAll = [];
    emptyEl.textContent = 'Could not read download history.';
  }
});

function buildDownloadHistItem({ fileName, sizeBytes, status, durationSec, timestamp, megaUrl, outputDir }) {
  const li = document.createElement('li');
  li.className = 'dl-hist-item';

  // Row 1: filename (left) | size (right)
  const nameEl = document.createElement('span');
  nameEl.className = 'dl-hi-name';
  nameEl.textContent = fileName || '—';
  nameEl.title = fileName;

  const sizeStr = (() => {
    const n = parseInt(sizeBytes, 10);
    if (!n || isNaN(n)) return sizeBytes || '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 2) + '\u202F' + units[i];
  })();
  const sizeEl = document.createElement('span');
  sizeEl.className = 'dl-hi-size';
  sizeEl.textContent = sizeStr;

  // Row 2: MEGA link
  const linkEl = document.createElement('span');
  linkEl.className = 'dl-hi-link';
  linkEl.textContent = megaUrl || '—';
  linkEl.title = megaUrl;

  // Row 3: status badge + duration + timestamp
  const metaEl = document.createElement('div');
  metaEl.className = 'dl-hi-meta';

  const badge = document.createElement('span');
  badge.className = 'dl-hi-status ' + (status === 'success' ? 's-success' : status === 'canceled' ? 's-canceled' : 's-error');
  badge.textContent = status || 'unknown';

  const durEl = document.createElement('span');
  durEl.className = 'dl-hi-duration';
  const secs = parseFloat(durationSec);
  if (!isNaN(secs) && secs > 0) {
    durEl.textContent = secs >= 60
      ? Math.floor(secs / 60) + 'm ' + (secs % 60).toFixed(0) + 's'
      : secs.toFixed(1) + 's';
  }

  const tsEl = document.createElement('span');
  tsEl.className = 'dl-hi-timestamp';
  tsEl.textContent = (timestamp || '').replace('T', ' ').slice(0, 19);

  metaEl.appendChild(badge);
  if (durEl.textContent) metaEl.appendChild(durEl);
  metaEl.appendChild(tsEl);

  // Retry button — only on failed downloads
  if (status !== 'success' && megaUrl && megaUrl !== '—') {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'dl-hi-retry';
    retryBtn.textContent = '↺ Retry';
    retryBtn.title = 'Add this URL back to the download queue';
    retryBtn.addEventListener('click', () => {
      const outDir = outDirInput.value.trim();
      if (!outDir) {
        sysLog('Choose an output folder first, then retry.', 'll-notice');
        // Switch to the download tab so the user sees the sidebar
        document.querySelector('.tab[data-tab="download"]').click();
        return;
      }
      if (addToQueue(megaUrl, outDir, '')) {
        // Register this as a retry so the outcome updates the existing row
        // rather than appending a new one.
        const csvPath = dataDirPath
          ? dataDirPath.replace(/[/\\]+$/, '') + '/download_log.csv'
          : outDir.replace(/[/\\]+$/, '') + '/download_log.csv';
        pendingRetries.set(megaUrl, { csvPath, originalTimestamp: timestamp });
        retryBtn.textContent = '✓ Queued';
        retryBtn.classList.add('queued');
        retryBtn.disabled = true;
      }
    });
    metaEl.appendChild(retryBtn);
  }

  // Open File button — only for successful downloads where we have the output dir
  if (status === 'success' && outputDir && outputDir !== '—' && fileName && fileName !== '—') {
    const openFileBtn = document.createElement('button');
    openFileBtn.className = 'dl-hi-retry';
    openFileBtn.textContent = '▶ Open File';
    openFileBtn.title = 'Open with default application';
    openFileBtn.addEventListener('click', () => {
      const filePath = outputDir.replace(/[/\\]+$/, '') + '/' + fileName;
      window.api.openFile(filePath);
    });
    metaEl.appendChild(openFileBtn);
  }

  // Open Folder button — whenever we have the output dir
  if (outputDir && outputDir !== '—') {
    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'dl-hi-retry';
    openFolderBtn.textContent = '📂 Open Folder';
    openFolderBtn.title = 'Open containing folder';
    openFolderBtn.addEventListener('click', () => {
      window.api.openFolder(outputDir);
    });
    metaEl.appendChild(openFolderBtn);
    // Delete button — removes this entry from download_log.csv
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'dl-hi-retry';
  deleteBtn.textContent = '🗑 Delete';
  deleteBtn.title = 'Remove this entry from download_log.csv';
  deleteBtn.addEventListener('click', async () => {
    if (deleteBtn.dataset.confirm !== 'yes') {
      deleteBtn.dataset.confirm = 'yes';
      deleteBtn.textContent = 'Sure? Click again';
      deleteBtn.style.cssText = 'background:var(--danger,#ef4444);color:#fff';
      setTimeout(() => {
        if (deleteBtn.dataset.confirm === 'yes') {
          deleteBtn.dataset.confirm = '';
          deleteBtn.textContent = '🗑 Delete';
          deleteBtn.style.cssText = '';
        }
      }, 3000);
      return;
    }
    const result = await window.api.deleteDownloadRow({ timestamp, megaUrl });
    if (result && result.ok) {
      li.remove();
    } else {
      deleteBtn.textContent = '⚠ Error';
      setTimeout(() => { deleteBtn.textContent = '🗑 Delete'; }, 2000);
    }
  });
  metaEl.appendChild(deleteBtn);

  }

  // Click-to-copy for name, size, and link
  function makeDlCopy(el, value, displayText) {
    if (!value || value === '—') return;
    el.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        el.classList.add('copied');
        const prev = el.textContent;
        el.textContent = '✓ Copied';
        setTimeout(() => { el.classList.remove('copied'); el.textContent = displayText || prev; }, 1500);
      } catch { /* ignore */ }
    });
  }

  makeDlCopy(nameEl, fileName, fileName);
  makeDlCopy(sizeEl, sizeStr,  sizeStr);
  makeDlCopy(linkEl, megaUrl,  megaUrl);

  li.appendChild(nameEl);
  li.appendChild(sizeEl);
  li.appendChild(linkEl);
  li.appendChild(metaEl);
  return li;
}

