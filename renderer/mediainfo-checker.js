'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Download — Mediainfo Checker sub-tab
// ═══════════════════════════════════════════════════════════════════════════════

// Shared list-item builder for both the current-check result and the History
// list — mirrors the Upload tab's buildMediaInfoItem(), keyed off `checkedAt`
// instead of `uploadedAt`.
function buildMicItem(record) {
  const { fileName, fileLink, checkedAt, mediainfo } = record;

  const li = document.createElement('li');
  li.className = 'mi-item';

  const hdr = document.createElement('div');
  hdr.className = 'mi-header';

  const copyBtn = document.createElement('button');
  copyBtn.type      = 'button';
  copyBtn.className = 'mi-copy-btn';
  copyBtn.title     = 'Copy mediainfo';
  copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" /><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2" /></svg>`;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(typeof mediainfo === 'string' ? mediainfo.trim() : '').catch(() => {});
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1400);
  });

  const nameEl = document.createElement('span');
  nameEl.className = 'mi-filename';
  nameEl.textContent = fileName;
  nameEl.title = 'Click to copy MEGA link';
  nameEl.addEventListener('click', () => {
    navigator.clipboard.writeText(fileLink || fileName).catch(() => {});
    nameEl.textContent = '✓ Copied';
    nameEl.classList.add('copied');
    setTimeout(() => { nameEl.textContent = fileName; nameEl.classList.remove('copied'); }, 1400);
  });

  const dateEl = document.createElement('span');
  dateEl.className = 'mi-date';
  dateEl.textContent = checkedAt || '';

  hdr.append(copyBtn, nameEl, dateEl);
  li.appendChild(hdr);

  if (typeof mediainfo === 'string' && mediainfo.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'mi-text-body';
    pre.textContent = mediainfo.trim();
    li.appendChild(pre);
  } else {
    const none = document.createElement('div');
    none.style.cssText = 'padding:9px 12px;font-size:11px;color:var(--text3)';
    none.textContent = 'No media tracks detected.';
    li.appendChild(none);
  }

  return li;
}

// ─── Mediainfo Checker — main bar, result, history ─────────────────────────────
(function mediainfoChecker() {
  const urlInput    = document.getElementById('mic-urlInput');
  const getBtn      = document.getElementById('mic-getBtn');
  const statusEl    = document.getElementById('mic-status');
  const resultWrap  = document.getElementById('mic-resultWrap');
  const historyWrap = document.getElementById('mic-historyWrap');
  const historyBtn  = document.getElementById('mic-historyBtn');
  const historyList  = document.getElementById('mic-historyList');
  const historyEmpty = document.getElementById('mic-historyEmpty');

  function setStatus(msg, type = 'info') {
    if (!msg) { statusEl.hidden = true; return; }
    statusEl.textContent = msg;
    statusEl.className   = `fb-status fb-status--${type}`;
    statusEl.hidden      = false;
  }

  // file-vs-folder check: 'file' anywhere in the link wins (covers both plain
  // file links and folder-derived /folder/ID#KEY/file/HANDLE links — both are
  // single files). Only bare folder links (no 'file' segment) are folders.
  // If neither word appears, the link may be wrapped in obfuscating base64
  // layers — peel up to 3 and check again before giving up.
  function isFolderLink(url) {
    if (url.includes('file'))   return false;
    if (url.includes('folder')) return true;

    let candidate = url;
    for (let i = 0; i < 3; i++) {
      try {
        candidate = atob(candidate);
      } catch {
        break;
      }
      if (candidate.includes('file'))   return false;
      if (candidate.includes('folder')) return true;
    }

    throw new Error("Could not determine link type — no 'file' or 'folder' found.");
  }

  // ── Current-check result ────────────────────────────────────────────────────
  async function doCheck(url, name) {
    showResultView();
    getBtn.disabled      = true;
    urlInput.disabled    = true;
    resultWrap.innerHTML = '';
    setStatus('Grabbing mediainfo… this can take a few seconds.', 'info');
    try {
      const res = await window.api.grabMediainfo({ url, name: name || null });
      if (res.ok) {
        setStatus('');
        resultWrap.appendChild(buildMicItem(res.record));
      } else {
        setStatus(`Error: ${res.error}`, 'error');
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`, 'error');
    } finally {
      getBtn.disabled    = false;
      urlInput.disabled  = false;
    }
  }
  _micRunCheck = doCheck; // exposed for the folder-browser modal

  getBtn.addEventListener('click', () => {
    const raw = resolveObfuscatedUrl(urlInput.value.trim());
    if (!raw) { setStatus('Paste a MEGA link first.', 'error'); return; }
    const { kind, reason } = classifyMegaUrl(raw);
    if (kind === 'not-mega')     { setStatus("That doesn't look like a MEGA link.", 'error'); return; }
    if (kind === 'unrecognized') { setStatus(`Could not parse that link${reason ? ` (${reason})` : ''}.`, 'error'); return; }

    let folder;
    try {
      folder = isFolderLink(raw);
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    if (folder) {
      setStatus('');
      _micOpenFolderBrowser && _micOpenFolderBrowser(raw);
    } else {
      doCheck(raw, null);
    }
  });
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') getBtn.click(); });

  // ── History toggle + pagination ─────────────────────────────────────────────
  let _micHistoryAll    = [];
  let micHistoryPage    = 1;
  let micHistoryPerPage = 50;
  let micShowingHistory = false;

  window._setMicHistoryPerPage = function (n) {
    micHistoryPerPage = (Number.isFinite(n) && n >= 1) ? n : 50;
  };

  function showResultView() {
    micShowingHistory          = false;
    historyBtn.textContent     = 'History';
    resultWrap.style.display   = '';
    historyWrap.style.display  = 'none';
  }

  function renderMicHistoryPage() {
    historyList.style.minHeight = historyList.offsetHeight + 'px';
    historyList.innerHTML = '';
    const start = (micHistoryPage - 1) * micHistoryPerPage;
    _micHistoryAll.slice(start, start + micHistoryPerPage).forEach(r => historyList.appendChild(buildMicItem(r)));
    renderMicHistoryPagination();
    historyList.style.minHeight = '';
  }

  function renderMicHistoryPagination() {
    const pagination = document.getElementById('mic-historyPagination');
    const pageInfo    = document.getElementById('mic-historyPageInfo');
    const prevBtn     = document.getElementById('mic-historyPrevBtn');
    const nextBtn     = document.getElementById('mic-historyNextBtn');
    if (_micHistoryAll.length === 0) { pagination.style.display = 'none'; return; }
    const totalPages = Math.max(1, Math.ceil(_micHistoryAll.length / micHistoryPerPage));
    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfo.textContent     = `Page ${micHistoryPage} of ${totalPages}`;
    prevBtn.disabled         = micHistoryPage <= 1;
    nextBtn.disabled         = micHistoryPage >= totalPages;
  }

  document.getElementById('mic-historyPrevBtn').addEventListener('click', () => {
    if (micHistoryPage <= 1) return;
    micHistoryPage--;
    preserveScrollAnchor(document.getElementById('mic-historyPagination'), renderMicHistoryPage);
  });
  document.getElementById('mic-historyNextBtn').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(_micHistoryAll.length / micHistoryPerPage));
    if (micHistoryPage >= totalPages) return;
    micHistoryPage++;
    preserveScrollAnchor(document.getElementById('mic-historyPagination'), renderMicHistoryPage);
  });

  historyBtn.addEventListener('click', async () => {
    micShowingHistory = !micShowingHistory;
    if (!micShowingHistory) { showResultView(); return; }

    historyBtn.textContent     = '← Back';
    resultWrap.style.display   = 'none';
    historyWrap.style.display  = '';
    micHistoryPage = 1;
    historyList.innerHTML = '';
    historyEmpty.style.display = '';
    historyEmpty.textContent = 'Loading mediainfo records…';
    try {
      const records = await window.api.readMediainfoGrabbed();
      if (records && records.length > 0) {
        historyEmpty.style.display = 'none';
        _micHistoryAll = records;
        renderMicHistoryPage();
      } else {
        _micHistoryAll = [];
        historyEmpty.textContent = 'No mediainfo records found. Records are saved here each time you check a link.';
      }
    } catch {
      _micHistoryAll = [];
      historyEmpty.textContent = 'Could not read mediainfo records.';
    }
  });
})();

// ─── Mediainfo Checker — single-select Folder Browser modal ────────────────────
(function mediaInfoFolderBrowser() {
  let _tree    = null;
  let _filter  = '';
  let _sel     = null; // selected file handle (single)
let _selName = '';

const overlay    = document.getElementById('micFbOverlay');
const urlInput   = document.getElementById('micFbUrlInput');
const fetchBtn   = document.getElementById('micFbFetchBtn');
const statusEl   = document.getElementById('micFbStatus');
const treeWrap   = document.getElementById('micFbTreeWrap');
const treeEl     = document.getElementById('micFbTree');
const searchEl   = document.getElementById('micFbSearch');
const footer     = document.getElementById('micFbFooter');
const selCountEl = document.getElementById('micFbSelCount');
const getBtn     = document.getElementById('micFbGetBtn');

document.getElementById('micFbCloseBtn').addEventListener('click', closeModal);
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

function closeModal() {
  overlay.hidden  = true;
  getBtn.disabled = true;
}

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className   = `fb-status fb-status--${type}`;
  statusEl.hidden      = false;
}

fetchBtn.addEventListener('click', doFetch);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doFetch(); });

async function doFetch() {
  const url = resolveObfuscatedUrl(urlInput.value.trim());
  if (!url) return;

  fetchBtn.disabled    = true;
  fetchBtn.textContent = '…';
  treeWrap.hidden      = true;
  footer.hidden        = true;
  _sel = null; _selName = '';
  _tree = null;
  setStatus('Fetching folder…', 'info');

  const res = await window.api.browseMegaFolder(url);

  fetchBtn.disabled    = false;
  fetchBtn.textContent = 'Fetch';

  if (!res.ok) { setStatus(`Error: ${res.error}`, 'error'); return; }

  _tree = res.data;
  const { rootName, files, folders } = _tree;
  setStatus(
    `"${rootName}" — ${files.length.toLocaleString()} file${files.length !== 1 ? 's' : ''} ` +
    `across ${folders.length} folder${folders.length !== 1 ? 's' : ''}`,
    'ok'
  );
  render();
  treeWrap.hidden = false;
  footer.hidden   = false;
}

searchEl.addEventListener('input', () => { _filter = searchEl.value.toLowerCase(); render(); });

function visibleFiles() {
  if (!_tree) return [];
  if (!_filter) return _tree.files;
  return _tree.files.filter(f => f.name.toLowerCase().includes(_filter));
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes < 10 ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
}

function syncFooter() {
  selCountEl.textContent = _sel ? '1 file selected' : 'No file selected';
  getBtn.disabled         = !_sel;
}

function render() {
  if (!_tree) return;
  treeEl.innerHTML = '';

  const visSet     = new Set(visibleFiles().map(f => f.handle));
  const subFolders = {};
  const subFiles   = {};

  for (const f of _tree.folders) (subFolders[f.parentHandle] ??= []).push(f);
  for (const f of _tree.files) { if (visSet.has(f.handle)) (subFiles[f.parentHandle] ??= []).push(f); }

  function hasVisible(handle) {
    if (subFiles[handle]?.length) return true;
    return (subFolders[handle] || []).some(sf => hasVisible(sf.handle));
  }

  function renderInto(container, folderHandle, depth) {
    const pad = `${depth * 16 + 8}px`;

    for (const folder of (subFolders[folderHandle] || [])) {
      if (_filter && !hasVisible(folder.handle)) continue;

      const row = document.createElement('div');
      row.className = 'fb-row fb-folder';
      row.style.paddingLeft = pad;

      const arrow = document.createElement('span');
      arrow.className = 'fb-arrow open';
      arrow.textContent = '▶';

      const label = document.createElement('span');
      label.className   = 'fb-folder-name';
      label.textContent = folder.name;

      row.append(arrow, label);
      container.appendChild(row);

      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'fb-children';
      renderInto(childrenDiv, folder.handle, depth + 1);
      container.appendChild(childrenDiv);

      let collapsed = false;
      row.addEventListener('click', () => {
        collapsed = !collapsed;
        arrow.classList.toggle('open', !collapsed);
        childrenDiv.style.display = collapsed ? 'none' : '';
      });
    }

    for (const file of (subFiles[folderHandle] || [])) {
      const row = document.createElement('div');
      row.className = 'fb-row fb-file' + (_sel === file.handle ? ' selected' : '');
      row.style.paddingLeft = pad;

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'micFbFileSel';
      radio.checked = _sel === file.handle;
      radio.addEventListener('change', () => {
        _sel     = file.handle;
        _selName = file.name;
        render();
        syncFooter();
      });

      const nameSpan = document.createElement('span');
      nameSpan.className   = 'fb-file-name';
      nameSpan.textContent = file.name;
      nameSpan.title       = file.name;

      const sizeSpan = document.createElement('span');
      sizeSpan.className   = 'fb-file-size';
      sizeSpan.textContent = fmtSize(file.size);

      row.append(radio, nameSpan, sizeSpan);
      row.addEventListener('click', e => {
        if (e.target === radio) return;
        radio.checked = true;
        radio.dispatchEvent(new Event('change'));
      });
      container.appendChild(row);
    }
  }

  renderInto(treeEl, _tree.rootHandle, 0);
  syncFooter();
}

getBtn.addEventListener('click', () => {
  if (!_tree || !_sel) return;
  const url  = `${_tree.baseUrl}/file/${_sel}`;
  const name = _selName;
  closeModal();
  _micRunCheck && _micRunCheck(url, name);
});

// ── Public open() — called from the main checker bar when a folder link is
// pasted and "Get Mediainfo" is pressed. Prefills the URL and auto-fetches,
// mirroring the existing "Browse MEGA Folder" entry point.
_micOpenFolderBrowser = function (url) {
  overlay.hidden = false;
  urlInput.value = url;
  searchEl.value = '';
  _filter        = '';
  urlInput.focus();
  doFetch();
};
})();
