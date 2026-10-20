'use strict';

// ─── Folder Browser ───────────────────────────────────────────────────────────
(function folderBrowser() {
  let _tree   = null;      // result from browseMegaFolder: { baseUrl, rootName, rootHandle, files, folders }
  let _filter = '';        // current lowercase search string
  const _sel  = new Set(); // handles of selected files

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const overlay    = document.getElementById('fbOverlay');
  const urlInput   = document.getElementById('fbUrlInput');
  const fetchBtn   = document.getElementById('fbFetchBtn');
  const statusEl   = document.getElementById('fbStatus');
  const treeWrap   = document.getElementById('fbTreeWrap');
  const treeEl     = document.getElementById('fbTree');
  const searchEl   = document.getElementById('fbSearch');
  const selectAll  = document.getElementById('fbSelectAll');
  const footer     = document.getElementById('fbFooter');
  const selCountEl = document.getElementById('fbSelCount');
  const addBtn     = document.getElementById('fbAddBtn');

  // ── Open / Close ──────────────────────────────────────────────────────────

  document.getElementById('browseFolderBtn').addEventListener('click', () => {
    overlay.hidden = false;
    urlInput.focus();
  });
  document.getElementById('fbCloseBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  function closeModal() {
    overlay.hidden     = true;
    addBtn.textContent = 'Add to Queue';
    addBtn.disabled    = true;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  function setStatus(msg, type = 'info') {
    statusEl.textContent = msg;
    statusEl.className   = `fb-status fb-status--${type}`;
    statusEl.hidden      = false;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  fetchBtn.addEventListener('click', doFetch);
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') doFetch(); });

  async function doFetch() {
    const url = resolveObfuscatedUrl(urlInput.value.trim());
    if (!url) return;

    fetchBtn.disabled    = true;
    fetchBtn.textContent = '…';
    treeWrap.hidden      = true;
    footer.hidden        = true;
    _sel.clear();
    _tree = null;
    setStatus('Fetching folder…', 'info');

    const res = await window.api.browseMegaFolder(url);

    fetchBtn.disabled    = false;
    fetchBtn.textContent = 'Fetch';

    if (!res.ok) {
      setStatus(`Error: ${res.error}`, 'error');
      return;
    }

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

  // ── Search ────────────────────────────────────────────────────────────────

  searchEl.addEventListener('input', () => {
    _filter = searchEl.value.toLowerCase();
    render();
  });

  // ── Select-all ────────────────────────────────────────────────────────────

  selectAll.addEventListener('change', () => {
    visibleFiles().forEach(f => selectAll.checked ? _sel.add(f.handle) : _sel.delete(f.handle));
    render();
    syncFooter();
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

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
    const n = _sel.size;
    selCountEl.textContent = `${n} file${n !== 1 ? 's' : ''} selected`;
    addBtn.disabled        = n === 0;

    const vis = visibleFiles();
    if (vis.length === 0) { selectAll.checked = false; selectAll.indeterminate = false; return; }
    const allChk = vis.every(f => _sel.has(f.handle));
    const anyChk = vis.some(f => _sel.has(f.handle));
    selectAll.checked       = allChk;
    selectAll.indeterminate = !allChk && anyChk;
  }

  // ── Tree render ───────────────────────────────────────────────────────────

  function render() {
    if (!_tree) return;
    treeEl.innerHTML = '';

    // Build adjacency maps, respecting the active filter for files
    const visSet     = new Set(visibleFiles().map(f => f.handle));
    const subFolders = {}; // parentHandle → folder[]
    const subFiles   = {}; // parentHandle → file[]

    for (const f of _tree.folders)
      (subFolders[f.parentHandle] ??= []).push(f);

    for (const f of _tree.files) {
      if (!visSet.has(f.handle)) continue;
      (subFiles[f.parentHandle] ??= []).push(f);
    }

    // Does `handle` contain any visible files anywhere in its subtree?
    function hasVisible(handle) {
      if (subFiles[handle]?.length) return true;
      return (subFolders[handle] || []).some(sf => hasVisible(sf.handle));
    }

    // All visible file handles under `handle` (recursive)
    function collectHandles(handle) {
      const out = (subFiles[handle] || []).map(f => f.handle);
      for (const sf of (subFolders[handle] || [])) out.push(...collectHandles(sf.handle));
      return out;
    }

    // Recursively build DOM into `container`
    function renderInto(container, folderHandle, depth) {
      const pad = `${depth * 16 + 8}px`;

      // ── Subfolders ──
      for (const folder of (subFolders[folderHandle] || [])) {
        if (_filter && !hasVisible(folder.handle)) continue;

        const childHandles = collectHandles(folder.handle);
        const allChk = childHandles.length > 0 && childHandles.every(h => _sel.has(h));
        const anyChk = childHandles.some(h => _sel.has(h));

        const row = document.createElement('div');
        row.className    = 'fb-row fb-folder';
        row.style.paddingLeft = pad;

        const chk = document.createElement('input');
        chk.type          = 'checkbox';
        chk.checked       = allChk;
        chk.indeterminate = !allChk && anyChk;
        chk.addEventListener('change', () => {
          collectHandles(folder.handle).forEach(h => chk.checked ? _sel.add(h) : _sel.delete(h));
          render();
          syncFooter();
        });

        const arrow = document.createElement('span');
        arrow.className = 'fb-arrow open';
        arrow.textContent = '▶';

        const label = document.createElement('span');
        label.className   = 'fb-folder-name';
        label.textContent = folder.name;

        row.append(chk, arrow, label);
        container.appendChild(row);

        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'fb-children';
        renderInto(childrenDiv, folder.handle, depth + 1);
        container.appendChild(childrenDiv);

        // Collapse / expand on row click (not on checkbox)
        let collapsed = false;
        row.addEventListener('click', e => {
          if (e.target === chk) return;
          collapsed = !collapsed;
          arrow.classList.toggle('open', !collapsed);
          childrenDiv.style.display = collapsed ? 'none' : '';
        });
      }

      // ── Files ──
      for (const file of (subFiles[folderHandle] || [])) {
        const row = document.createElement('div');
        row.className = 'fb-row fb-file' + (_sel.has(file.handle) ? ' selected' : '');
        row.style.paddingLeft = pad;

        const chk = document.createElement('input');
        chk.type    = 'checkbox';
        chk.checked = _sel.has(file.handle);
        chk.addEventListener('change', () => {
          chk.checked ? _sel.add(file.handle) : _sel.delete(file.handle);
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

        row.append(chk, nameSpan, sizeSpan);
        row.addEventListener('click', e => {
          if (e.target === chk) return;
          chk.checked = !chk.checked;
          chk.dispatchEvent(new Event('change'));
        });
        container.appendChild(row);
      }
    }

    renderInto(treeEl, _tree.rootHandle, 0);
    syncFooter();
  }

  // ── Add to Queue / Import Selected ───────────────────────────────────────

  addBtn.addEventListener('click', async () => {
    if (!_tree || _sel.size === 0) return;

    // Default: add to download queue
    const outDir = document.getElementById('outDirInput').value.trim();
    for (const handle of _sel) {
      // Constructs:  https://mega.nz/folder/ID#KEY/file/HANDLE
      // parseUrl() in downloader already decodes this as { linkType:'folder', fileInFolder: handle }
      addToQueue(`${_tree.baseUrl}/file/${handle}`, outDir, '');
    }
    closeModal();
    showToast(`Added ${_sel.size} file${_sel.size !== 1 ? 's' : ''} to the download queue`);
  });

})();

