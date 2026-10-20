'use strict';

// ─── View & Import ─────────────────────────────────────────────────────────────
(function viewImport() {
  'use strict';

  // ── Private state — account (left) pane ──────────────────────────────────
  let _viTree       = null;
  let _viFilter     = '';
  let _viEmail      = '';
  let _viPassword   = '';
  let _viBrowseTool = null; // tool used during browse — reused for get-account-file-links
  const _viSel      = new Set();

  // ── Private state — public (right) pane ──────────────────────────────────
  let _viPublicTree   = null;
  let _viPublicFilter = '';
  const _viPublicSel  = new Set();

  // ── DOM refs — account pane ───────────────────────────────────────────────
  const treeEl      = document.getElementById('vi-tree');
  const treeEmpty   = document.getElementById('vi-treeEmpty');
  const statusEl    = document.getElementById('vi-status');
  const searchEl    = document.getElementById('vi-search');
  const selectAll   = document.getElementById('vi-selectAll');

  // ── DOM refs — public pane ────────────────────────────────────────────────
  const publicTreeEl     = document.getElementById('vi-publicTree');
  const publicTreeEmpty  = document.getElementById('vi-publicTreeEmpty');
  const publicStatusEl   = document.getElementById('vi-publicStatus');
  const publicSearchEl   = document.getElementById('vi-publicSearch');
  const publicSelectAll  = document.getElementById('vi-publicSelectAll');
  const publicUrlLabel   = document.getElementById('vi-publicUrlLabel');

  // ── DOM refs — shared chrome ──────────────────────────────────────────────
  const selCountEl   = document.getElementById('vi-selCount');
  const dlSelBtn      = document.getElementById('vi-downloadSelectedBtn');
  const impSelBtn      = document.getElementById('vi-importSelectedBtn');
  const refreshBtn       = document.getElementById('vi-refreshBtn');
  const accountEl         = document.getElementById('vi-browserAccount');
  const urlInput            = document.getElementById('vi-urlInput');
  const destInput             = document.getElementById('vi-destInput');
  const importAllBtn           = document.getElementById('vi-importAllBtn');
  const openBtn                  = document.getElementById('vi-importSomeBtn');

  // ── Status helpers ──────────────────────────────────────────────────────────
  function setStatus(msg, type = 'info') {
    statusEl.textContent = msg;
    statusEl.className   = `fb-status fb-status--${type}`;
    statusEl.hidden      = false;
  }
  function setPublicStatus(msg, type = 'info') {
    publicStatusEl.textContent = msg;
    publicStatusEl.className   = `fb-status fb-status--${type}`;
    publicStatusEl.hidden      = false;
  }

  // ── Manual login (shown only in the empty "Your Drive" state, before any
  // account has been loaded from the Accounts tab or here) ──────────────────
  const viLoginPane = document.createElement('div');
  viLoginPane.id = 'vi-loginPane';
  viLoginPane.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:14px;';

  const viLoginPrompt = document.createElement('div');
  viLoginPrompt.style.cssText = 'text-align:center;color:var(--text-dim);font-size:13px;';
  viLoginPrompt.innerHTML = 'Select an account in the accounts tab.<br>or, login here:';

  const viLoginUser = document.createElement('input');
  viLoginUser.type         = 'text';
  viLoginUser.placeholder  = 'Email';
  viLoginUser.autocomplete = 'username';
  viLoginUser.style.width  = '200px';

  const viLoginPass = document.createElement('input');
  viLoginPass.type         = 'password';
  viLoginPass.placeholder  = 'Password';
  viLoginPass.autocomplete = 'current-password';
  viLoginPass.style.width  = '200px';

  const viLoginBtn = document.createElement('button');
  viLoginBtn.type        = 'button';
  viLoginBtn.className   = 'btn btn-ghost btn-sm';
  viLoginBtn.textContent = 'Login';

  viLoginPane.append(viLoginPrompt, viLoginUser, viLoginPass, viLoginBtn);

  // Re-show the login pane in the empty state. Called on init, and again
  // from setAccount() below whenever it's invoked with no email — e.g. by
  // the tab-click handler that calls in here automatically. The pane's DOM
  // nodes stay alive in memory even after treeEmpty.innerHTML wipes them out
  // of the tree, so re-appending them here is all that's needed.
  function showLoginPane() {
    treeEmpty.innerHTML = '';
    if (_viEmail) {
      const msg = document.createElement('div');
      msg.innerHTML = `Press ${refreshIcon} to load files from the selected account.`;
      treeEmpty.appendChild(msg);
    }
    treeEmpty.appendChild(viLoginPane);
    treeEmpty.style.display = '';
  }
  showLoginPane();

  // Manually logging in overrides whatever account is currently selected —
  // this is the exact same path the Accounts tab "View" button uses, so it
  // naturally clears the login pane and shows the normal "press refresh"
  // empty state once an account is set.
  function doManualLogin() {
    const email    = viLoginUser.value.trim();
    const password = viLoginPass.value;
    if (!email || !password) { setStatus('Enter both a username and password to log in.', 'error'); return; }
    _viewImport.setAccount(email, password);
    refreshBtn.click();
  }

  viLoginBtn.addEventListener('click', doManualLogin);
  viLoginPass.addEventListener('keydown', e => { if (e.key === 'Enter') doManualLogin(); });

  function fmtSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes < 10 ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
  }

  // The destination field is editable at all times — users can type a
  // destination and import a link directly without opening a folder first.
  function setDestEnabled(enabled) {
    destInput.disabled = false;
  }

  // A single-file link — either a bare /file/ link or a /folder/.../file/ link
  // pointing at one specific file inside a public folder — names an
  // individual file, not a browsable folder tree. browseMegaFolder() only
  // understands folder roots, so these need to skip the "browse as a folder"
  // step entirely and let checkImportQuota resolve the size directly via
  // MEGA's public API instead.
  function isSingleFileLink(url) {
    if (/mega\.nz\/file\/[^#?/\s]+/.test(url)) return true;
    if (/mega\.nz\/folder\/[^#?/\s]+[^/]*\/file\/[^#?/\s]+/.test(url)) return true;
    if (/mega\.nz\/#(?!F!)![^!]+!/.test(url)) return true;
    return false;
  }

  // ── Import URL bar ─────────────────────────────────────────────────────────
  // "Import All": import the entire public folder into this account at destFolder.
  // Checks quota before importing; reuses the public tree if already loaded,
  // otherwise fetches a fresh listing to sum file sizes.
  importAllBtn.addEventListener('click', async () => {
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) { setStatus('Paste a MEGA link first.', 'error'); return; }
    if (!_viEmail) { setStatus('No account selected — click "View" on an account in the Accounts tab.', 'error'); return; }

    const url        = resolveObfuscatedUrl(rawUrl);
    const singleFile = isSingleFileLink(url);
    let destFolder = destInput.value.trim() || '/folder';
    if (!destFolder.startsWith('/')) destFolder = '/' + destFolder;

    importAllBtn.disabled    = true;
    importAllBtn.textContent = 'Checking available space…';
    setStatus('Checking available space…', 'info');

    // Determine total size for the quota check. A single-file link doesn't
    // name a browsable folder tree, so it skips straight to checkImportQuota,
    // which already knows how to resolve one file's size directly via MEGA's
    // public API. Folder links still reuse the in-memory tree if the user
    // already opened this URL in the public pane; otherwise fetch it.
    // MEGA has no single-call "folder total size" API — listing all files and
    // summing their sizes is the only approach for those.
    let totalBytes  = null;
    let importFiles = null;
    if (!singleFile) {
      if (_viPublicTree && publicUrlLabel.textContent === url) {
        importFiles = _viPublicTree.files;
        totalBytes  = importFiles.reduce((sum, f) => sum + (f.size || 0), 0);
      } else {
        const treeRes = await window.api.browseMegaFolder(url);
        if (treeRes.ok) {
          importFiles = treeRes.data.files;
          totalBytes  = importFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        }
      }

      if (totalBytes === null) {
        importAllBtn.disabled    = false;
        importAllBtn.textContent = 'Import All';
        setStatus('Could not determine folder size — check the link and try again.', 'error');
        return;
      }
    }

    const quota = await window.api.checkImportQuota({ email: _viEmail, urls: [url], sizes: [totalBytes] });
    if (!quota.ok) {
      importAllBtn.disabled    = false;
      importAllBtn.textContent = 'Import All';
      setStatus(quota.error || 'Not enough space in this account for this link.', 'error');
      return;
    }

    importAllBtn.textContent = 'Importing…';
    setStatus(`Importing into ${destFolder}…`, 'info');

    const res = await window.api.importMegaLink({
      email:       _viEmail,
      password:    _viPassword,
      url,
      destFolder,
      fileBytes:   quota.totalBytes,
      importFiles: (importFiles || []).map(f => ({ name: f.name, size: f.size })),
    });

    importAllBtn.disabled    = false;
    importAllBtn.textContent = 'Import All';

    if (!res.ok) { setStatus(`Error: ${res.error}`, 'error'); return; }

    showToast(`Imported into ${destFolder}`);
    setStatus(res.output || `Imported into ${destFolder}.`, 'ok');
  });

  // "Open": fetch the pasted link's folder tree directly into the public pane.
  openBtn.addEventListener('click', doOpenPublic);

  async function doOpenPublic() {
    const raw = urlInput.value.trim();
    if (!raw) { setPublicStatus('Paste a MEGA folder link first.', 'error'); return; }
    const url = resolveObfuscatedUrl(raw);

    openBtn.disabled    = true;
    openBtn.textContent = '…';
    publicTreeEmpty.style.display = 'none';
    _viPublicSel.clear();
    _viPublicTree = null;
    publicUrlLabel.textContent = '';
    setPublicStatus('Fetching folder…', 'info');

    const res = await window.api.browseMegaFolder(url);

    openBtn.disabled    = false;
    openBtn.textContent = 'Open';

    if (!res.ok) {
      setPublicStatus(`Error: ${res.error}`, 'error');
      publicTreeEmpty.style.display = '';
      publicTreeEmpty.textContent   = 'Could not load this folder. Check the link and try again.';
      syncFooter();
      return;
    }

    _viPublicTree = res.data;
    publicUrlLabel.textContent = url;
    setDestEnabled(true);

    const { rootName, files, folders } = _viPublicTree;
    setPublicStatus(
      `"${rootName}" — ${files.length.toLocaleString()} file${files.length !== 1 ? 's' : ''} ` +
      `across ${folders.length} folder${folders.length !== 1 ? 's' : ''}`,
      'ok'
    );
    renderPublic();
  }

  // ── Account browser — Refresh ──────────────────────────────────────────────
  refreshBtn.addEventListener('click', doRefresh);

  async function doRefresh() {
    if (!_viEmail) {
      setStatus('No account selected — click "View" on an account in the Accounts tab.', 'error');
      return;
    }

    refreshBtn.disabled = true;
    _viSel.clear();
    _viTree = null;
    treeEl.innerHTML        = '';
    treeEmpty.style.display = 'none';
    setStatus('Logging in and fetching file list…', 'info');

    const res = await window.api.browseAccountFiles({ email: _viEmail, password: _viPassword });

    refreshBtn.disabled = false;

    if (!res.ok) {
      setStatus(`Error: ${res.error}`, 'error');
      treeEmpty.style.display  = '';
      treeEmpty.textContent    = 'Could not load files. Check credentials or try again.';
      syncFooter();
      return;
    }

    _viTree       = res.data;
    _viBrowseTool = res.tool;

    const n = _viTree.files.length;
    setStatus(
      `${n} file${n !== 1 ? 's' : ''} found` +
      (res.tool ? ` · via ${toolDisplayName(res.tool)}` : '') +
      (n === 0 && res.tool === 'megacmd' ? ' — sizes shown as 0 (megacmd `find` limitation)' : ''),
              'ok'
    );

    if (n === 0) {
      treeEmpty.style.display = '';
      treeEmpty.textContent   = 'No files found in this account.';
    }

    render();
  }

  // ── Tree helpers ───────────────────────────────────────────────────────────
  function visibleFiles() {
    if (!_viTree) return [];
    if (!_viFilter) return _viTree.files;
    return _viTree.files.filter(f => f.name.toLowerCase().includes(_viFilter));
  }

  function visiblePublicFiles() {
    if (!_viPublicTree) return [];
    if (!_viPublicFilter) return _viPublicTree.files;
    return _viPublicTree.files.filter(f => f.name.toLowerCase().includes(_viPublicFilter));
  }

  function syncFooter() {
    const n = _viSel.size + _viPublicSel.size;
    selCountEl.textContent = `${n} file${n !== 1 ? 's' : ''} selected`;

    // Download Selected needs a loaded, visible account tree.
    dlSelBtn.disabled = _viSel.size === 0 || !_viTree;
    // Import Selected needs a loaded public folder.
    impSelBtn.disabled = _viPublicSel.size === 0 || !_viPublicTree;

    const vis = visibleFiles();
    if (!vis.length) { selectAll.checked = false; selectAll.indeterminate = false; }
    else {
      const allChk = vis.every(f => _viSel.has(f.handle));
      const anyChk = vis.some(f =>  _viSel.has(f.handle));
      selectAll.checked       = allChk;
      selectAll.indeterminate = !allChk && anyChk;
    }

    const pvis = visiblePublicFiles();
    if (!pvis.length) { publicSelectAll.checked = false; publicSelectAll.indeterminate = false; }
    else {
      const allChk = pvis.every(f => _viPublicSel.has(f.handle));
      const anyChk = pvis.some(f =>  _viPublicSel.has(f.handle));
      publicSelectAll.checked       = allChk;
      publicSelectAll.indeterminate = !allChk && anyChk;
    }
  }

  // ── Account tree renderer (folder text sets destination, arrow expands) ───
  function render() {
    if (!_viTree) return;
    treeEl.innerHTML        = '';
    treeEmpty.style.display = 'none';

    const visSet     = new Set(visibleFiles().map(f => f.handle));
    const subFolders = {};
    const subFiles   = {};

    for (const f of _viTree.folders)
      (subFolders[f.parentHandle] ??= []).push(f);
    for (const f of _viTree.files) {
      if (!visSet.has(f.handle)) continue;
      (subFiles[f.parentHandle] ??= []).push(f);
    }

    function hasVisible(h) {
      if (subFiles[h]?.length) return true;
      return (subFolders[h] || []).some(sf => hasVisible(sf.handle));
    }

    function collectHandles(h) {
      const out = (subFiles[h] || []).map(f => f.handle);
      for (const sf of (subFolders[h] || [])) out.push(...collectHandles(sf.handle));
      return out;
    }

    function renderInto(container, folderHandle, depth) {
      const pad = `${depth * 16 + 8}px`;

      for (const folder of (subFolders[folderHandle] || [])) {
        if (_viFilter && !hasVisible(folder.handle)) continue;

        const childHandles = collectHandles(folder.handle);
        const allChk = childHandles.length > 0 && childHandles.every(h => _viSel.has(h));
        const anyChk = childHandles.some(h => _viSel.has(h));

        const row   = document.createElement('div');
        row.className = 'fb-row fb-folder';
        row.style.paddingLeft = pad;

        const chk   = document.createElement('input');
        chk.type          = 'checkbox';
        chk.checked       = allChk;
        chk.indeterminate = !allChk && anyChk;
        chk.addEventListener('change', () => {
          collectHandles(folder.handle).forEach(h => chk.checked ? _viSel.add(h) : _viSel.delete(h));
          render(); syncFooter();
        });

        const arrow = document.createElement('span');
        arrow.className   = 'fb-arrow open';
        arrow.textContent = '▶';

        const label = document.createElement('span');
        label.className   = 'fb-folder-name';
        label.textContent = folder.name;
        label.title        = 'Click to set as the import destination';
        label.addEventListener('click', () => {
          destInput.value = folder.handle;
        });

        row.append(chk, arrow, label);
        container.appendChild(row);

        const childDiv = document.createElement('div');
        childDiv.className = 'fb-children';
        renderInto(childDiv, folder.handle, depth + 1);
        container.appendChild(childDiv);

        let collapsed = false;
        arrow.addEventListener('click', () => {
          collapsed = !collapsed;
          arrow.classList.toggle('open', !collapsed);
          childDiv.style.display = collapsed ? 'none' : '';
        });
      }

      for (const file of (subFiles[folderHandle] || [])) {
        const row = document.createElement('div');
        row.className = 'fb-row fb-file' + (_viSel.has(file.handle) ? ' selected' : '');
        row.style.paddingLeft = pad;

        const chk = document.createElement('input');
        chk.type    = 'checkbox';
        chk.checked = _viSel.has(file.handle);
        chk.addEventListener('change', () => {
          chk.checked ? _viSel.add(file.handle) : _viSel.delete(file.handle);
          render(); syncFooter();
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

    renderInto(treeEl, _viTree.rootHandle, 0);
    syncFooter();
  }

  // ── Public tree renderer (whole row toggles expand — no destination link) ─
  function renderPublic() {
    if (!_viPublicTree) return;
    publicTreeEl.innerHTML        = '';
    publicTreeEmpty.style.display = 'none';

    const visSet     = new Set(visiblePublicFiles().map(f => f.handle));
    const subFolders = {};
    const subFiles   = {};

    for (const f of _viPublicTree.folders)
      (subFolders[f.parentHandle] ??= []).push(f);
    for (const f of _viPublicTree.files) {
      if (!visSet.has(f.handle)) continue;
      (subFiles[f.parentHandle] ??= []).push(f);
    }

    function hasVisible(h) {
      if (subFiles[h]?.length) return true;
      return (subFolders[h] || []).some(sf => hasVisible(sf.handle));
    }

    function collectHandles(h) {
      const out = (subFiles[h] || []).map(f => f.handle);
      for (const sf of (subFolders[h] || [])) out.push(...collectHandles(sf.handle));
      return out;
    }

    function renderInto(container, folderHandle, depth) {
      const pad = `${depth * 16 + 8}px`;

      for (const folder of (subFolders[folderHandle] || [])) {
        if (_viPublicFilter && !hasVisible(folder.handle)) continue;

        const childHandles = collectHandles(folder.handle);
        const allChk = childHandles.length > 0 && childHandles.every(h => _viPublicSel.has(h));
        const anyChk = childHandles.some(h => _viPublicSel.has(h));

        const row   = document.createElement('div');
        row.className = 'fb-row fb-folder';
        row.style.paddingLeft = pad;

        const chk   = document.createElement('input');
        chk.type          = 'checkbox';
        chk.checked       = allChk;
        chk.indeterminate = !allChk && anyChk;
        chk.addEventListener('change', () => {
          collectHandles(folder.handle).forEach(h => chk.checked ? _viPublicSel.add(h) : _viPublicSel.delete(h));
          renderPublic(); syncFooter();
        });

        const arrow = document.createElement('span');
        arrow.className   = 'fb-arrow open';
        arrow.textContent = '▶';

        const label = document.createElement('span');
        label.className   = 'fb-folder-name';
        label.textContent = folder.name;

        row.append(chk, arrow, label);
        container.appendChild(row);

        const childDiv = document.createElement('div');
        childDiv.className = 'fb-children';
        renderInto(childDiv, folder.handle, depth + 1);
        container.appendChild(childDiv);

        let collapsed = false;
        row.addEventListener('click', e => {
          if (e.target === chk) return;
          collapsed = !collapsed;
          arrow.classList.toggle('open', !collapsed);
          childDiv.style.display = collapsed ? 'none' : '';
        });
      }

      for (const file of (subFiles[folderHandle] || [])) {
        const row = document.createElement('div');
        row.className = 'fb-row fb-file' + (_viPublicSel.has(file.handle) ? ' selected' : '');
        row.style.paddingLeft = pad;

        const chk = document.createElement('input');
        chk.type    = 'checkbox';
        chk.checked = _viPublicSel.has(file.handle);
        chk.addEventListener('change', () => {
          chk.checked ? _viPublicSel.add(file.handle) : _viPublicSel.delete(file.handle);
          renderPublic(); syncFooter();
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

    renderInto(publicTreeEl, _viPublicTree.rootHandle, 0);
    syncFooter();
  }

  searchEl.addEventListener('input', () => {
    _viFilter = searchEl.value.toLowerCase();
    render();
  });

  selectAll.addEventListener('change', () => {
    visibleFiles().forEach(f => selectAll.checked ? _viSel.add(f.handle) : _viSel.delete(f.handle));
    render(); syncFooter();
  });

  publicSearchEl.addEventListener('input', () => {
    _viPublicFilter = publicSearchEl.value.toLowerCase();
    renderPublic();
  });

  publicSelectAll.addEventListener('change', () => {
    visiblePublicFiles().forEach(f => publicSelectAll.checked ? _viPublicSel.add(f.handle) : _viPublicSel.delete(f.handle));
    renderPublic(); syncFooter();
  });

  // ── Download Selected ──────────────────────────────────────────────────────
  // Requests public links for the selected file paths, then adds them to the
  // download queue and switches to the Download tab.
  dlSelBtn.addEventListener('click', async () => {
    if (!_viSel.size || !_viTree) return;

    const outDir = document.getElementById('outDirInput').value.trim();
    if (!outDir) {
      setStatus('Set an output folder on the Download tab first.', 'error');
      return;
    }

    const selectedPaths = _viTree.files
    .filter(f => _viSel.has(f.handle))
    .map(f => f.handle);

    dlSelBtn.disabled    = true;
    dlSelBtn.textContent = `Getting links… (0 / ${selectedPaths.length})`;
    setStatus(`Generating download links for ${selectedPaths.length} file(s)…`, 'info');

    const res = await window.api.getAccountFileLinks({
      email:    _viEmail,
      password: _viPassword,
      paths:    selectedPaths,
      tool:     _viBrowseTool,
    });

    dlSelBtn.disabled    = false;
    dlSelBtn.textContent = '⬇ Download Selected';

    if (!res.ok) { setStatus(`Error: ${res.error}`, 'error'); return; }

    let added = 0;
    for (const { url } of res.links) {
      if (url && addToQueue(url, outDir, '')) added++;
    }

    if (added > 0) {
      document.querySelector('.tab[data-tab="download"]').click();
      showToast(`Added ${added} file${added !== 1 ? 's' : ''} to the download queue`);
    } else {
      setStatus('No download links could be generated. Try a different tool in Settings.', 'error');
    }
  });

  // ── Import Selected ────────────────────────────────────────────────────────
  // Imports each selected public file directly into the account at destInput.
  impSelBtn.addEventListener('click', async () => {
    if (!_viPublicSel.size || !_viPublicTree) return;
    if (!_viEmail) { setPublicStatus('No account selected — click "View" on an account in the Accounts tab.', 'error'); return; }

    let destFolder = destInput.value.trim() || '/folder';
    if (!destFolder.startsWith('/')) destFolder = '/' + destFolder;

    const _impSelHandles = [..._viPublicSel];
    const _impSelSizeMap = new Map(_viPublicTree.files.map(f => [f.handle, f.size]));
    const _impSelNameMap = new Map(_viPublicTree.files.map(f => [f.handle, f.name]));
    const urls  = _impSelHandles.map(handle => `${_viPublicTree.baseUrl}/file/${handle}`);
    const sizes = _impSelHandles.map(handle => _impSelSizeMap.get(handle));
    const names = _impSelHandles.map(handle => _impSelNameMap.get(handle));

    impSelBtn.disabled    = true;
    impSelBtn.textContent = 'Checking available space…';

    const quota = await window.api.checkImportQuota({ email: _viEmail, urls, sizes });
    if (!quota.ok) {
      impSelBtn.disabled    = false;
      impSelBtn.textContent = '↩ Import Selected';
      setPublicStatus(quota.error || 'Not enough space in this account for these files.', 'error');
      return;
    }

    let ok = 0, failed = 0;
    for (let i = 0; i < urls.length; i++) {
      impSelBtn.textContent = `Importing… (${i + 1} / ${urls.length})`;
      const res = await window.api.importMegaLink({ email: _viEmail, password: _viPassword, url: urls[i], destFolder, fileBytes: quota.fileSizes[i], fileName: names[i] });
      if (res.ok) ok++; else failed++;
    }
    impSelBtn.disabled    = false;
    impSelBtn.textContent = '↩ Import Selected';

    if (failed === 0) {
      showToast(`Imported ${ok} file${ok !== 1 ? 's' : ''} into ${destFolder}`);
      setPublicStatus(`Imported ${ok} file${ok !== 1 ? 's' : ''} into ${destFolder}.`, 'ok');
    } else {
      showToast(`Imported ${ok}, failed ${failed} — check account login or link validity`);
      setPublicStatus(`Imported ${ok}, failed ${failed}.`, 'error');
    }
  });

  // ── Public interface ───────────────────────────────────────────────────────
  // Exposed via the outer-scope `_viewImport` variable so the upload IIFE's
  // "View" button and the tab-click handler can call in without a shared ref.
  _viewImport = {
    hasAccount() { return Boolean(_viEmail); },

 setAccount(email, password) {
   _viEmail    = email;
   _viPassword = password;
   accountEl.textContent   = email || 'No account selected';
   _viTree     = null;
   _viBrowseTool = null;
   _viSel.clear();
   treeEl.innerHTML        = '';
showLoginPane();
   statusEl.hidden         = true;
   syncFooter();
 },
  };

  setDestEnabled(true);
  syncFooter();
})();

