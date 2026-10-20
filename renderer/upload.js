'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Upload UI renderer
// ═══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────────
  // upStaging  : files added/ordered in the sidebar BEFORE upload starts
  // liveQueue  : files sent to main process; driven by IPC events
  let upStaging  = [];
  let upStagingId = 1;
  let liveQueue      = [];   // { id, name, size, status:'pending'|'uploading'|'done'|'failed'|'cancelled', pct, speed, error }
  let _upCurrentIdx  = 0;   // 1-based index of the file currently uploading
  let _upTotalFiles  = 0;   // total file count for the current run
  const upLinks  = [];

  // Keyed by fileLink — stores the OMDB API response object for each link item after the user
  // runs a 🎬 OMDB search and selects a title.  Referenced by the Post button handler.
  const omdbCache = new Map();

  // ── Multi-link selection state ────────────────────────────────────────────────
  // Tracks which link items are selected by their unique link URL.
  const _selectedLinks = new Set();   // Set<linkUrl>
  // Complete data for each link by URL — populated when the tab loads or live links arrive.
  const _linkDataMap   = new Map();   // Map<linkUrl, { name, link, size, email, password, folderLink, lastLogin }>

  // ── Links subtab pagination state ─────────────────────────────────────────────
  let _linkGroupsAll  = [];   // full [baseName, items[]] pairs from the most recent fetch, in CSV order
  let upLinksPage     = 1;    // 1-based current page number
  let upLinksPerPage  = 25;   // rows per page — overwritten from saved settings in init()

// ── Imported Links subtab selection + pagination state ────────────────────────
const _selectedImports    = new Set();   // Set<linkUrl>
const _importDataMap      = new Map();   // Map<linkUrl, { name, link, size, email, password, folderLink, importDate }>
const _importMediainfoMap = new Map();   // Map<linkUrl, mediainfo record> — refreshed each time the Imported Links tab loads
let _importGroupsAll      = [];   // full [baseName, items[]] pairs from the most recent fetch, in CSV order
let upImportsPage         = 1;    // 1-based current page number
let upImportsPerPage      = 25;   // rows per page — overwritten from saved settings in init()

// ── Accounts subtab pagination state ──────────────────────────────────────────
let _accountsAll      = [];   // full account entries from the most recent fetch
let upAccountsPage    = 1;    // 1-based current page number
let upAccountsPerPage = 25;   // rows per page — overwritten from saved settings in init()

// ── MediaInfo subtab pagination state ─────────────────────────────────────────
let _mediaInfoAll      = [];   // full mediainfo records from the most recent fetch
let upMediaInfoPage    = 1;    // 1-based current page number
let upMediaInfoPerPage = 25;   // rows per page — overwritten from saved settings in init()

  function syncActionBar() {
    const bar     = document.getElementById('up-linksActionBar');
    const countEl = document.getElementById('up-labCount');
    if (!bar || !countEl) return;
    const n = _selectedLinks.size;
    bar.style.display     = n > 0 ? 'flex' : 'none';
    countEl.textContent   = `${n} selected`;
    // Sync the "Select All" checkbox
    const selectAllChk    = document.getElementById('up-selectAllChk');
    if (selectAllChk) {
      selectAllChk.checked       = n > 0 && n >= _linkDataMap.size;
      selectAllChk.indeterminate = n > 0 && n < _linkDataMap.size;
    }
  }

  function getSelectedItems() {
    const items = [];
    for (const linkUrl of _selectedLinks) {
      const data = _linkDataMap.get(linkUrl);
      if (data) items.push(data);
    }
    // Sort archive parts by part number
    items.sort((a, b) => {
      const pa = parseArchivePart(a.name);
      const pb = parseArchivePart(b.name);
      return (pa ? pa.partNum : 0) - (pb ? pb.partNum : 0);
    });
    return items;
  }

  function toggleLinkSelection(linkUrl, li, chk) {
    if (_selectedLinks.has(linkUrl)) {
      _selectedLinks.delete(linkUrl);
      li.classList.remove('selected');
      chk.checked = false;
    } else {
      _selectedLinks.add(linkUrl);
      li.classList.add('selected');
      chk.checked = true;
    }
    syncActionBar();
  }

  function deselectAll() {
    _selectedLinks.clear();
    document.querySelectorAll('.up-link-item.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.up-li-chk').forEach(el => { el.checked = false; });
    document.querySelectorAll('.up-group-header .up-li-chk').forEach(el => { el.checked = false; });
    syncActionBar();
  }

  function selectAll() {
    for (const [linkUrl] of _linkDataMap) _selectedLinks.add(linkUrl);
    document.querySelectorAll('.up-link-item').forEach(el => el.classList.add('selected'));
    document.querySelectorAll('.up-li-chk').forEach(el => { el.checked = true; });
    syncActionBar();
  }

  // ── Imported Links selection helpers (mirror the Generated Links helpers above) ─
  function syncImportActionBar() {
    const bar     = document.getElementById('up-importedActionBar');
    const countEl = document.getElementById('up-iabCount');
    if (!bar || !countEl) return;
    const n = _selectedImports.size;
    bar.style.display   = n > 0 ? 'flex' : 'none';
    countEl.textContent = `${n} selected`;
    const selectAllChk  = document.getElementById('up-importedSelectAllChk');
    if (selectAllChk) {
      selectAllChk.checked       = n > 0 && n >= _importDataMap.size;
      selectAllChk.indeterminate = n > 0 && n < _importDataMap.size;
    }
  }

  function getSelectedImportItems() {
    const items = [];
    for (const linkUrl of _selectedImports) {
      const data = _importDataMap.get(linkUrl);
      if (data) items.push(data);
    }
    items.sort((a, b) => {
      const pa = parseArchivePart(a.name);
      const pb = parseArchivePart(b.name);
      return (pa ? pa.partNum : 0) - (pb ? pb.partNum : 0);
    });
    return items;
  }

  function toggleImportSelection(linkUrl, li, chk) {
    if (_selectedImports.has(linkUrl)) {
      _selectedImports.delete(linkUrl);
      li.classList.remove('selected');
      chk.checked = false;
    } else {
      _selectedImports.add(linkUrl);
      li.classList.add('selected');
      chk.checked = true;
    }
    syncImportActionBar();
  }

  function deselectAllImports() {
    _selectedImports.clear();
    document.querySelectorAll('#up-importedList .up-link-item.selected').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('#up-importedList .up-li-chk').forEach(el => { el.checked = false; });
    syncImportActionBar();
  }

  function selectAllImports() {
    for (const [linkUrl] of _importDataMap) _selectedImports.add(linkUrl);
    document.querySelectorAll('#up-importedList .up-link-item').forEach(el => el.classList.add('selected'));
    document.querySelectorAll('#up-importedList .up-li-chk').forEach(el => { el.checked = true; });
    syncImportActionBar();
  }

  let upRunning  = false;
  let dragSrcId  = null;   // staging sidebar drag
  let lqDragSrcId = null;  // live queue drag

  // Upload session stats — populated during the run, consumed by buildUploadReportLines()
  let _upSessStartTime     = 0;
  let _upSessPeakBps       = 0;
  let _upSessMinBps        = Infinity;
  let _upSessSpeedSamples  = [];
  let _upFileWarmupEndTime = 0;  // per-file warmup: minBps not recorded until this passes

  // ── Tool order / force state (sidebar, per-session) ────────────────────────────
  // These mirror the saved Settings order by default; the user can tweak
  // them per-session without affecting the saved Settings.
  let upCreateOrder  = ['megatools', 'megacmd'];                    // creation priority
  let upUploadOrder  = ['megatools', 'megacmd', 'rclone', 'browser'];// upload priority
  let upCreateForced = null;  // null = use order; string = force this tool
  let upUploadForced = null;
  let upReviewingRecovery = false;

  // Returns true when the effective upload tool is 'browser'.
  // Browser is suppressed entirely when "Create fresh account" is selected.
  function isBrowserUploadMode() {
    const strategy = document.querySelector('input[name="up-strategy"]:checked')?.value;
    if (strategy === 'fresh') return false;
    return upUploadForced === 'browser' ||
           (!upUploadForced && upUploadOrder[0] === 'browser');
  }

  // Hoisted so both initToolCfgUI and the IPC event handlers can call it.
  // upStartBtn is a const declared later in the same IIFE; the closure resolves it
  // lazily at call-time, so it's always available after the DOM refs are set up.
  let syncStartBtnLabel = () => {};

  function initToolCfgUI() {
    // ── Chip rendering ─────────────────────────────────────────────────────────
    // Chips serve double duty: priority mode (numbered, click promotes to #1)
    // and force mode (no numbers, exclusive selection like radio buttons).

    function renderChips(containerId, order, forceMode, forcedTool) {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = '';
      order.forEach((tool, i) => {
        const chip = document.createElement('button');
        if (forceMode) {
          chip.className = 'up-tool-chip force-mode' + (tool === forcedTool ? ' force-active' : '');
          chip.title = tool === 'browser'
            ? 'Browser has no backup tool'
            : tool === forcedTool
              ? `${toolDisplayName(tool)} — forced (only this tool will be used)`
              : `Click to force ${toolDisplayName(tool)}`;
          chip.textContent = toolDisplayName(tool);
        } else {
          chip.className = 'up-tool-chip' + (i === 0 ? ' chip-top' : '');
          chip.title = tool === 'browser'
            ? 'Browser has no backup tool'
            : i === 0
              ? `${toolDisplayName(tool)} — first priority`
              : `Click to promote ${toolDisplayName(tool)} to first priority`;
          const rank = document.createElement('span');
          rank.className = 'up-chip-rank';
          rank.textContent = i + 1;
          chip.appendChild(rank);
          chip.appendChild(document.createTextNode(toolDisplayName(tool)));
        }

        chip.addEventListener('click', () => {
          if (containerId === 'up-createChips') {
            if (forceMode) {
              upCreateForced = tool;
              renderChips('up-createChips', order, true, tool);
            } else {
              upCreateOrder = [tool, ...upCreateOrder.filter(t => t !== tool)];
              renderChips('up-createChips', upCreateOrder, false, null);
            }
          } else {
            if (forceMode) {
              upUploadForced = tool;
              renderChips('up-uploadChips', order, true, tool);
            } else {
              upUploadOrder = [tool, ...upUploadOrder.filter(t => t !== tool)];
              renderChips('up-uploadChips', upUploadOrder, false, null);
            }
            syncStartBtnLabel();
            upRenderStaging(); // refresh disabled state when browser toggled
          }
        });

        el.appendChild(chip);
      });
    }

    // Updates the Start button label to reflect whether browser mode is active.
    syncStartBtnLabel = function () {
      upStartBtn.textContent = isBrowserUploadMode() ? '🌐 Launch Browser' : '▶ Upload';
    };

    // Initial renders
    renderChips('up-createChips', upCreateOrder, false, null);
    renderChips('up-uploadChips', upUploadOrder, false, null);

    // ── Disclosure toggle ──────────────────────────────────────────────────────
    const toggle   = document.getElementById('up-toolToggle');
    const toolArea = document.getElementById('up-toolArea');
    let toolOpen   = false;
    toggle.addEventListener('click', () => {
      toolOpen = !toolOpen;
      toolArea.style.display = toolOpen ? 'flex' : 'none';
      toggle.classList.toggle('open', toolOpen);
    });

    // ── Strategy change → show/hide creation row + refresh upload chips ───────────
    // When "Create fresh account" is selected, browser is removed from the upload
    // chip list entirely (it can't work without existing credentials).
    function refreshUploadArea() {
      const strategy    = document.querySelector('input[name="up-strategy"]:checked')?.value;
      const createRow   = document.getElementById('up-toolCreateRow');
      const forceMode   = document.getElementById('up-uploadForceChk').checked;
      const freshSelected = strategy === 'fresh';

      if (createRow) createRow.style.display = freshSelected ? '' : 'none';

      // If browser was forced/first but strategy switched to fresh, clear it
      if (freshSelected && upUploadForced === 'browser') upUploadForced = null;

      // Build the visible chip list for the current state
      const baseOrder = freshSelected
        ? upUploadOrder.filter(t => t !== 'browser')
        : upUploadOrder;
        const forceList = freshSelected
        ? upUploadOrder.filter(t => t !== 'browser')
        : [...upUploadOrder];

      if (forceMode) {
        // If forced tool was browser and we're now on fresh, fall back to first available
        upUploadForced = upUploadForced || forceList[0];
        renderChips('up-uploadChips', forceList, true, upUploadForced);
      } else {
        renderChips('up-uploadChips', baseOrder, false, null);
      }

      syncStartBtnLabel();
      upRenderStaging();
    }
    document.querySelectorAll('input[name="up-strategy"]').forEach(r => {
      r.addEventListener('change', refreshUploadArea);
    });
    refreshUploadArea();

    // ── Force toggles ──────────────────────────────────────────────────────────
    document.getElementById('up-createForceChk').addEventListener('change', function () {
      if (this.checked) {
        upCreateForced = upCreateForced || upCreateOrder[0];
        renderChips('up-createChips', ['megatools', 'megacmd'], true, upCreateForced);
      } else {
        upCreateForced = null;
        renderChips('up-createChips', upCreateOrder, false, null);
      }
    });

    document.getElementById('up-uploadForceChk').addEventListener('change', function () {
      if (this.checked) {
        // Default forced tool to whatever is currently first in the order
        upUploadForced = upUploadForced || upUploadOrder[0];
      } else {
        upUploadForced = null;
      }
      refreshUploadArea();
    });

    // Expose renderChips so syncSidebarToolOrders can refresh after init
    window._renderToolChips = renderChips;
  }

  /** Called from init() after config is loaded — sync sidebar order with saved Settings. */
  function syncSidebarToolOrders(cfg) {
    if (cfg.toolOrderCreate && cfg.toolOrderCreate.length) {
      upCreateOrder = cfg.toolOrderCreate.filter(t => t === 'megatools' || t === 'megacmd');
      if (!upCreateOrder.length) upCreateOrder = ['megatools', 'megacmd'];
    }
    if (cfg.toolOrderUpload && cfg.toolOrderUpload.length) {
      // Strip any stale 'browser' entry from saved config, then always append it
      // at the end so it appears last in the priority list by default.
      upUploadOrder = [...cfg.toolOrderUpload.filter(t => t !== 'browser'), 'browser'];
    }
    // Re-render chips with synced order (renderChips is exposed after initToolCfgUI runs)
    if (window._renderToolChips) {
      window._renderToolChips('up-createChips', upCreateOrder, false, null);
      window._renderToolChips('up-uploadChips', upUploadOrder, false, null);
    }
  }

  // Expose so init() can call it
  window._syncSidebarToolOrders = syncSidebarToolOrders;

  // Expose so settings code outside this IIFE can update the per-page count
  window._setUpLinksPerPage = function (n) {
    upLinksPerPage = (Number.isFinite(n) && n >= 1) ? n : 25;
  };
  window._setUpAccountsPerPage = function (n) {
    upAccountsPerPage = (Number.isFinite(n) && n >= 1) ? n : 25;
  };
  window._setUpMediaInfoPerPage = function (n) {
    upMediaInfoPerPage = (Number.isFinite(n) && n >= 1) ? n : 25;
  };
  window._setUpImportsPerPage = function (n) {
    upImportsPerPage = (Number.isFinite(n) && n >= 1) ? n : 25;
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────────
  const upQueueList    = document.getElementById('up-queueList');
  const upQueueEmpty   = document.getElementById('up-queueEmpty');
  const upQueueCount   = document.getElementById('up-queueCount');
  const upManualPath   = document.getElementById('up-manualPath');
  const upLogEl        = document.getElementById('up-log');
  const upLogScroller  = document.getElementById('up-logScroller');
  const upProgFill     = document.getElementById('up-progFill');
  const upProgPct      = document.getElementById('up-progPct');
  const upStatIdx      = document.getElementById('up-statIdx');
  const upStatBytes    = document.getElementById('up-statBytes');
  const upStatSpeed    = document.getElementById('up-statSpeed');
  const upStartBtn     = document.getElementById('up-startBtn');
  const upKillBtn      = document.getElementById('up-killBtn');
  const upCloseBrowserBtn = document.getElementById('up-closeBrowserBtn');
  const upNewQueueBtn  = document.getElementById('up-newQueueBtn');

  // Dynamically-created button shown only during an active upload when files are staged.
  // Injects the currently staged files directly into the running engine queue.
  const upAddToQueueBtn = document.createElement('button');
  upAddToQueueBtn.className    = 'btn btn-accent btn-full';
  upAddToQueueBtn.textContent  = '➕ Add to Queue';
  upAddToQueueBtn.style.display = 'none';
  upStartBtn.insertAdjacentElement('afterend', upAddToQueueBtn);

  const upLinksList    = document.getElementById('up-linksList');
  const upLinksEmpty   = document.getElementById('up-linksEmpty');
  const upLinksPagination = document.getElementById('up-linksPagination');
  const upLinksPageInfo   = document.getElementById('up-linksPageInfo');
  const upLinksPrevBtn    = document.getElementById('up-linksPrevBtn');
  const upLinksNextBtn    = document.getElementById('up-linksNextBtn');
  const upImportsList       = document.getElementById('up-importedList');
  const upImportsEmpty      = document.getElementById('up-importedEmpty');
  const upImportsPagination = document.getElementById('up-importedPagination');
  const upImportsPageInfo   = document.getElementById('up-importedPageInfo');
  const upImportsPrevBtn    = document.getElementById('up-importedPrevBtn');
  const upImportsNextBtn    = document.getElementById('up-importedNextBtn');
  const upLiveList     = document.getElementById('up-liveQueueList');
  const upLiveEmpty    = document.getElementById('up-liveQueueEmpty');

  // ── Log ────────────────────────────────────────────────────────────────────────

  // Converts a formatted speed string back to raw bytes/s for stat tracking.
  // Handles "2.45 MiB/s", "512 KB/s", "1.1 GiB/s", "938 B/s", etc.
  // Returns 0 for unparseable or placeholder input ("...").
  function parseSpeedToBps(str) {
    if (!str || str === '...') return 0;
    const m = str.match(/([\d.]+)\s*([KMGT]?i?B)\/s/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    // Normalise: "KiB" → "K", "MiB" → "M", "KB" → "K", "MB" → "M", etc.
    const u = m[2].toUpperCase().replace(/IB$/, '').replace(/B$/, '') || 'B_PLAIN';
    const mul = {
      B_PLAIN: 1, B: 1,
      K: 1024,       KB: 1024,
      M: 1048576,    MB: 1048576,
      G: 1073741824, GB: 1073741824,
      T: 1099511627776, TB: 1099511627776,
    };
    return v * (mul[u] !== undefined ? mul[u] : 1);
  }

  function upLog(msg, cls) {
    const ph = upLogEl.querySelector('.log-empty');
    if (ph) ph.remove();
    const el = document.createElement('span');
    el.className = 'll ' + (cls || 'll-sys');
    el.textContent = msg;
    upLogEl.appendChild(el);
    upLogScroller.scrollTop = upLogScroller.scrollHeight;
  }

  // ── Staging (sidebar) render ───────────────────────────────────────────────────
  function upRenderStaging() {
    upQueueCount.textContent = upStaging.length;
    upQueueList.innerHTML = '';

    // Dim action buttons when there's nothing staged (and we're not mid-run)
    if (!upRunning) {
      const isEmpty = upStaging.length === 0;
      upStartBtn.disabled = isEmpty && !isBrowserUploadMode();
      document.getElementById('up-clearBtn').disabled = isEmpty;
      upAddToQueueBtn.style.display = 'none';
    } else {
      // During a run: show Add to Queue only when there's something new staged
      upAddToQueueBtn.style.display = upStaging.length > 0 ? '' : 'none';
    }

    if (upStaging.length === 0) {
      upQueueList.appendChild(upQueueEmpty);
      upQueueEmpty.style.display = '';
      return;
    }

    upStaging.forEach(item => {
      const el = document.createElement('div');
      el.className = 'q-item draggable';
      el.dataset.id = item.id;

      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.title = 'Drag to reorder';

      const dot = document.createElement('span');
      dot.className = 'q-dot';

      const info = document.createElement('div');
      info.className = 'q-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'q-url';
      nameEl.textContent = item.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'q-meta';
      metaEl.textContent = item.size ? fmtBytes(item.size) : 'Selected';
      info.appendChild(nameEl);
      info.appendChild(metaEl);

      const ctrl = document.createElement('div');
      ctrl.className = 'q-controls';
      const delBtn = document.createElement('button');
      delBtn.className = 'q-btn del';
      delBtn.title = 'Remove from selected';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        upStaging = upStaging.filter(i => i.id !== item.id);
        upRenderStaging();
      });
      ctrl.appendChild(delBtn);

      el.appendChild(handle);
      el.appendChild(dot);
      el.appendChild(info);
      el.appendChild(ctrl);

      // Drag-and-drop reorder
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        dragSrcId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => el.classList.add('dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging', 'drag-over');
        upQueueList.querySelectorAll('.q-item').forEach(r => r.classList.remove('drag-over'));
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragSrcId !== item.id) el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (dragSrcId === null || dragSrcId === item.id) return;
        const si = upStaging.findIndex(i => i.id === dragSrcId);
        const di = upStaging.findIndex(i => i.id === item.id);
        if (si === -1 || di === -1) return;
        const [moved] = upStaging.splice(si, 1);
        upStaging.splice(di, 0, moved);
        upRenderStaging();
        dragSrcId = null;
      });

      upQueueList.appendChild(el);
    });
  }

  // ── Live queue (center panel) render ──────────────────────────────────────────
  function upRenderLiveQueue() {
    // Preserve scroll position
    const scrollTop = upLiveList.parentElement ? upLiveList.parentElement.scrollTop : 0;
    upLiveList.innerHTML = '';

    if (liveQueue.length === 0) {
      upLiveList.appendChild(upLiveEmpty);
      upLiveEmpty.style.display = '';
      return;
    }
    upLiveEmpty.style.display = 'none';

    liveQueue.forEach(item => {
      const isActive    = item.status === 'uploading';
      const isDone      = item.status === 'done';
      const isFailed    = item.status === 'failed';
      const isCancelled = item.status === 'cancelled';
      const isPending   = item.status === 'pending';

      const el = document.createElement('div');
      el.className = 'lq-item' +
        (isActive    ? ' lq-active'    : '') +
        (isDone      ? ' lq-done'      : '') +
        (isFailed    ? ' lq-failed'    : '') +
        (isCancelled ? ' lq-cancelled' : '');
      el.dataset.id = item.id;

      // Icon
      const icon = document.createElement('span');
      icon.className = 'lq-icon';
      icon.textContent = isActive ? '↑' : isDone ? '✓' : isFailed ? '✕' : isCancelled ? '—' : '·';

      // Body: name row + optional progress bar
      const body = document.createElement('div');
      body.className = 'lq-body';

      const nameRow = document.createElement('div');
      nameRow.className = 'lq-name-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'lq-name';
      nameEl.textContent = item.name;
      nameEl.title = item.name;
      nameRow.appendChild(nameEl);

      if (isActive) {
        // Show how many bytes have been uploaded out of the total file size
        const uploadedEl = document.createElement('span');
        uploadedEl.className = 'lq-speed';
        uploadedEl.id = 'lq-uploaded-' + item.id;
        if (item.size) {
          const done = item.size * ((item.pct || 0) / 100);
          uploadedEl.textContent = fmtBytes(done) + ' / ' + fmtBytes(item.size);
        } else {
          uploadedEl.textContent = '—';
        }
        nameRow.appendChild(uploadedEl);
      }

      // File size — shown for pending/done/failed/cancelled states (not active, since active shows "X / total" above)
      if (item.size && !isActive) {
        const sizeEl = document.createElement('span');
        sizeEl.className = 'lq-speed';
        sizeEl.textContent = fmtBytes(item.size);
        nameRow.appendChild(sizeEl);
      }
      body.appendChild(nameRow);

      if (isActive) {
        const barWrap = document.createElement('div');
        barWrap.className = 'lq-bar-wrap';
        const barInner = document.createElement('div');
        barInner.className = 'lq-bar-inner';
        barInner.id = 'lq-bar-' + item.id;
        barInner.style.width = (item.pct || 0).toFixed(1) + '%';
        barWrap.appendChild(barInner);
        body.appendChild(barWrap);
      }

      if (isFailed && item.error) {
        const errEl = document.createElement('div');
        errEl.className = 'lq-error';
        errEl.textContent = item.error;
        body.appendChild(errEl);
      }

      // Controls
      const ctrl = document.createElement('div');
      ctrl.className = 'lq-ctrl';

      if (isActive) {
        const pctEl = document.createElement('span');
        pctEl.className = 'lq-pct';
        pctEl.id = 'lq-pct-' + item.id;
        pctEl.textContent = (item.pct || 0).toFixed(0) + '%';
        ctrl.appendChild(pctEl);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'q-btn del';
        cancelBtn.title = 'Cancel this file — queue continues';
        cancelBtn.textContent = '✕';
        cancelBtn.addEventListener('click', () => {
          window.api.cancelCurrentFile();
          item.status = 'cancelled'; // optimistic
          upRenderLiveQueue();
        });
        ctrl.appendChild(cancelBtn);

      } else if (isPending) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'q-btn del';
        removeBtn.title = 'Remove from queue';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => {
          window.api.skipPendingFile(item.name);
          item.status = 'cancelled'; // optimistic
          upRenderLiveQueue();
        });
        ctrl.appendChild(removeBtn);
      }

      // ── Drag-to-reorder for pending items ──────────────────────────────────
      let dragHandle = null;
      if (isPending) {
        dragHandle = document.createElement('span');
        dragHandle.className = 'lq-drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'Drag to reorder';

        el.draggable = true;
        el.addEventListener('dragstart', e => {
          lqDragSrcId = item.id;
          e.dataTransfer.effectAllowed = 'move';
          setTimeout(() => el.classList.add('lq-dragging'), 0);
        });
        el.addEventListener('dragend', () => {
          el.classList.remove('lq-dragging', 'lq-drag-over');
          upLiveList.querySelectorAll('.lq-item').forEach(r => r.classList.remove('lq-drag-over'));
          lqDragSrcId = null;
        });
        el.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (lqDragSrcId !== null && lqDragSrcId !== item.id) {
            el.classList.add('lq-drag-over');
          }
        });
        el.addEventListener('dragleave', () => el.classList.remove('lq-drag-over'));
        el.addEventListener('drop', e => {
          e.preventDefault();
          el.classList.remove('lq-drag-over');
          if (lqDragSrcId === null || lqDragSrcId === item.id) return;
          const si = liveQueue.findIndex(i => i.id === lqDragSrcId);
          const di = liveQueue.findIndex(i => i.id === item.id);
          if (si === -1 || di === -1) return;
          const [moved] = liveQueue.splice(si, 1);
          liveQueue.splice(di, 0, moved);
          upRenderLiveQueue();
          lqDragSrcId = null;
          // Tell main process about the new order so uploads follow it
          const pendingOrder = liveQueue
            .filter(i => i.status === 'pending')
            .map(i => i.name);
          window.api.reorderQueue(pendingOrder);
        });
      }

      if (dragHandle) el.appendChild(dragHandle);
      el.appendChild(icon);
      el.appendChild(body);
      el.appendChild(ctrl);
      upLiveList.appendChild(el);
    });

    if (upLiveList.parentElement) upLiveList.parentElement.scrollTop = scrollTop;
  }

  // ── Add paths to staging ───────────────────────────────────────────────────────
  async function addToUpStaging(paths) {
    let added = 0;
    const newPaths = paths.filter(p => !upStaging.some(i => i.path === p));
    // Fetch file sizes for newly-added paths in one IPC round-trip
    let sizeMap = {};
    if (newPaths.length > 0) {
      try { sizeMap = await window.api.getFileSizes(newPaths); } catch { /* non-fatal */ }
    }
    newPaths.forEach(p => {
      const name = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p;
      upStaging.push({ id: upStagingId++, path: p, name, size: sizeMap[p] || 0 });
      added++;
    });
    upRenderStaging();
    return added;
  }

  // ── Browse / path-entry buttons ────────────────────────────────────────────────
  document.getElementById('up-browseFiles').addEventListener('click', async () => {
    const paths = await window.api.selectFiles();
    if (paths.length) {
      const n = await addToUpStaging(paths);
      if (n === 0) upLog('All selected files are already staged.', 'll-notice');
    }
  });

  document.getElementById('up-browseFolder').addEventListener('click', async () => {
    const paths = await window.api.uploadSelectFolder();
    if (paths.length) await addToUpStaging(paths);
  });

  document.getElementById('up-addPath').addEventListener('click', async () => {
    const raw = upManualPath.value.trim();
    if (!raw) return;
    const paths = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const n = await addToUpStaging(paths);
    upLog(`Added ${n} item(s) to staging.${n < paths.length ? ` (${paths.length - n} already staged)` : ''}`);
    upManualPath.value = '';
  });

  document.getElementById('up-clearBtn').addEventListener('click', () => {
    if (upRunning) { upLog('Upload is running — cannot clear selection.', 'll-notice'); return; }
    upStaging = [];
    upRenderStaging();
  });

  // ── Inject staged files into the running engine queue ─────────────────────────
  async function injectStagedFiles() {
    if (!upRunning || upStaging.length === 0) return;
    const toInject = [...upStaging];
    const paths    = toInject.map(i => i.path);
    let added = 0;
    try { added = await window.api.addToUploadQueue(paths); } catch { /* non-fatal */ }
    if (added === 0) { upLog('Could not add files to the running queue.', 'll-notice'); return; }
    // Mirror all staged items in the live queue as pending (folders appear as one entry,
    // just like they do when starting an upload — up:status drives per-file updates).
    toInject.forEach(i => {
      liveQueue.push({ id: i.id, name: i.name, size: i.size || 0, status: 'pending', pct: 0, speed: '', error: '' });
    });
    upStaging = [];
    upRenderStaging();
    upRenderLiveQueue();
    upLog(`➕ Added ${added} file(s) to the running queue.`, 'll-sys');
  }
  upAddToQueueBtn.addEventListener('click', injectStagedFiles);

  // ── Reset the live queue panel back to a clean slate ─────────────────────────
  function resetUploadUI() {
    liveQueue      = [];
    _upCurrentIdx  = 0;
    _upTotalFiles  = 0;
    upRunning = false;
    upRenderLiveQueue();
    upProgFill.style.width = '0%';
    upProgPct.textContent  = '—%';
    upStatSpeed.textContent = '— B/s';
    upStatIdx.textContent   = '';
    upStatBytes.textContent = '';
    const fileNameEl = document.getElementById('up-statFileName');
    if (fileNameEl) fileNameEl.textContent = 'Idle — add files to the queue and press Start Engine';
    upStartBtn.style.display    = '';
    upStartBtn.disabled         = false;
    upKillBtn.style.display     = 'none';
    upNewQueueBtn.style.display = 'none';
    // Hide header account widget and folder bar
    document.getElementById('hdrAccountWidget').classList.remove('visible');
    document.getElementById('up-folderBar').classList.remove('visible');
    // Re-sync button states based on current staging queue
    upRenderStaging();
    upSyncLogVsDrop();
  }

  // ── Kill Queue — stops current file and drains everything pending ─────────────
  upKillBtn.addEventListener('click', () => {
    if (!confirm('Stop the current upload and cancel all pending files?')) return;
    window.api.killQueue();
    // Optimistically mark all pending items cancelled in the renderer;
    // up:fileSkipped will fire for the active file once the process dies.
    liveQueue.forEach(i => { if (i.status === 'pending') i.status = 'cancelled'; });
    upRenderLiveQueue();
    upLog('Queue killed by user.', 'll-notice');
    // upRunning + button states are cleaned up when up:complete arrives
  });

  // ── Close Browser — closes the Puppeteer window launched by browser mode ──────
  upCloseBrowserBtn.addEventListener('click', () => {
    window.api.closeMegaBrowser();
    upLog('Closing browser…', 'll-notice');
    // UI cleanup happens when up:browserClosed fires from main
  });

  // ── New Queue — wipe live queue display so a fresh run can be staged ─────────
  upNewQueueBtn.addEventListener('click', resetUploadUI);

  // ── Resume preview — load last account info and show under the radio ─────────
  async function upLoadResumePreview() {
    const preview  = document.getElementById('up-resumePreview');
    const emailEl  = document.getElementById('up-resumeEmail');
    const barFill  = document.getElementById('up-resumeBarFill');
    const usageEl  = document.getElementById('up-resumeUsage');
    if (!preview) return;
    try {
      const accounts = await window.api.readAccountsFile(); // newest first
      if (!accounts || accounts.length === 0) {
        emailEl.textContent = 'No accounts on record yet';
        barFill.style.width = '0%';
        usageEl.textContent = '— / 20 GB';
        return;
      }
      const acc   = accounts[0];
      const usedGb = parseFloat(acc.bandwidth) || 0;
      const pct    = Math.min((usedGb / 20) * 100, 100);
      emailEl.textContent = acc.email || '—';
      barFill.style.width = pct.toFixed(1) + '%';
      barFill.className   = 'hdr-acc-bar-fill' + (pct >= 90 ? ' bar-danger' : pct >= 70 ? ' bar-warn' : '');
      usageEl.textContent = usedGb.toFixed(2) + ' / 20 GB';
    } catch {
      emailEl.textContent = 'Could not read account log';
      barFill.style.width = '0%';
      usageEl.textContent = '— / 20 GB';
    }
  }

  // Show/hide preview depending on selected strategy
  function upSyncResumePreview() {
    const strategy = document.querySelector('input[name="up-strategy"]:checked')?.value;
    const preview  = document.getElementById('up-resumePreview');
    if (!preview) return;
    if (strategy === 'resume') {
      preview.style.display = 'flex';
      upLoadResumePreview();
    } else {
      preview.style.display = 'none';
    }
  }

  document.querySelectorAll('input[name="up-strategy"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.getElementById('up-manualLoginFields').style.display =
        radio.value === 'manual' && radio.checked ? 'flex' : 'none';
      upSyncResumePreview();
    });
  });

  // Run once on load so the preview is populated immediately
  upSyncResumePreview();

  // ── Confirm & Start ────────────────────────────────────────────────────────────
  upStartBtn.addEventListener('click', async () => {
    const strategy       = document.querySelector('input[name="up-strategy"]:checked').value;

    // ── Browser mode — launch Puppeteer, log in, hand over to user ──────────────
    if (isBrowserUploadMode()) {
      if (upRunning) { upLog('Browser is already running.', 'll-notice'); return; }

      let email = '', password = '';

      if (strategy === 'fresh') {
        upLog('Browser mode cannot create a fresh account. Select Manual Login or Resume last account.', 'll-error');
        return;
      }
      if (strategy === 'manual') {
        email    = document.getElementById('up-manualEmail').value.trim();
        password = document.getElementById('up-manualPassword').value.trim();
        if (!email || !password) {
          upLog('Manual login: please enter both email and password.', 'll-error');
          return;
        }
      } else if (strategy === 'resume') {
        try {
          const accounts = await window.api.readAccountsFile();
          if (!accounts || accounts.length === 0) {
            upLog('No accounts on record — switch to Manual Login and enter credentials.', 'll-error');
            return;
          }
          email    = accounts[0].email;
          password = accounts[0].password;
        } catch {
          upLog('Could not read account log — switch to Manual Login.', 'll-error');
          return;
        }
      }

      upRunning = true;
      showSubtab('progress');
      upSyncLogVsDrop();
      upStartBtn.disabled      = true;
      upStartBtn.style.display = 'none';
      upKillBtn.style.display  = 'none';
      upCloseBrowserBtn.style.display = '';

      upLog(`Launching browser${email ? ' for ' + email : ''}…`);
      window.api.openMegaBrowser({ email, password });
      return;
    }

    // ── Normal upload mode ──────────────────────────────────────────────────────
    if (upStaging.length === 0) { upLog('Nothing selected — add files on the left first.'); return; }
    if (upRunning) { upLog('Upload already running.', 'll-notice'); return; }

    const resumeAccount  = strategy === 'resume';
    const manualEmail    = strategy === 'manual' ? document.getElementById('up-manualEmail').value.trim() : '';
    const manualPassword = strategy === 'manual' ? document.getElementById('up-manualPassword').value.trim() : '';
    if (strategy === 'manual' && (!manualEmail || !manualPassword)) {
      upLog('Manual login: please enter both email and password.', 'll-error');
      return;
    }

    if (upReviewingRecovery) return;
    upReviewingRecovery = true;
    try {
      const review = await window.api.reviewUploadRecovery();
      if (!review.ok) { upLog(review.error, 'll-notice'); return; }
    } catch { upLog('Could not verify interrupted-upload recovery. Uploads remain paused.', 'll-error'); return; }
    finally { upReviewingRecovery = false; }
    if (upRunning) return;

    // Snapshot staging → liveQueue, then clear staging so the sidebar is empty
    const toUpload = [...upStaging];
    liveQueue = toUpload.map(i => ({ id: i.id, name: i.name, size: i.size || 0, status: 'pending', pct: 0, speed: '', error: '' }));
    upStaging = [];
    upRenderStaging();
    upRenderLiveQueue();

    showSubtab('progress');

    upRunning = true;
    upSyncLogVsDrop();
    upStartBtn.disabled         = true;
    upStartBtn.style.display    = 'none';
    upKillBtn.style.display     = '';
    upNewQueueBtn.style.display = 'none';
    upProgFill.style.width = '0%';
    upProgPct.textContent  = '0%';
    // Grey out refresh buttons while an upload is in progress
    const _rAll = document.getElementById('btn-refreshAll');
    const _rInc = document.getElementById('btn-refreshInactive');
    if (_rAll) _rAll.disabled = true;
    if (_rInc) _rInc.disabled = true;
    const _rBat = document.getElementById('btn-refreshDormantBatch');
    if (_rBat) _rBat.disabled = true;

    const folderName = document.getElementById('up-folderName').value.trim() || 'folder';
    // Effective tool orders: forced = single-element array; else full priority order
    const createToolOrder = upCreateForced ? [upCreateForced] : [...upCreateOrder];
    const uploadToolOrder = upUploadForced ? [upUploadForced] : [...upUploadOrder];
    // Mark the start of this upload session for the completion report
    _upSessStartTime     = Date.now();
    _upSessPeakBps       = 0;
    _upSessMinBps        = Infinity;
    _upSessSpeedSamples  = [];
    _upFileWarmupEndTime = 0;

    window.api.startUpload({
      queue: toUpload.map(i => i.path),
                           resumeAccount, manualEmail, manualPassword, folderName,
                           createToolOrder, uploadToolOrder,
                           smartOrderingEnabled: !!(document.getElementById('up-smartOrdering')?.checked),
    });
  });

  document.getElementById('up-clearLogBtn').addEventListener('click', () => {
    upLogEl.innerHTML = '';
    upSyncLogVsDrop();
  });

  // ── Drop zone vs log switching ─────────────────────────────────────────────────
  // Show the drop zone when nothing has been logged and no upload is running.
  // Once an upload starts (or log has content), the log takes over. The drop zone
  // returns only when the log is cleared and no upload is pending.
  function upSyncLogVsDrop() {
    const dropZone = document.getElementById('up-dropZone');
    const logWrap  = document.getElementById('up-logWrap');
    if (!dropZone || !logWrap) return;
    const logHasContent = upLogEl.children.length > 0 &&
      !upLogEl.querySelector('.log-empty');
    const showLog = upRunning || logHasContent;
    dropZone.style.display = showLog ? 'none' : 'flex';
    logWrap.style.display  = showLog ? ''     : 'none';
  }

  // ── Drop zone drag-and-drop handlers ──────────────────────────────────────────
  // Prevent Electron's default behaviour of navigating to dropped files.
  // Without this the drop is rejected at the window level before our zone sees it.
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop',     e => e.preventDefault());

  (function () {
    const zone = document.getElementById('up-dropZone');
    if (!zone) return;

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      zone.style.borderColor = 'var(--accent)';
      zone.style.background  = 'var(--surface2)';
    });

    zone.addEventListener('dragleave', e => {
      e.preventDefault();
      e.stopPropagation();
      zone.style.borderColor = '';
      zone.style.background  = '';
    });

    zone.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      zone.style.borderColor = '';
      zone.style.background  = '';

      const paths = Array.from(e.dataTransfer.files)
        .map(f => window.api.getPathForFile(f))
        .filter(Boolean);

      if (!paths.length) return;
      await addToUpStaging(paths);
    });
  })();

  // ── Copy helper ────────────────────────────────────────────────────────────────
  function makeCopyField(el, value, originalText) {
    el.title = 'Click to copy';
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(value).catch(() => {});
      el.textContent = '✓ Copied';
      el.classList.add('copied');
      setTimeout(() => { el.textContent = originalText; el.classList.remove('copied'); }, 1400);
    });
  }

  function formatBytes(raw) {
    if (!raw) return '';
    if (typeof raw === 'string' && /[A-Za-z]/.test(raw)) return raw;
    const n = parseInt(raw, 10);
    if (!n || isNaN(n)) return '';
    const units = ['B','KiB','MiB','GiB','TiB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 2) + '\u202F' + units[i];
  }

  function buildLinkItem({ name, link, size, email, password, folderLink, folderName, lastLogin }) {
    const li = document.createElement('li');
    li.className = 'up-link-item has-chk';
    li.dataset.link = link;

    // Checkbox
    const chkWrap = document.createElement('div'); chkWrap.className = 'up-li-chk-wrap';
    const chk     = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'up-li-chk';
    chk.checked   = _selectedLinks.has(link);
    if (chk.checked) li.classList.add('selected');
    chk.addEventListener('change', () => toggleLinkSelection(link, li, chk));
    chkWrap.appendChild(chk);
    li.appendChild(chkWrap);

    // Store this link's data in the lookup map
    const sizeStr_  = formatBytes(size);
    _linkDataMap.set(link, { name, link, size: sizeStr_ || size || '', email: email || '', password: password || '', folderLink: folderLink || '', lastLogin: lastLogin || '' });

    const nameEl   = document.createElement('span'); nameEl.className   = 'up-li-name';   nameEl.textContent  = name;
    const sizeStr  = sizeStr_;
    const sizeEl   = document.createElement('span'); sizeEl.className   = 'up-li-size';   sizeEl.textContent  = sizeStr || '—';
    const linkEl   = document.createElement('span'); linkEl.className   = 'up-li-link';   linkEl.textContent  = link;

    const folderEl = document.createElement('span'); folderEl.className = 'up-li-folder';
    const folderPrefix = folderName ? folderName + ' ' : '';
    if (folderLink) {
      folderEl.textContent = folderPrefix + '📁 ' + folderLink;
      makeCopyField(folderEl, folderLink, folderPrefix + '📁 ' + folderLink);
    } else {
      folderEl.style.cursor = 'default';
      const folderPlaceholder = document.createElement('span');
      folderPlaceholder.textContent = folderPrefix + '📁 —';
      folderEl.appendChild(folderPlaceholder);

      const getFolderLinkBtn = document.createElement('button');
      getFolderLinkBtn.className = 'btn btn-ghost btn-sm';
      getFolderLinkBtn.textContent = '🔗';
      getFolderLinkBtn.title = 'Generate and save a folder link for this file';
      getFolderLinkBtn.style.marginLeft = '6px';
      getFolderLinkBtn.addEventListener('click', async () => {
        getFolderLinkBtn.disabled = true;
        getFolderLinkBtn.textContent = '⏳';
        try {
          const result = await window.api.generateFolderLink({ name, link, email, password });
          if (result && result.ok) {
            // Replace folderEl contents with the live, copyable link
            while (folderEl.firstChild) folderEl.removeChild(folderEl.firstChild);
            folderEl.style.cursor = '';
            folderEl.textContent = folderPrefix + '📁 ' + result.folderLink;
            makeCopyField(folderEl, result.folderLink, folderPrefix + '📁 ' + result.folderLink);
            // Keep the in-memory data map in sync so Post/Title templates pick up the new link
            const cached = _linkDataMap.get(link);
            if (cached) cached.folderLink = result.folderLink;
          } else {
            getFolderLinkBtn.disabled = false;
            getFolderLinkBtn.textContent = '⚠';
            getFolderLinkBtn.title = (result && result.error) || 'Failed to generate folder link';
            setTimeout(() => {
              getFolderLinkBtn.textContent = '🔗';
              getFolderLinkBtn.title = 'Generate and save a folder link for this file';
            }, 4000);
          }
        } catch (e) {
          getFolderLinkBtn.disabled = false;
          getFolderLinkBtn.textContent = '⚠';
          getFolderLinkBtn.title = e.message || 'Unknown error';
          setTimeout(() => {
            getFolderLinkBtn.textContent = '🔗';
            getFolderLinkBtn.title = 'Generate and save a folder link for this file';
          }, 4000);
        }
      });
      folderEl.appendChild(getFolderLinkBtn);
    }

    const emailEl  = document.createElement('span'); emailEl.className  = 'up-li-email';  emailEl.textContent = email    || '—';
    const passEl   = document.createElement('span'); passEl.className   = 'up-li-pass';   passEl.textContent  = password || '—';

    makeCopyField(nameEl,  name,              name);
    makeCopyField(sizeEl,  sizeStr || size,   sizeStr || '—');
    makeCopyField(linkEl,  link,              link);
    makeCopyField(emailEl, email,             email    || '—');
    makeCopyField(passEl,  password,          password || '—');

    // ── Post button row ────────────────────────────────────────────────────────
    const actionsEl = document.createElement('div');
    actionsEl.className = 'up-li-actions';

    const postBtn = document.createElement('button');
    postBtn.className = 'btn-post';
    postBtn.textContent = '📋 Post';
    postBtn.title = 'Copy post text to clipboard using your template';

    postBtn.addEventListener('click', async () => {
      // fileData object for template substitution
      const fileData = { name, link, size: sizeStr || size || '', email, password, folderLink, lastLogin: lastLogin || '' };

      // Try to find matching mediainfo record from the log
      let miText = '';
      try {
        const records = await window.api.readMediaInfo();
        // Match by fileLink first, fall back to fileName
        const record = records.find(r => r.fileLink === link) || records.find(r => r.fileName === name);
        if (record && typeof record.mediainfo === 'string') {
          miText = record.mediainfo;
        }
      } catch { /* non-fatal — proceed without mediainfo */ }

      // Pull cached OMDB data (set by the 🎬 OMDB search row below)
      const omdbData = omdbCache.get(link) || null;

      const text = renderPostTemplate(postTemplate, fileData, miText, omdbData);

      try {
        await navigator.clipboard.writeText(text);
        postBtn.textContent = '✓ Copied!';
        postBtn.classList.add('copied');
        setTimeout(() => {
          postBtn.textContent = '📋 Post';
          postBtn.classList.remove('copied');
        }, 2000);
      } catch { /* non-fatal */ }
    });

    actionsEl.appendChild(postBtn);

    // ── Title button ───────────────────────────────────────────────────────────
    const titleBtn = document.createElement('button');
    titleBtn.className = 'btn-post';
    titleBtn.textContent = '📋 Title';
    titleBtn.title = 'Copy formatted title to clipboard using your title template';

    titleBtn.addEventListener('click', async () => {
      const fileData = { name, link, size: sizeStr || size || '', email, password, folderLink, lastLogin: lastLogin || '' };

      let miText = '';
      try {
        const records = await window.api.readMediaInfo();
        const record = records.find(r => r.fileLink === link) || records.find(r => r.fileName === name);
        if (record && typeof record.mediainfo === 'string') miText = record.mediainfo;
      } catch { /* non-fatal */ }

      const omdbData = omdbCache.get(link) || null;
      const text = renderPostTemplate(titleTemplate, fileData, miText, omdbData);

      try {
        await navigator.clipboard.writeText(text);
        titleBtn.textContent = '✓ Copied!';
        titleBtn.classList.add('copied');
        setTimeout(() => { titleBtn.textContent = '📋 Title'; titleBtn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });

    actionsEl.appendChild(titleBtn);

    // ── Mediainfo panel (collapsed by default) ─────────────────────────────────
    const miPanel = document.createElement('div');
    miPanel.className = 'up-li-mi-panel';

    const miPanelHeader = document.createElement('div');
    miPanelHeader.className = 'up-li-mi-panel-header';

    const miPanelLabel = document.createElement('span');
    miPanelLabel.className = 'up-li-mi-panel-label';
    miPanelLabel.textContent = 'MediaInfo';

    const miPanelPre = document.createElement('pre');
    miPanelPre.className = 'mi-text-body';

    const miCopyBtn = document.createElement('button');
    miCopyBtn.className = 'btn-post';
    miCopyBtn.textContent = '📋 Copy';
    miCopyBtn.title = 'Copy full mediainfo to clipboard';
    miCopyBtn.style.display = 'none';
    miCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(miPanelPre.textContent);
        miCopyBtn.textContent = '✓ Copied!';
        miCopyBtn.classList.add('copied');
        setTimeout(() => { miCopyBtn.textContent = '📋 Copy'; miCopyBtn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });

    miPanelHeader.appendChild(miPanelLabel);
    miPanelHeader.appendChild(miCopyBtn);
    miPanel.appendChild(miPanelHeader);
    miPanel.appendChild(miPanelPre);

    // ── Mediainfo toggle — center of the actions row ───────────────────────────
    const miCenterEl = document.createElement('span');
    miCenterEl.style.cssText = 'flex:1;display:flex;justify-content:center';

    const miBtn = document.createElement('button');
    miBtn.className = 'btn-post';
    miBtn.textContent = 'Mediainfo ▶';
    miBtn.title = 'Show/hide mediainfo for this file';

    let miLoaded = false;
    miBtn.addEventListener('click', async () => {
      const isOpen = miPanel.classList.contains('open');
      if (isOpen) {
        miPanel.classList.remove('open');
        miBtn.textContent = 'Mediainfo ▶';
        return;
      }
      miPanel.classList.add('open');
      miBtn.textContent = 'Mediainfo ▼';
      if (miLoaded) return;
      miLoaded = true;
      miPanelPre.textContent = 'Loading…';
      try {
        const records = await window.api.readMediaInfo();
        const record  = records.find(r => r.fileLink === link) || records.find(r => r.fileName === name);
        if (record && typeof record.mediainfo === 'string' && record.mediainfo.trim()) {
          miPanelPre.textContent = record.mediainfo.trim();
          miCopyBtn.style.display = '';
        } else {
          miPanelPre.textContent = 'No mediainfo available for this file.';
        }
      } catch {
        miPanelPre.textContent = 'Failed to load mediainfo.';
      }
    });

    miCenterEl.appendChild(miBtn);
    actionsEl.appendChild(miCenterEl);

    // Delete button — removes this entry from upload_log.csv
    const deleteLinkBtn = document.createElement('button');
    deleteLinkBtn.className = 'btn-post';
    deleteLinkBtn.textContent = '🗑 Delete';
    deleteLinkBtn.title = 'Remove this entry from upload_log.csv';
    deleteLinkBtn.addEventListener('click', async () => {
      if (deleteLinkBtn.dataset.confirm !== 'yes') {
        deleteLinkBtn.dataset.confirm = 'yes';
        deleteLinkBtn.textContent = 'Sure? Click again';
        deleteLinkBtn.style.cssText = 'background:var(--danger,#ef4444);color:#fff';
        setTimeout(() => {
          if (deleteLinkBtn.dataset.confirm === 'yes') {
            deleteLinkBtn.dataset.confirm = '';
            deleteLinkBtn.textContent = '🗑 Delete';
            deleteLinkBtn.style.cssText = '';
          }
        }, 3000);
        return;
      }
      const result = await window.api.deleteLinkRow({ name, link });
      if (result && result.ok) {
        li.remove();
      } else {
        deleteLinkBtn.textContent = '⚠ Error';
        setTimeout(() => { deleteLinkBtn.textContent = '🗑 Delete'; }, 2000);
      }
    });
    actionsEl.appendChild(deleteLinkBtn);

    // ── OMDB search row ────────────────────────────────────────────────────────
    // Lets the user look up a title by IMDB ID or keyword search, then stores
    // the API response in omdbCache so the Post button can substitute {{OMDB …}}
    // variables in the template.
    const omdbEl = document.createElement('div');
    omdbEl.className = 'up-li-omdb';

    const omdbLabelEl = document.createElement('span');
    omdbLabelEl.className = 'up-li-omdb-label';
    omdbLabelEl.textContent = '🎬 OMDB';

    const omdbRowEl = document.createElement('div');
    omdbRowEl.className = 'up-li-omdb-row';

    const omdbInput = document.createElement('input');
    omdbInput.type = 'text';
    omdbInput.className = 'up-li-omdb-input';
    omdbInput.placeholder = 'IMDB ID (tt1234567) or title search…';

    const omdbSearchBtn = document.createElement('button');
    omdbSearchBtn.className = 'btn btn-ghost btn-sm';
    omdbSearchBtn.textContent = '🔍';
    omdbSearchBtn.title = 'Search OMDB';

    const omdbResultsEl = document.createElement('div');
    omdbResultsEl.className = 'up-li-omdb-results';

    const omdbSelectedEl = document.createElement('div');
    omdbSelectedEl.className = 'up-li-omdb-selected';

    // If the user already has OMDB data cached for this link, show the title immediately
    if (omdbCache.has(link)) {
      const cached = omdbCache.get(link);
      omdbSelectedEl.textContent = `✓ ${cached.Title} (${cached.Year})`;
      omdbSelectedEl.classList.add('visible');
    }

    // Helper: fetch details for a specific IMDB ID and cache the result
    async function selectOmdbTitle(imdbId, displayName) {
      omdbSearchBtn.disabled = true;
      omdbSearchBtn.textContent = '⏳';
      omdbResultsEl.classList.remove('open');
      try {
        const data = await window.api.omdbGet(imdbId);
        if (data && data.Response !== 'False') {
          omdbCache.set(link, data);
          omdbSelectedEl.textContent = `✓ ${data.Title} (${data.Year})`;
          omdbSelectedEl.classList.add('visible');
          omdbInput.value = '';
        } else {
          omdbSelectedEl.textContent = `⚠ ${data.Error || 'Not found'}`;
          omdbSelectedEl.classList.add('visible');
        }
      } catch (err) {
        omdbSelectedEl.textContent = `⚠ ${err.message || 'Lookup failed'}`;
        omdbSelectedEl.classList.add('visible');
      } finally {
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
      }
    }

    // Search handler — detects whether input looks like an IMDB ID (tt…) or a keyword
    async function runOmdbSearch() {
      const query = omdbInput.value.trim();
      if (!query) return;

      // Direct IMDB ID or URL — skip the search step
      const imdbIdMatch = query.match(/tt\d+/);
      if (imdbIdMatch) {
        await selectOmdbTitle(imdbIdMatch[0], imdbIdMatch[0]);
        return;
      }

      // Keyword search
      omdbSearchBtn.disabled = true;
      omdbSearchBtn.textContent = '⏳';
      omdbResultsEl.innerHTML = '';
      omdbResultsEl.classList.remove('open');
      try {
        const data = await window.api.omdbSearch(query);
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
        if (!data || data.Response === 'False') {
          const noEl = document.createElement('div');
          noEl.className = 'up-li-omdb-result';
          noEl.style.color = 'var(--text3)';
          noEl.textContent = data.Error || 'No results found.';
          omdbResultsEl.appendChild(noEl);
          omdbResultsEl.classList.add('open');
          return;
        }
        const results = (data.Search || []).slice(0, 10);
        results.forEach(item => {
          const row = document.createElement('div');
          row.className = 'up-li-omdb-result';
          row.innerHTML = `${item.Title} <span style="color:var(--text3)">(${item.Year})</span><span class="omdb-type">${item.Type}</span>`;
          row.title = item.imdbID;
          row.addEventListener('click', () => selectOmdbTitle(item.imdbID, `${item.Title} (${item.Year})`));
          omdbResultsEl.appendChild(row);
        });
        omdbResultsEl.classList.add('open');
      } catch (err) {
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
        omdbSelectedEl.textContent = `⚠ ${err.message || 'Search failed'}`;
        omdbSelectedEl.classList.add('visible');
      }
    }

    omdbSearchBtn.addEventListener('click', runOmdbSearch);
    omdbInput.addEventListener('keydown', e => { if (e.key === 'Enter') runOmdbSearch(); });

    // Clicking outside the results list closes it
    document.addEventListener('click', e => {
      if (!omdbEl.contains(e.target)) omdbResultsEl.classList.remove('open');
    }, { passive: true });

    omdbRowEl.appendChild(omdbLabelEl);
    omdbRowEl.appendChild(omdbInput);
    omdbRowEl.appendChild(omdbSearchBtn);
    omdbEl.appendChild(omdbRowEl);
    // omdbEl.appendChild(omdbResultsEl);
    omdbEl.appendChild(omdbSelectedEl);

    li.appendChild(nameEl); li.appendChild(sizeEl); li.appendChild(linkEl);
    li.appendChild(folderEl);
    li.appendChild(emailEl); li.appendChild(passEl);
    li.appendChild(actionsEl);
    li.appendChild(miPanel);
    li.appendChild(omdbEl);
    return li;
  }

  // ── Imported Links row builder ──────────────────────────────────────────────────
  // Mirrors buildLinkItem() above, minus the MediaInfo toggle/panel and the
  // folder-link element — import_log.csv has no folder-link column and no
  // mediainfo is captured for imported files.
  function buildImportItem({ name, link, size, email, password, folderLink, importDate, folderName }) {
    const li = document.createElement('li');
    li.className = 'up-link-item has-chk';
    li.dataset.link = link;

    // Checkbox
    const chkWrap = document.createElement('div'); chkWrap.className = 'up-li-chk-wrap';
    const chk     = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'up-li-chk';
    chk.checked   = _selectedImports.has(link);
    if (chk.checked) li.classList.add('selected');
    chk.addEventListener('change', () => toggleImportSelection(link, li, chk));
    chkWrap.appendChild(chk);
    li.appendChild(chkWrap);

    // Store this import's data in the lookup map
    const sizeStr_ = formatBytes(size);
    _importDataMap.set(link, { name, link, size: sizeStr_ || size || '', email: email || '', password: password || '', folderLink: folderLink || '', importDate: importDate || '' });

    const nameEl  = document.createElement('span'); nameEl.className  = 'up-li-name';  nameEl.textContent  = name;
    const sizeStr = sizeStr_;
    const sizeEl  = document.createElement('span'); sizeEl.className  = 'up-li-size';  sizeEl.textContent  = sizeStr || '—';
    const linkEl  = document.createElement('span'); linkEl.className  = 'up-li-link';  linkEl.textContent  = link;
    const emailEl = document.createElement('span'); emailEl.className = 'up-li-email'; emailEl.textContent = email    || '—';
    const passEl  = document.createElement('span'); passEl.className  = 'up-li-pass';  passEl.textContent  = password || '—';

    // Folder link — mirrors buildLinkItem()'s folderEl: shows the live,
    // copyable folder link if one has been generated, otherwise shows a
    // placeholder plus a button to generate and save one.
    const folderEl = document.createElement('span'); folderEl.className = 'up-li-folder';
    const folderPrefix = folderName ? folderName + ' ' : '';
    if (folderLink) {
      folderEl.textContent = folderPrefix + '📁 ' + folderLink;
      makeCopyField(folderEl, folderLink, folderPrefix + '📁 ' + folderLink);
    } else {
      folderEl.style.cursor = 'default';
      const folderPlaceholder = document.createElement('span');
      folderPlaceholder.textContent = folderPrefix + '📁 —';
      folderEl.appendChild(folderPlaceholder);

      const getFolderLinkBtn = document.createElement('button');
      getFolderLinkBtn.className = 'btn btn-ghost btn-sm';
      getFolderLinkBtn.textContent = '🔗';
      getFolderLinkBtn.title = 'Generate and save a folder link for this file';
      getFolderLinkBtn.style.marginLeft = '6px';
      getFolderLinkBtn.addEventListener('click', async () => {
        getFolderLinkBtn.disabled = true;
        getFolderLinkBtn.textContent = '⏳';
        try {
          const result = await window.api.generateImportFolderLink({ name, link, email, password });
          if (result && result.ok) {
            // Replace folderEl contents with the live, copyable link
            while (folderEl.firstChild) folderEl.removeChild(folderEl.firstChild);
            folderEl.style.cursor = '';
            folderEl.textContent = folderPrefix + '📁 ' + result.folderLink;
            makeCopyField(folderEl, result.folderLink, folderPrefix + '📁 ' + result.folderLink);
            // Keep the in-memory data map in sync so Post/Title templates pick up the new link
            const cached = _importDataMap.get(link);
            if (cached) cached.folderLink = result.folderLink;
          } else {
            getFolderLinkBtn.disabled = false;
            getFolderLinkBtn.textContent = '⚠';
            getFolderLinkBtn.title = (result && result.error) || 'Failed to generate folder link';
            setTimeout(() => {
              getFolderLinkBtn.textContent = '🔗';
              getFolderLinkBtn.title = 'Generate and save a folder link for this file';
            }, 4000);
          }
        } catch (e) {
          getFolderLinkBtn.disabled = false;
          getFolderLinkBtn.textContent = '⚠';
          getFolderLinkBtn.title = e.message || 'Unknown error';
          setTimeout(() => {
            getFolderLinkBtn.textContent = '🔗';
            getFolderLinkBtn.title = 'Generate and save a folder link for this file';
          }, 4000);
        }
      });
      folderEl.appendChild(getFolderLinkBtn);
    }

    makeCopyField(nameEl,  name,            name);
    makeCopyField(sizeEl,  sizeStr || size, sizeStr || '—');
    makeCopyField(linkEl,  link,            link);
    makeCopyField(emailEl, email,           email    || '—');
    makeCopyField(passEl,  password,        password || '—');

    // ── Post / Title / Delete buttons ───────────────────────────────────────────
    const actionsEl = document.createElement('div');
    actionsEl.className = 'up-li-actions';

    const postBtn = document.createElement('button');
    postBtn.className = 'btn-post';
    postBtn.textContent = '📋 Post';
    postBtn.title = 'Copy post text to clipboard using your template';
    postBtn.addEventListener('click', async () => {
      const fileData = { name, link, size: sizeStr || size || '', email, password, folderLink, lastLogin: importDate || '' };
      let miText = '';
      try {
        const records = await window.api.readImportMediainfo();
        const record = records.find(r => r.fileLink === link) || records.find(r => r.fileName === name);
        if (record && typeof record.mediainfo === 'string') miText = record.mediainfo;
      } catch { /* non-fatal — proceed without mediainfo */ }
      const omdbData = omdbCache.get(link) || null;
      const text = renderPostTemplate(postTemplate, fileData, miText, omdbData);
      try {
        await navigator.clipboard.writeText(text);
        postBtn.textContent = '✓ Copied!';
        postBtn.classList.add('copied');
        setTimeout(() => { postBtn.textContent = '📋 Post'; postBtn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });
    actionsEl.appendChild(postBtn);

    const titleBtn = document.createElement('button');
    titleBtn.className = 'btn-post';
    titleBtn.textContent = '📋 Title';
    titleBtn.title = 'Copy formatted title to clipboard using your title template';
    titleBtn.addEventListener('click', async () => {
      const fileData = { name, link, size: sizeStr || size || '', email, password, folderLink, lastLogin: importDate || '' };
      let miText = '';
      try {
        const records = await window.api.readImportMediainfo();
        const record = records.find(r => r.fileLink === link) || records.find(r => r.fileName === name);
        if (record && typeof record.mediainfo === 'string') miText = record.mediainfo;
      } catch { /* non-fatal */ }
      const omdbData = omdbCache.get(link) || null;
      const text = renderPostTemplate(titleTemplate, fileData, miText, omdbData);
      try {
        await navigator.clipboard.writeText(text);
        titleBtn.textContent = '✓ Copied!';
        titleBtn.classList.add('copied');
        setTimeout(() => { titleBtn.textContent = '📋 Title'; titleBtn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });
    actionsEl.appendChild(titleBtn);

    // ── Mediainfo panel (collapsed by default) — mirrors buildLinkItem() ───────
    const miPanel = document.createElement('div');
    miPanel.className = 'up-li-mi-panel';

    const miPanelHeader = document.createElement('div');
    miPanelHeader.className = 'up-li-mi-panel-header';

    const miPanelLabel = document.createElement('span');
    miPanelLabel.className = 'up-li-mi-panel-label';
    miPanelLabel.textContent = 'MediaInfo';

    const miPanelPre = document.createElement('pre');
    miPanelPre.className = 'mi-text-body';

    const miCopyBtn = document.createElement('button');
    miCopyBtn.className = 'btn-post';
    miCopyBtn.textContent = '📋 Copy';
    miCopyBtn.title = 'Copy full mediainfo to clipboard';
    miCopyBtn.style.display = 'none';
    miCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(miPanelPre.textContent);
        miCopyBtn.textContent = '✓ Copied!';
        miCopyBtn.classList.add('copied');
        setTimeout(() => { miCopyBtn.textContent = '📋 Copy'; miCopyBtn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });

    miPanelHeader.appendChild(miPanelLabel);
    miPanelHeader.appendChild(miCopyBtn);
    miPanel.appendChild(miPanelHeader);
    miPanel.appendChild(miPanelPre);

    function showMiPanel(record) {
      if (record && typeof record.mediainfo === 'string' && record.mediainfo.trim()) {
        miPanelPre.textContent = record.mediainfo.trim();
        miCopyBtn.style.display = '';
      } else {
        miPanelPre.textContent = 'No mediainfo available for this file.';
        miCopyBtn.style.display = 'none';
      }
    }

    // ── Mediainfo toggle / Get Mediainfo / Retry — center of the actions row ───
    const miCenterEl = document.createElement('span');
    miCenterEl.style.cssText = 'flex:1;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:6px';

    const miStatusEl = document.createElement('span');
    miStatusEl.style.cssText = 'flex-basis:100%;text-align:center;font-size:12px';
    miStatusEl.hidden = true;
    function setMiStatus(msg, type = 'info') {
      if (!msg) { miStatusEl.hidden = true; return; }
      miStatusEl.textContent = msg;
      miStatusEl.className   = `fb-status fb-status--${type}`;
      miStatusEl.hidden      = false;
    }

    const miBtn = document.createElement('button');
    miBtn.className = 'btn-post';
    miBtn.title = 'Show/hide mediainfo for this file';
    miBtn.style.display = 'none';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-ghost btn-icon';
    retryBtn.title = 'Re-grab mediainfo and replace the saved entry';
    retryBtn.style.display = 'none';
    retryBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
    </svg>`;

    const getMiBtn = document.createElement('button');
    getMiBtn.className = 'btn-post';
    getMiBtn.textContent = 'Get Mediainfo';
    getMiBtn.title = 'Fetch mediainfo for this file and save it to import_mediainfo.ndjson';

    let miOpen   = false;
    let miRecord = _importMediainfoMap.get(link) || null;

    function setMiToggleMode() {
      getMiBtn.style.display = 'none';
      miBtn.style.display    = '';
      retryBtn.style.display = '';
      miBtn.textContent      = miOpen ? 'Mediainfo ▼' : 'Mediainfo ▶';
    }
    if (miRecord) setMiToggleMode();

    miBtn.addEventListener('click', () => {
      miOpen = !miOpen;
      miBtn.textContent = miOpen ? 'Mediainfo ▼' : 'Mediainfo ▶';
      if (miOpen) {
        miPanel.classList.add('open');
        showMiPanel(miRecord);
      } else {
        miPanel.classList.remove('open');
      }
    });

    async function runGrab() {
      getMiBtn.disabled = true;
      retryBtn.disabled = true;
      setMiStatus('Grabbing mediainfo… this can take a second.', 'info');
      try {
        const res = await window.api.grabImportMediainfo({ url: link, name });
        if (res && res.ok) {
          miRecord = res.record;
          _importMediainfoMap.set(link, miRecord);
          setMiToggleMode();
          if (miOpen) showMiPanel(miRecord);
          setMiStatus('');
        } else {
          setMiStatus(`Error: ${res && res.error ? res.error : 'Could not grab mediainfo.'}`, 'error');
        }
      } catch (err) {
        setMiStatus(`Error: ${err.message}`, 'error');
      } finally {
        getMiBtn.disabled = false;
        retryBtn.disabled = false;
      }
    }

    getMiBtn.addEventListener('click', runGrab);
    retryBtn.addEventListener('click', runGrab);

    miCenterEl.appendChild(getMiBtn);
    miCenterEl.appendChild(miBtn);
    miCenterEl.appendChild(retryBtn);
    miCenterEl.appendChild(miStatusEl);
    actionsEl.appendChild(miCenterEl);

    const deleteImportBtn = document.createElement('button');
    deleteImportBtn.className = 'btn-post';
    deleteImportBtn.textContent = '🗑 Delete';
    deleteImportBtn.title = 'Remove this entry from import_log.csv';
    deleteImportBtn.addEventListener('click', async () => {
      if (deleteImportBtn.dataset.confirm !== 'yes') {
        deleteImportBtn.dataset.confirm = 'yes';
        deleteImportBtn.textContent = 'Sure? Click again';
        deleteImportBtn.style.cssText = 'background:var(--danger,#ef4444);color:#fff';
        setTimeout(() => {
          if (deleteImportBtn.dataset.confirm === 'yes') {
            deleteImportBtn.dataset.confirm = '';
            deleteImportBtn.textContent = '🗑 Delete';
            deleteImportBtn.style.cssText = '';
          }
        }, 3000);
        return;
      }
      const result = await window.api.deleteImportRow({ name, link });
      if (result && result.ok) {
        li.remove();
      } else {
        deleteImportBtn.textContent = '⚠ Error';
        setTimeout(() => { deleteImportBtn.textContent = '🗑 Delete'; }, 2000);
      }
    });
    actionsEl.appendChild(deleteImportBtn);

    // ── OMDB search row ────────────────────────────────────────────────────────
    const omdbEl = document.createElement('div');
    omdbEl.className = 'up-li-omdb';

    const omdbLabelEl = document.createElement('span');
    omdbLabelEl.className = 'up-li-omdb-label';
    omdbLabelEl.textContent = '🎬 OMDB';

    const omdbRowEl = document.createElement('div');
    omdbRowEl.className = 'up-li-omdb-row';

    const omdbInput = document.createElement('input');
    omdbInput.type = 'text';
    omdbInput.className = 'up-li-omdb-input';
    omdbInput.placeholder = 'IMDB ID (tt1234567) or title search…';

    const omdbSearchBtn = document.createElement('button');
    omdbSearchBtn.className = 'btn btn-ghost btn-sm';
    omdbSearchBtn.textContent = '🔍';
    omdbSearchBtn.title = 'Search OMDB';

    const omdbResultsEl = document.createElement('div');
    omdbResultsEl.className = 'up-li-omdb-results';

    const omdbSelectedEl = document.createElement('div');
    omdbSelectedEl.className = 'up-li-omdb-selected';

    if (omdbCache.has(link)) {
      const cached = omdbCache.get(link);
      omdbSelectedEl.textContent = `✓ ${cached.Title} (${cached.Year})`;
      omdbSelectedEl.classList.add('visible');
    }

    async function selectOmdbTitle(imdbId) {
      omdbSearchBtn.disabled = true;
      omdbSearchBtn.textContent = '⏳';
      omdbResultsEl.classList.remove('open');
      try {
        const data = await window.api.omdbGet(imdbId);
        if (data && data.Response !== 'False') {
          omdbCache.set(link, data);
          omdbSelectedEl.textContent = `✓ ${data.Title} (${data.Year})`;
          omdbSelectedEl.classList.add('visible');
          omdbInput.value = '';
        } else {
          omdbSelectedEl.textContent = `⚠ ${data.Error || 'Not found'}`;
          omdbSelectedEl.classList.add('visible');
        }
      } catch (err) {
        omdbSelectedEl.textContent = `⚠ ${err.message || 'Lookup failed'}`;
        omdbSelectedEl.classList.add('visible');
      } finally {
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
      }
    }

    async function runOmdbSearch() {
      const query = omdbInput.value.trim();
      if (!query) return;
      const imdbIdMatch = query.match(/tt\d+/);
      if (imdbIdMatch) { await selectOmdbTitle(imdbIdMatch[0]); return; }
      omdbSearchBtn.disabled = true;
      omdbSearchBtn.textContent = '⏳';
      omdbResultsEl.innerHTML = '';
      omdbResultsEl.classList.remove('open');
      try {
        const data = await window.api.omdbSearch(query);
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
        if (!data || data.Response === 'False') {
          const noEl = document.createElement('div');
          noEl.className = 'up-li-omdb-result';
          noEl.style.color = 'var(--text3)';
          noEl.textContent = data.Error || 'No results found.';
          omdbResultsEl.appendChild(noEl);
          omdbResultsEl.classList.add('open');
          return;
        }
        const results = (data.Search || []).slice(0, 10);
        results.forEach(item => {
          const row = document.createElement('div');
          row.className = 'up-li-omdb-result';
          row.innerHTML = `${item.Title} <span style="color:var(--text3)">(${item.Year})</span><span class="omdb-type">${item.Type}</span>`;
          row.title = item.imdbID;
          row.addEventListener('click', () => selectOmdbTitle(item.imdbID));
          omdbResultsEl.appendChild(row);
        });
        omdbResultsEl.classList.add('open');
      } catch (err) {
        omdbSearchBtn.disabled = false;
        omdbSearchBtn.textContent = '🔍';
        omdbSelectedEl.textContent = `⚠ ${err.message || 'Search failed'}`;
        omdbSelectedEl.classList.add('visible');
      }
    }

    omdbSearchBtn.addEventListener('click', runOmdbSearch);
    omdbInput.addEventListener('keydown', e => { if (e.key === 'Enter') runOmdbSearch(); });
    document.addEventListener('click', e => {
      if (!omdbEl.contains(e.target)) omdbResultsEl.classList.remove('open');
    }, { passive: true });

      omdbRowEl.appendChild(omdbLabelEl);
      omdbRowEl.appendChild(omdbInput);
      omdbRowEl.appendChild(omdbSearchBtn);
      omdbEl.appendChild(omdbRowEl);
      omdbEl.appendChild(omdbResultsEl);
      omdbEl.appendChild(omdbSelectedEl);

      li.appendChild(nameEl); li.appendChild(sizeEl); li.appendChild(linkEl);
      li.appendChild(folderEl);
      li.appendChild(emailEl); li.appendChild(passEl);
      li.appendChild(actionsEl);
      li.appendChild(miPanel);
      li.appendChild(omdbEl);
      return li;
  }

  // ── Sub-tab helpers ────────────────────────────────────────────────────────────
  function showSubtab(active) {
    document.getElementById('up-tabProgress').classList.toggle('active',    active === 'progress');
    document.getElementById('up-tabLinks').classList.toggle('active',       active === 'links');
    document.getElementById('up-tabAccounts').classList.toggle('active',    active === 'accounts');
    document.getElementById('up-tabMediaInfo').classList.toggle('active',   active === 'mediainfo');
    document.getElementById('up-tabViewImport').classList.toggle('active',  active === 'viewimport');
    document.getElementById('up-tabImportedLinks').classList.toggle('active', active === 'imports');
    document.getElementById('up-tabBulkImport').classList.toggle('active',    active === 'bulkimport');
    document.getElementById('up-dashPanel').style.display          = active === 'progress'   ? 'flex' : 'none';
    document.getElementById('up-linksPanel').style.display         = active === 'links'      ? '' : 'none';
    document.getElementById('up-accountsPanel').style.display      = active === 'accounts'   ? '' : 'none';
    document.getElementById('up-mediaInfoPanel').style.display     = active === 'mediainfo'  ? '' : 'none';
    document.getElementById('up-viewImportPanel').style.display    = active === 'viewimport' ? 'flex' : 'none';
    document.getElementById('up-importedLinksPanel').style.display = active === 'imports'    ? '' : 'none';
    document.getElementById('bi-dashPanel').style.display          = active === 'bulkimport' ? 'flex' : 'none';
    document.getElementById('up-openUploadCsv').style.display      = active === 'links'      ? '' : 'none';
    document.getElementById('up-openAccountCsv').style.display     = active === 'accounts'   ? '' : 'none';
    document.getElementById('up-openImportCsv').style.display      = active === 'imports'    ? '' : 'none';
    document.getElementById('up-modeBody').style.display          = active === 'bulkimport' ? 'none' : '';
    document.getElementById('bi-modeBody').style.display           = active === 'bulkimport' ? ''     : 'none';
    document.getElementById('up-modeActions').style.display        = active === 'bulkimport' ? 'none' : 'flex';
    document.getElementById('bi-modeActions').style.display        = active === 'bulkimport' ? 'flex' : 'none';
  }

  // Exposed globally so bulk-import.js (loaded later, in its own IIFE) can drive
  // the same sub-tab switcher instead of maintaining a parallel, partial copy of it.
  window.upShowSubtab = showSubtab;

  document.getElementById('up-tabProgress').addEventListener('click', () => showSubtab('progress'));
  document.getElementById('up-tabViewImport').addEventListener('click', async () => {
    showSubtab('viewimport');
    // Auto-load the most recently used account the first time the tab is opened
    if (_viewImport && !_viewImport.hasAccount()) {
      try {
        const accounts = await window.api.readAccountsFile(); // newest-first
        if (accounts && accounts.length > 0)
          _viewImport.setAccount(accounts[0].email, accounts[0].password);
      } catch { /* non-fatal */ }
    }
  });

  document.getElementById('up-tabLinks').addEventListener('click', async () => {
    showSubtab('links');
    upLinksPage = 1;
    upLinksList.innerHTML = ''; upLinks.length = 0;
    _selectedLinks.clear(); _linkDataMap.clear();
    upLinksEmpty.style.display = ''; upLinksEmpty.textContent = 'Loading history…';
    if (upLinksPagination) upLinksPagination.style.display = 'none';
    syncActionBar();
    try {
      const entries = await window.api.readLinksFile();
      if (entries && entries.length > 0) {
        upLinksEmpty.style.display = 'none';
        // Detect archive groups, keep the full set around so page changes
        // don't need to re-read the CSV from disk.
        _linkGroupsAll = [...groupByArchive(entries)];
        renderLinksPage();
      } else {
        _linkGroupsAll = [];
        upLinksEmpty.textContent = 'No upload history found.';
      }
    } catch {
      _linkGroupsAll = [];
      upLinksEmpty.textContent = 'Could not read upload history.';
    }
  });

  document.getElementById('up-tabImportedLinks').addEventListener('click', async () => {
    showSubtab('imports');
    upImportsPage = 1;
    upImportsList.innerHTML = '';
    _selectedImports.clear(); _importDataMap.clear(); _importMediainfoMap.clear();
    upImportsEmpty.style.display = ''; upImportsEmpty.textContent = 'Loading import history…';
    if (upImportsPagination) upImportsPagination.style.display = 'none';
    syncImportActionBar();
    try {
      const entries = await window.api.readImportFile();
      if (entries && entries.length > 0) {
        upImportsEmpty.style.display = 'none';
        // Detect archive groups, keep the full set around so page changes
        // don't need to re-read the CSV from disk.
        _importGroupsAll = [...groupByArchive(entries)];
        try {
          const miRecords = await window.api.readImportMediainfo();
          (miRecords || []).forEach(r => { if (r && r.fileLink) _importMediainfoMap.set(r.fileLink, r); });
        } catch { /* non-fatal — rows just fall back to the "Get Mediainfo" button */ }
        renderImportsPage();
      } else {
        _importGroupsAll = [];
        upImportsEmpty.textContent = 'No import history found.';
      }
    } catch {
      _importGroupsAll = [];
      upImportsEmpty.textContent = 'Could not read import history.';
    }
  });

  // Renders only the slice of _linkGroupsAll that belongs to the current
  // upLinksPage (sized by upLinksPerPage) into #up-linksList.
  function renderLinksPage() {
    upLinksList.style.minHeight = upLinksList.offsetHeight + 'px';
    upLinksList.innerHTML = ''; upLinks.length = 0;
    const start      = (upLinksPage - 1) * upLinksPerPage;
    const pageGroups = _linkGroupsAll.slice(start, start + upLinksPerPage);

    for (const [baseName, items] of pageGroups) {
      if (items.length > 1 && items.some(i => parseArchivePart(i.name))) {
        // ── Render as a collapsible archive group ──────────────────────────
        const header = document.createElement('div');
        header.className = 'up-group-header open';

        const groupChk = document.createElement('input');
        groupChk.type = 'checkbox'; groupChk.className = 'up-li-chk';

        const arrow = document.createElement('span');
        arrow.className = 'up-group-arrow'; arrow.textContent = '▶';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'up-group-name'; nameSpan.textContent = baseName;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'up-group-meta';
        metaSpan.textContent = `${items.length} parts`;

        header.appendChild(groupChk);
        header.appendChild(arrow);
        header.appendChild(nameSpan);
        header.appendChild(metaSpan);

        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'up-group-children open';

        const childLinks = [];
        items.forEach(e => {
          upLinks.push({ name: e.name, link: e.link });
          const li = buildLinkItem(e);
          childrenWrap.appendChild(li);
          childLinks.push(e.link);
        });

        // Toggle collapse
        header.addEventListener('click', (evt) => {
          if (evt.target === groupChk) return; // checkbox has its own handler
          header.classList.toggle('open');
          childrenWrap.classList.toggle('open');
        });

        // Group checkbox — select/deselect all children
        groupChk.addEventListener('change', () => {
          childLinks.forEach(lk => {
            const childLi = upLinksList.querySelector(`[data-link="${CSS.escape(lk)}"]`);
            const childChk = childLi ? childLi.querySelector('.up-li-chk') : null;
            if (groupChk.checked) {
              _selectedLinks.add(lk);
              if (childLi) childLi.classList.add('selected');
              if (childChk) childChk.checked = true;
            } else {
              _selectedLinks.delete(lk);
              if (childLi) childLi.classList.remove('selected');
              if (childChk) childChk.checked = false;
            }
          });
          syncActionBar();
        });

        upLinksList.appendChild(header);
        upLinksList.appendChild(childrenWrap);
      } else {
        // ── Single item (no grouping) ──────────────────────────────────────
        items.forEach(e => {
          upLinks.push({ name: e.name, link: e.link });
          upLinksList.appendChild(buildLinkItem(e));
        });
      }
    }

    renderLinksPagination();
    upLinksList.style.minHeight = '';
  }

  // Updates the pager text and prev/next disabled state against the full
  // grouped result set, and hides itself entirely when there's only one page.
  function renderLinksPagination() {
    if (!upLinksPagination || !upLinksPageInfo || !upLinksPrevBtn || !upLinksNextBtn) return;
    if (_linkGroupsAll.length === 0) {
      upLinksPagination.style.display = 'none';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(_linkGroupsAll.length / upLinksPerPage));
    upLinksPagination.style.display = totalPages > 1 ? 'flex' : 'none';
    upLinksPageInfo.textContent      = `Page ${upLinksPage} of ${totalPages}`;
    upLinksPrevBtn.disabled          = upLinksPage <= 1;
    upLinksNextBtn.disabled          = upLinksPage >= totalPages;
  }

  if (upLinksPrevBtn) upLinksPrevBtn.addEventListener('click', () => {
    if (upLinksPage <= 1) return;
                                                      upLinksPage--;
    preserveScrollAnchor(upLinksPagination, renderLinksPage);
  });
  if (upLinksNextBtn) upLinksNextBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(_linkGroupsAll.length / upLinksPerPage));
    if (upLinksPage >= totalPages) return;
                                                      upLinksPage++;
    preserveScrollAnchor(upLinksPagination, renderLinksPage);
  });

  // Renders only the slice of _importGroupsAll that belongs to the current
  // upImportsPage (sized by upImportsPerPage) into #up-importedList.
  function renderImportsPage() {
    upImportsList.style.minHeight = upImportsList.offsetHeight + 'px';
    upImportsList.innerHTML = '';
    const start      = (upImportsPage - 1) * upImportsPerPage;
    const pageGroups = _importGroupsAll.slice(start, start + upImportsPerPage);

    for (const [baseName, items] of pageGroups) {
      if (items.length > 1 && items.some(i => parseArchivePart(i.name))) {
        // ── Render as a collapsible archive group ──────────────────────────
        const header = document.createElement('div');
        header.className = 'up-group-header open';

        const groupChk = document.createElement('input');
        groupChk.type = 'checkbox'; groupChk.className = 'up-li-chk';

        const arrow = document.createElement('span');
        arrow.className = 'up-group-arrow'; arrow.textContent = '▶';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'up-group-name'; nameSpan.textContent = baseName;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'up-group-meta';
        metaSpan.textContent = `${items.length} parts`;

        header.appendChild(groupChk);
        header.appendChild(arrow);
        header.appendChild(nameSpan);
        header.appendChild(metaSpan);

        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'up-group-children open';

        const childLinks = [];
        items.forEach(e => {
          const li = buildImportItem(e);
          childrenWrap.appendChild(li);
          childLinks.push(e.link);
        });

        header.addEventListener('click', (evt) => {
          if (evt.target === groupChk) return;
          header.classList.toggle('open');
          childrenWrap.classList.toggle('open');
        });

        groupChk.addEventListener('change', () => {
          childLinks.forEach(lk => {
            const childLi = upImportsList.querySelector(`[data-link="${CSS.escape(lk)}"]`);
            const childChk = childLi ? childLi.querySelector('.up-li-chk') : null;
            if (groupChk.checked) {
              _selectedImports.add(lk);
              if (childLi) childLi.classList.add('selected');
              if (childChk) childChk.checked = true;
            } else {
              _selectedImports.delete(lk);
              if (childLi) childLi.classList.remove('selected');
              if (childChk) childChk.checked = false;
            }
          });
          syncImportActionBar();
        });

        upImportsList.appendChild(header);
        upImportsList.appendChild(childrenWrap);
      } else {
        // ── Single item (no grouping) ──────────────────────────────────────
        items.forEach(e => {
          upImportsList.appendChild(buildImportItem(e));
        });
      }
    }

    renderImportsPagination();
    upImportsList.style.minHeight = '';
  }

  // Updates the pager text and prev/next disabled state against the full
  // grouped result set, and hides itself entirely when there's only one page.
  function renderImportsPagination() {
    if (!upImportsPagination || !upImportsPageInfo || !upImportsPrevBtn || !upImportsNextBtn) return;
    if (_importGroupsAll.length === 0) {
      upImportsPagination.style.display = 'none';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(_importGroupsAll.length / upImportsPerPage));
    upImportsPagination.style.display = totalPages > 1 ? 'flex' : 'none';
    upImportsPageInfo.textContent      = `Page ${upImportsPage} of ${totalPages}`;
    upImportsPrevBtn.disabled          = upImportsPage <= 1;
    upImportsNextBtn.disabled          = upImportsPage >= totalPages;
  }

  if (upImportsPrevBtn) upImportsPrevBtn.addEventListener('click', () => {
    if (upImportsPage <= 1) return;
                                                          upImportsPage--;
    preserveScrollAnchor(upImportsPagination, renderImportsPage);
  });
  if (upImportsNextBtn) upImportsNextBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(_importGroupsAll.length / upImportsPerPage));
    if (upImportsPage >= totalPages) return;
                                                          upImportsPage++;
    preserveScrollAnchor(upImportsPagination, renderImportsPage);
  });

  function buildAccountItem({ email, password, bandwidth, created, lastLogin, status, securityUpgrade, needsRefresh }) {
    const li = document.createElement('li'); li.className = 'up-acc-item';
    const emailEl = document.createElement('span'); emailEl.className = 'up-acc-email'; emailEl.textContent = email || '—';
    const bwEl    = document.createElement('span'); bwEl.className    = 'up-acc-bw';    bwEl.textContent    = bandwidth ? bandwidth + ' GB used' : '—';
    const passEl  = document.createElement('span'); passEl.className  = 'up-acc-pass';  passEl.textContent  = password || '—';

    // Security Upgrade icon
    const secUpgradeEl = document.createElement('span');
    secUpgradeEl.className = 'up-acc-secupgrade';
    const isUpgraded = securityUpgrade === 'Yes';
    secUpgradeEl.innerHTML = isUpgraded
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="7.25" stroke="#22c55e" stroke-width="1.5"/><path d="M4.5 8.5l2.5 2.5 4.5-5" stroke="#22c55e" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="7.25" stroke="#ef4444" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#ef4444" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    secUpgradeEl.title = isUpgraded ? 'Security Upgrade: Yes (registered via megacmd)' : 'Security Upgrade: No (registered via megatools)';
    secUpgradeEl.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:' + (isUpgraded ? '#22c55e' : '#ef4444');
    const secLabel = document.createElement('span');
    secLabel.textContent = isUpgraded ? 'Secure' : 'No Upgrade';
    secUpgradeEl.appendChild(secLabel);

    // Row 3: dates + status badge + per-row refresh button
    const datesEl = document.createElement('span'); datesEl.className = 'up-acc-dates';
    datesEl.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    const parts = []; if (created) parts.push('Created: ' + created); if (lastLogin) parts.push('Last login: ' + lastLogin);
    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = 'up-acc-status';
    const statusClass = {
      'Active':    's-active',
      'Dormant':   's-dormant',
      'Terminated':'s-terminated',
      'Suspended': 's-suspended',
      'Over Quota':'s-over',
    }[status] || 's-unknown';
    statusBadge.classList.add(statusClass);
    statusBadge.textContent = status || 'Unknown';
    statusBadge.title = needsRefresh ? 'Refresh needed: login date is old or unknown, or account status is unknown.' : '';
    datesEl.appendChild(statusBadge);
    if (parts.length > 0) {
      const dateSpan = document.createElement('span');
      dateSpan.style.color = 'var(--text3)';
      dateSpan.style.fontSize = '10.5px';
      dateSpan.textContent = parts.join('   ·   ');
      datesEl.appendChild(dateSpan);
    }

    // Per-row refresh button — sits inline after the date text
    const rowRefreshBtn = document.createElement('button');
    rowRefreshBtn.className = 'acc-row-refresh';
    rowRefreshBtn.title = 'Refresh this account';
    rowRefreshBtn.innerHTML = refreshIcon;

    // Inline terminal shown below this account entry during/after a single refresh
    const singleRefreshLog = document.createElement('div');
    singleRefreshLog.className = 'acc-refresh-log acc-single-refresh-log';
    const cancelRowRefresh = document.createElement('button');
    cancelRowRefresh.className = 'btn btn-danger btn-sm';
    cancelRowRefresh.textContent = 'Cancel refresh'; cancelRowRefresh.hidden = true;
    cancelRowRefresh.addEventListener('click', () => {
      cancelRowRefresh.disabled = true;
      singleRefreshLog.textContent = 'Canceling refresh…';
      window.api.cancelSingleAccountRefresh(email);
    });

    rowRefreshBtn.addEventListener('click', () => {
      if (rowRefreshBtn.disabled) return;
      rowRefreshBtn.disabled = true;
      rowRefreshBtn.classList.add('spinning');
      singleRefreshLog.classList.add('visible');
      singleRefreshLog.textContent = 'Refreshing…';
      cancelRowRefresh.hidden = false; cancelRowRefresh.disabled = false;
      // The result arrives via up:refreshSingleDone — matched by email
      const handler = ({ email: doneEmail, status: newStatus, lastLogin: newLogin, securityUpgrade: newSecUpgrade, liveUsedBytes: liveBytesResult, error }) => {
        if (doneEmail !== email) return; // not our account
        rowRefreshBtn._unsubscribe?.();
        cancelRowRefresh.hidden = true;
        rowRefreshBtn.disabled = false;
        rowRefreshBtn.classList.remove('spinning');
        if (error) { singleRefreshLog.textContent = error; return; }
        // Update status badge
        statusBadge.className = 'up-acc-status';
        const nc = {
          'Active':    's-active',
          'Dormant':   's-dormant',
          'Terminated':'s-terminated',
          'Suspended': 's-suspended',
          'Over Quota':'s-over',
        }[newStatus] || 's-unknown';
        statusBadge.classList.add(nc);
        statusBadge.textContent = newStatus || 'Unknown';
        statusBadge.title = '';
        // Update the date text
        const dateSpan = datesEl.querySelector('span:not(.up-acc-status)');
        if (dateSpan && newLogin) {
          const formatted = newLogin.replace('T', ' ').slice(0, 19);
          const createdPart = created ? 'Created: ' + created + '   ·   ' : '';
          dateSpan.textContent = createdPart + 'Last login: ' + formatted;
        }
        // Update the security upgrade icon if the value changed
        if (newSecUpgrade !== undefined) {
          const upgraded = newSecUpgrade === 'Yes';
          secUpgradeEl.innerHTML = upgraded
            ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="7.25" stroke="#22c55e" stroke-width="1.5"/><path d="M4.5 8.5l2.5 2.5 4.5-5" stroke="#22c55e" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="vertical-align:-2px"><circle cx="8" cy="8" r="7.25" stroke="#ef4444" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#ef4444" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          secUpgradeEl.title = upgraded ? 'Security Upgrade: Yes (registered via megacmd)' : 'Security Upgrade: No (registered via megatools)';
          secUpgradeEl.style.color = upgraded ? '#22c55e' : '#ef4444';
          const secLbl = document.createElement('span');
          secLbl.textContent = upgraded ? 'Secure' : 'No Upgrade';
          secUpgradeEl.appendChild(secLbl);
        }
        // Update the inline terminal with the result
        const ts = new Date().toISOString();
        let storageStr = '';
        if (liveBytesResult !== null && liveBytesResult !== undefined) {
          storageStr = ' — ' + (liveBytesResult / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        } else if (newStatus === 'Active' || newStatus === 'Over Quota') {
          storageStr = ' — QUOTA CHECK FAILED';
        }
        const wasUpgraded    = newSecUpgrade === 'Yes' && securityUpgrade !== 'Yes';
        const upgradedSuffix = wasUpgraded ? ' — UPGRADED ✔' : '';
        singleRefreshLog.textContent = `${ts} → ${newStatus || 'Unknown'}${storageStr}${upgradedSuffix}`;
        // Re-check global health indicator
        updateHealthPill();
      };
      // Register a one-time-style listener (we keep a reference so repeated
      // clicks on different rows don't stack up orphan listeners)
      rowRefreshBtn._unsubscribe?.();
      rowRefreshBtn._unsubscribe = window.api.on('up:refreshSingleDone', handler);
      window.api.refreshSingleAccount(email, password);
    });
    datesEl.appendChild(rowRefreshBtn);
    datesEl.appendChild(cancelRowRefresh);

    const useBtn = document.createElement('button');
    useBtn.className = 'btn btn-accent btn-sm up-acc-use-btn'; useBtn.textContent = 'Use';
    useBtn.title = 'Fill Manual Login with this account';
    useBtn.addEventListener('click', () => {
      document.getElementById('mailPanel').hidden = true;
      document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="upload"]').classList.add('active');
      document.getElementById('dlSidebar').style.display = 'none';
      document.getElementById('upSidebar').style.display = '';
      document.getElementById('downloadPanel').classList.add('hidden');
      document.getElementById('uploadPanel').classList.remove('hidden');
      document.getElementById('settingsPanel').classList.remove('active');
      showSubtab('progress');
      const r = document.querySelector('input[name="up-strategy"][value="manual"]');
      r.checked = true;
      document.getElementById('up-manualLoginFields').style.display = 'flex';
      document.getElementById('up-manualEmail').value    = email;
      document.getElementById('up-manualPassword').value = password;
    });
    makeCopyField(emailEl, email, email || '—');
    makeCopyField(passEl, password, password || '—');
    li.appendChild(emailEl); li.appendChild(bwEl); li.appendChild(passEl);
    li.appendChild(secUpgradeEl);
    li.appendChild(datesEl); li.appendChild(useBtn);

    // View button — opens this account in the View & Import tab
    const viewBtn = document.createElement('button');
    viewBtn.className   = 'btn btn-ghost btn-sm acc-view-btn';
    viewBtn.innerHTML   = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" /></svg> View';
    viewBtn.title       = 'Browse this account\'s files in View & Import';
    viewBtn.addEventListener('click', () => {
      document.getElementById('mailPanel').hidden = true;
      document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="upload"]').classList.add('active');
      dlSidebar.style.display = 'none';
      upSidebar.style.display = '';
      downloadPanel.classList.add('hidden');
      uploadPanel.classList.remove('hidden');
      settingsPanel.classList.remove('active');
      showSubtab('viewimport');
      _viewImport?.setAccount(email, password);
    });
    li.appendChild(viewBtn);

    const trashIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l16 0" /><path d="M10 11l0 6" /><path d="M14 11l0 6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg>';

    // Delete button — removes this account from account_log.csv
    const deleteAccBtn = document.createElement('button');
    deleteAccBtn.className = 'btn btn-ghost btn-sm';
    deleteAccBtn.style.cssText = 'margin-top:4px;font-size:10px';
    deleteAccBtn.innerHTML = `${trashIcon} Delete`;
    deleteAccBtn.title = 'Remove this account from account_log.csv';
    deleteAccBtn.addEventListener('click', async () => {
      if (deleteAccBtn.dataset.confirm !== 'yes') {
        deleteAccBtn.dataset.confirm = 'yes';
        deleteAccBtn.textContent = 'Sure? Click again';
        deleteAccBtn.style.cssText = 'margin-top:4px;font-size:10px;background:var(--danger,#ef4444);color:#fff';
        setTimeout(() => {
          if (deleteAccBtn.dataset.confirm === 'yes') {
            deleteAccBtn.dataset.confirm = '';
            deleteAccBtn.innerHTML = `${trashIcon} Delete`;
            deleteAccBtn.style.cssText = 'margin-top:4px;font-size:10px';
          }
        }, 3000);
        return;
      }
      const result = await window.api.deleteAccountRow({ email });
      if (result && result.ok) {
        li.remove();
        updateHealthPill();
      } else {
        deleteAccBtn.textContent = '⚠ Error';
        setTimeout(() => { deleteAccBtn.innerHTML = `${trashIcon} Delete`; }, 2000);
      }
    });
    li.appendChild(deleteAccBtn);

    return [li, singleRefreshLog];
  }

  // Renders only the slice of _accountsAll that belongs to the current
  // upAccountsPage (sized by upAccountsPerPage) into #up-accountsList.
  function renderAccountsPage() {
    const listEl = document.getElementById('up-accountsList');
    if (!listEl) return;
    listEl.style.minHeight = listEl.offsetHeight + 'px';
    listEl.innerHTML = '';
    const start       = (upAccountsPage - 1) * upAccountsPerPage;
    const pageEntries = _accountsAll.slice(start, start + upAccountsPerPage);
    pageEntries.forEach(e => buildAccountItem(e).forEach(el => listEl.appendChild(el)));
    renderAccountsPagination();
    listEl.style.minHeight = '';
  }

  // Updates the pager text and prev/next disabled state against the full
  // account list, and hides itself entirely when there's only one page.
  function renderAccountsPagination() {
    const pagination = document.getElementById('up-accountsPagination');
    const pageInfo    = document.getElementById('up-accountsPageInfo');
    const prevBtn     = document.getElementById('up-accountsPrevBtn');
    const nextBtn     = document.getElementById('up-accountsNextBtn');
    if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;
    if (_accountsAll.length === 0) {
      pagination.style.display = 'none';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(_accountsAll.length / upAccountsPerPage));
    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfo.textContent      = `Page ${upAccountsPage} of ${totalPages}`;
    prevBtn.disabled          = upAccountsPage <= 1;
    nextBtn.disabled          = upAccountsPage >= totalPages;
  }

  document.getElementById('up-accountsPrevBtn')?.addEventListener('click', () => {
    if (upAccountsPage <= 1) return;
    upAccountsPage--;
    preserveScrollAnchor(document.getElementById('up-accountsPagination'), renderAccountsPage);
  });
  document.getElementById('up-accountsNextBtn')?.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(_accountsAll.length / upAccountsPerPage));
    if (upAccountsPage >= totalPages) return;
    upAccountsPage++;
    preserveScrollAnchor(document.getElementById('up-accountsPagination'), renderAccountsPage);
  });

  document.getElementById('up-tabAccounts').addEventListener('click', async () => {
    showSubtab('accounts');
    updateHealthPill();
    const listEl = document.getElementById('up-accountsList');
    const emptyEl = document.getElementById('up-accountsEmpty');
    upAccountsPage = 1;
    listEl.innerHTML = ''; emptyEl.style.display = ''; emptyEl.textContent = 'Loading account history…';
    try {
      const entries = await window.api.readAccountsFile();
      if (entries && entries.length > 0) {
        emptyEl.style.display = 'none';
        _accountsAll = entries;
        renderAccountsPage();
      } else { _accountsAll = []; emptyEl.textContent = 'No account history found.'; }
    } catch { _accountsAll = []; emptyEl.textContent = 'Could not read account history.'; }
  });

  // ── Account Refresh — button wiring ───────────────────────────────────────────
  let _refreshActive = false;
  const _batchBtnHtml = document.getElementById('btn-refreshDormantBatch')?.innerHTML || '';

  function setRefreshButtonsState(running, cancelable = false) {
    _refreshActive = running;
    const cancel = document.getElementById('btn-cancelRefresh');
    cancel.hidden = !running || !cancelable; cancel.disabled = false;
    const btnAll      = document.getElementById('btn-refreshAll');
    const btnInactive = document.getElementById('btn-refreshInactive');
    const btnUpgrade  = document.getElementById('btn-upgradeInsecure');
    if (!btnAll || !btnInactive) return;
    btnAll.disabled      = running || upRunning;
    btnInactive.disabled = running || upRunning;
    if (btnUpgrade) btnUpgrade.disabled = running || upRunning;
    const btnBatch = document.getElementById('btn-refreshDormantBatch');
    if (btnBatch) {
      btnBatch.disabled = running || upRunning;
      if (running) btnBatch.textContent = '↻ Refreshing…';
      else         btnBatch.innerHTML   = _batchBtnHtml;
    }
    if (running) {
      btnAll.textContent      = '↻ Refreshing…';
      btnInactive.textContent = '↻ Refreshing…';
    } else {
      btnAll.textContent      = '↻ Refresh All Accounts';
      btnInactive.textContent = '↻ Refresh Inactive';
    }
  }

  function appendRefreshLog(msg) {
    const logEl = document.getElementById('acc-refreshLog');
    if (!logEl) return;
    logEl.classList.add('visible');
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  document.getElementById('btn-refreshAll').addEventListener('click', () => {
    if (_refreshActive || upRunning) return;
    const logEl = document.getElementById('acc-refreshLog');
    if (logEl) { logEl.textContent = ''; logEl.classList.add('visible'); }
    document.getElementById('acc-refreshStatus').textContent = '';
    setRefreshButtonsState(true, true);
    window.api.refreshAccounts('all');
  });

  document.getElementById('btn-refreshInactive').addEventListener('click', () => {
    if (_refreshActive || upRunning) return;
    const logEl = document.getElementById('acc-refreshLog');
    if (logEl) { logEl.textContent = ''; logEl.classList.add('visible'); }
    document.getElementById('acc-refreshStatus').textContent = '';
    setRefreshButtonsState(true, true);
    window.api.refreshAccounts('inactive');
  });

  document.getElementById('btn-refreshDormantBatch').addEventListener('click', () => {
    if (_refreshActive || upRunning) return;
    const logEl = document.getElementById('acc-refreshLog');
    if (logEl) { logEl.textContent = ''; logEl.classList.add('visible'); }
    document.getElementById('acc-refreshStatus').textContent = '';
    setRefreshButtonsState(true, true);
    window.api.refreshAccounts('dormantBatch');
  });

  document.getElementById('btn-cancelRefresh').addEventListener('click', () => {
    document.getElementById('btn-cancelRefresh').disabled = true;
    document.getElementById('acc-refreshStatus').textContent = 'Canceling…';
    window.api.cancelAccountRefresh();
  });

  document.getElementById('btn-upgradeInsecure').addEventListener('click', () => {
    if (_refreshActive || upRunning) return;
    const logEl = document.getElementById('acc-refreshLog');
    if (logEl) { logEl.textContent = ''; logEl.classList.add('visible'); }
    document.getElementById('acc-refreshStatus').textContent = '';
    setRefreshButtonsState(true, true);
    const btn = document.getElementById('btn-upgradeInsecure');
    if (btn) btn.textContent = '⬆ Upgrading…';
    window.api.upgradeAllInsecure();
  });

  // Refresh log line from main process
  window.api.on('up:refreshLog', (msg) => {
    appendRefreshLog(msg);
  });

  // Refresh progress tick
  window.api.on('up:refreshProgress', ({ current, total, email, phase, message }) => {
    const statusEl = document.getElementById('acc-refreshStatus');
    if (statusEl) statusEl.textContent = `${current} / ${total}` + (message ? ' · ' + message : '');
  });

  // Refresh complete — re-enable buttons and reload the account list
  window.api.on('up:refreshDone', async ({ counts, elapsed, total, planned, canceled, error }) => {
    setRefreshButtonsState(false);
    const statusEl = document.getElementById('acc-refreshStatus');
    if (error) {
      if (statusEl) statusEl.textContent = `Stopped — ${total || 0}/${planned || 0} checked; see log`;
    }
    if (statusEl && !error) statusEl.textContent = canceled
      ? `Canceled — ${total}/${planned} checked; completed results saved`
      : `Done — ${total} checked in ${elapsed}s`;
    // Reload the account list so updated statuses appear immediately
    const listEl  = document.getElementById('up-accountsList');
    const emptyEl = document.getElementById('up-accountsEmpty');
    if (!listEl) return;
    upAccountsPage = 1;
    listEl.innerHTML = ''; emptyEl.style.display = ''; emptyEl.textContent = 'Reloading…';
    try {
      const entries = await window.api.readAccountsFile();
      if (entries && entries.length > 0) {
        emptyEl.style.display = 'none';
        _accountsAll = entries;
        renderAccountsPage();
      } else { _accountsAll = []; emptyEl.textContent = 'No account history found.'; }
    } catch { _accountsAll = []; emptyEl.textContent = 'Could not reload account history.'; }
    // Re-evaluate the header health indicator now that statuses have changed
    updateHealthPill();
  });

  // Upgrade All Insecure complete — re-enable buttons and reload account list
  window.api.on('up:upgradeAllDone', async ({ upgraded, failed, elapsed, total, planned = total, canceled, error }) => {
    setRefreshButtonsState(false);
    const btnUpgrade = document.getElementById('btn-upgradeInsecure');
    if (btnUpgrade) btnUpgrade.textContent = '⬆ Upgrade All Insecure';
    const statusEl = document.getElementById('acc-refreshStatus');
    if (error) {
      if (statusEl) statusEl.textContent = `Stopped — ${upgraded || 0}/${planned || 0} upgraded; see log`;
    }
    if (statusEl && !error) statusEl.textContent = canceled
      ? `Canceled — ${upgraded}/${planned} upgraded; completed results saved`
      : `Done — ${upgraded}/${total} upgraded in ${elapsed}s`;
    const listEl  = document.getElementById('up-accountsList');
    const emptyEl = document.getElementById('up-accountsEmpty');
    if (!listEl) return;
    upAccountsPage = 1;
    listEl.innerHTML = ''; emptyEl.style.display = ''; emptyEl.textContent = 'Reloading…';
    try {
      const entries = await window.api.readAccountsFile();
      if (entries && entries.length > 0) {
        emptyEl.style.display = 'none';
        _accountsAll = entries;
        renderAccountsPage();
      } else { _accountsAll = []; emptyEl.textContent = 'No account history found.'; }
    } catch { _accountsAll = []; emptyEl.textContent = 'Could not reload account history.'; }
    updateHealthPill();
  });

  // ── MediaInfo item builder ─────────────────────────────────────────────────────
  function buildMediaInfoItem(record) {
    const { fileName, fileLink, uploadedAt, mediainfo } = record;

    const li = document.createElement('li');
    li.className = 'mi-item';

    // Header: filename (click → copy link) + upload date
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
    dateEl.textContent = uploadedAt || '';

    hdr.append(copyBtn, nameEl, dateEl);
    li.appendChild(hdr);

    // Plain-text mediainfo block
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

  // Renders only the slice of _mediaInfoAll that belongs to the current
  // upMediaInfoPage (sized by upMediaInfoPerPage) into #up-mediaInfoList.
  function renderMediaInfoPage() {
    const listEl = document.getElementById('up-mediaInfoList');
    if (!listEl) return;
    listEl.style.minHeight = listEl.offsetHeight + 'px';
    listEl.innerHTML = '';
    const start       = (upMediaInfoPage - 1) * upMediaInfoPerPage;
    const pageEntries = _mediaInfoAll.slice(start, start + upMediaInfoPerPage);
    pageEntries.forEach(r => listEl.appendChild(buildMediaInfoItem(r)));
    renderMediaInfoPagination();
    listEl.style.minHeight = '';
  }

  // Updates the pager text and prev/next disabled state against the full
  // mediainfo list, and hides itself entirely when there's only one page.
  function renderMediaInfoPagination() {
    const pagination = document.getElementById('up-mediaInfoPagination');
    const pageInfo    = document.getElementById('up-mediaInfoPageInfo');
    const prevBtn     = document.getElementById('up-mediaInfoPrevBtn');
    const nextBtn     = document.getElementById('up-mediaInfoNextBtn');
    if (!pagination || !pageInfo || !prevBtn || !nextBtn) return;
    if (_mediaInfoAll.length === 0) {
      pagination.style.display = 'none';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(_mediaInfoAll.length / upMediaInfoPerPage));
    pagination.style.display = totalPages > 1 ? 'flex' : 'none';
    pageInfo.textContent      = `Page ${upMediaInfoPage} of ${totalPages}`;
    prevBtn.disabled          = upMediaInfoPage <= 1;
    nextBtn.disabled          = upMediaInfoPage >= totalPages;
  }

  document.getElementById('up-mediaInfoPrevBtn')?.addEventListener('click', () => {
    if (upMediaInfoPage <= 1) return;
    upMediaInfoPage--;
    preserveScrollAnchor(document.getElementById('up-mediaInfoPagination'), renderMediaInfoPage);
  });
  document.getElementById('up-mediaInfoNextBtn')?.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(_mediaInfoAll.length / upMediaInfoPerPage));
    if (upMediaInfoPage >= totalPages) return;
    upMediaInfoPage++;
    preserveScrollAnchor(document.getElementById('up-mediaInfoPagination'), renderMediaInfoPage);
  });

  document.getElementById('up-tabMediaInfo').addEventListener('click', async () => {
    showSubtab('mediainfo');
    const listEl  = document.getElementById('up-mediaInfoList');
    const emptyEl = document.getElementById('up-mediaInfoEmpty');
    upMediaInfoPage = 1;
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    emptyEl.textContent = 'Loading mediainfo records…';
    try {
      const records = await window.api.readMediaInfo();
      if (records && records.length > 0) {
        emptyEl.style.display = 'none';
        _mediaInfoAll = records;
        renderMediaInfoPage();
      } else {
        _mediaInfoAll = [];
        emptyEl.textContent = 'No mediainfo records found. MediaInfo is captured automatically when files are uploaded.';
      }
    } catch {
      _mediaInfoAll = [];
      emptyEl.textContent = 'Could not read mediainfo records.';
    }
  });

  document.getElementById('up-openUploadCsv').addEventListener('click', () => {
    const p = (dataDirPath || '').replace(/[/\\]+$/, '');
    if (p) window.api.openFile(p + '/upload_log.csv');
  });

  document.getElementById('up-openAccountCsv').addEventListener('click', () => {
    const p = (dataDirPath || '').replace(/[/\\]+$/, '');
    if (p) window.api.openFile(p + '/account_log.csv');
  });

  document.getElementById('dl-openDownloadCsv').addEventListener('click', () => {
    const p = (dataDirPath || '').replace(/[/\\]+$/, '');
    if (p) window.api.openFile(p + '/download_log.csv');
  });

  // ── IPC: from main process ─────────────────────────────────────────────────────

  window.api.on('up:log', msg => {
    upLog(msg, msg.toLowerCase().startsWith('error') ? 'll-error' : 'll-sys');
  });

  // Browser-mode events
  window.api.on('up:browserReady', ({ email }) => {
    upLog(`✓ Browser ready${email ? ' — logged in as ' + email : ''}.`, 'll-done');
  });

  window.api.on('up:browserClosed', () => {
    upRunning = false;
    upCloseBrowserBtn.style.display = 'none';
    upStartBtn.style.display        = '';
    upStartBtn.disabled             = false;
    syncStartBtnLabel();  // re-checks isBrowserUploadMode for correct label
    upRenderStaging();
    upSyncLogVsDrop();
  });

  window.api.on('up:archiveProgress', ({ file, pct }) => {
    const card    = document.getElementById('up-archiveCard');
    const nameEl  = document.getElementById('up-archiveFileName');
    const fill    = document.getElementById('up-archiveFill');
    const pctEl   = document.getElementById('up-archivePct');
    card.style.display   = '';
    nameEl.textContent   = file;
    fill.style.width     = pct + '%';
    pctEl.textContent    = pct + '%';
  });

  window.api.on('up:archiveDone', () => {
    document.getElementById('up-archiveCard').style.display = 'none';
  });

  window.api.on('up:status', ({ file, idx, total }) => {
    _upFileWarmupEndTime = 0;  // reset so the warmup clock starts fresh on first progress event
    // Reset any previous 'uploading' marker (safety)
    liveQueue.forEach(i => { if (i.status === 'uploading') i.status = 'pending'; });
    const item = liveQueue.find(i => i.name === file);
    if (item) { item.status = 'uploading'; item.pct = 0; item.speed = ''; }
    upRenderLiveQueue();

    // Track position for overall-progress calculation in up:progress
    _upCurrentIdx = idx;
    _upTotalFiles = total;

    const fileNameEl = document.getElementById('up-statFileName');
    if (fileNameEl) fileNameEl.textContent = file;
    upStatIdx.textContent = ` (${idx} / ${total})`;
    // Queue-level bytes display — snapshot at the moment this file starts (filePct = 0)
    const _qTotalSt = liveQueue.reduce((s, i) => s + (i.size || 0), 0);
    if (_qTotalSt > 0) {
      const _qDoneSt = liveQueue.filter(i => i.status === 'done').reduce((s, i) => s + (i.size || 0), 0);
      upStatBytes.textContent = ' ' + fmtQueueBytes(_qDoneSt, _qTotalSt);
    }
    // Overall progress at the start of this file: files before it are 100% done
    const overallPct = ((idx - 1) / total * 100).toFixed(1);
    upProgFill.style.width = overallPct + '%';
    upProgPct.textContent  = overallPct + '%';
  });

  window.api.on('up:vpnState', ({ state, message }) => {
    upStatSpeed.textContent = state === 'resuming' ? '—' : state === 'deferred' ? 'VPN switch after file' : 'Waiting for VPN';
    upStatSpeed.title = message;
    _upFileWarmupEndTime = 0;
    upLog(message);
  });

  window.api.on('up:progress', ({ filePct, speed }) => {
    // Track speed samples for the session report — does not require an active item
    const _bps = parseSpeedToBps(speed);
    if (_bps > 0) {
      if (_upFileWarmupEndTime === 0) _upFileWarmupEndTime = Date.now() + 5000;  // start clock on first byte
      if (_bps > _upSessPeakBps)                                    _upSessPeakBps = _bps;
      if (_bps < _upSessMinBps && Date.now() > _upFileWarmupEndTime && filePct < 95) _upSessMinBps  = _bps;
      _upSessSpeedSamples.push(_bps);
    }
    // Top bar — overall queue progress and speed display — does not require an active item.
    // For split archives up:status may fire with a part filename that has no liveQueue entry,
    // leaving no item with status 'uploading'. These updates must therefore run before the
    // active guard so that speed is always shown even when the per-item lookup fails.
    const overallPct = _upTotalFiles > 0
      ? ((_upCurrentIdx - 1 + filePct / 100) / _upTotalFiles * 100)
      : filePct;
    upProgFill.style.width  = overallPct.toFixed(1) + '%';
    upProgPct.textContent   = overallPct.toFixed(1) + '%';
    upStatSpeed.textContent = speed;
    // Queue-level bytes display — updated on every progress tick
    const _qTotalPr = liveQueue.reduce((s, i) => s + (i.size || 0), 0);
    if (_qTotalPr > 0) {
      const _qDonePr     = liveQueue.filter(i => i.status === 'done').reduce((s, i) => s + (i.size || 0), 0);
      const _qActivePr   = liveQueue.find(i => i.status === 'uploading');
      const _qUploadedPr = _qDonePr + (_qActivePr && _qActivePr.size ? _qActivePr.size * (filePct / 100) : 0);
      upStatBytes.textContent = ' ' + fmtQueueBytes(_qUploadedPr, _qTotalPr);
    }

    // Per-item bar/percentage patches require a matched active item
    const active = liveQueue.find(i => i.status === 'uploading');
    if (!active) return;
    active.pct   = filePct;
    active.speed = speed;
    // Surgical DOM update — no full re-render needed
    const bar      = document.getElementById('lq-bar-'      + active.id);
    const pct      = document.getElementById('lq-pct-'      + active.id);
    const uploaded = document.getElementById('lq-uploaded-' + active.id);
    if (bar) bar.style.width = filePct.toFixed(1) + '%';
    if (pct) pct.textContent = filePct.toFixed(0) + '%';
    if (uploaded && active.size) {
      const done = active.size * (filePct / 100);
      uploaded.textContent = fmtBytes(done) + ' / ' + fmtBytes(active.size);
    }
  });

  // updateAccountBanner now lives in renderer/shared.js (Task E) — it updates
  // shared header chrome, not Upload-tab-specific UI, so bulk-import.js can
  // call the same global function from its own bi:account listener.

  window.api.on('up:account', ({ email, password, usageKb }) => {
    updateAccountBanner(email, password, usageKb || 0);
    // Also keep the old inline stats bar in sync
    const accEl    = document.getElementById('up-accLabel');
    const passEl2  = document.getElementById('up-passLabel');
    const passWrap = document.getElementById('up-passStatWrap');
    accEl.textContent  = email;
    passEl2.textContent = password;
    passWrap.style.display = '';
    function makeChip(el, value, kind) {
      el.onclick = () => {
        navigator.clipboard.writeText(value).catch(() => {});
        el.textContent = '✓ Copied'; el.classList.add('copied');
        setTimeout(() => { el.textContent = kind === 'email' ? email : password; el.classList.remove('copied'); }, 1500);
      };
    }
    makeChip(accEl, email, 'email'); makeChip(passEl2, password, 'pass');
    upLog(`Account: ${email}`, 'll-notice');
  });

  window.api.on('up:folderLink', ({ link, tool }) => {
    const bar    = document.getElementById('up-folderBar');
    const linkEl = document.getElementById('up-folderLinkEl');
    if (link) {
      linkEl.textContent = link;
      linkEl.onclick = () => {
        navigator.clipboard.writeText(link).catch(() => {});
        linkEl.textContent = '✓ Copied'; linkEl.classList.add('copied');
        setTimeout(() => { linkEl.textContent = link; linkEl.classList.remove('copied'); }, 1400);
      };
      bar.classList.add('visible');
    } else {
      linkEl.textContent = 'Not available';
      bar.classList.add('visible');
    }
    upLog(`Folder: ${link || 'n/a'}${tool ? ' [' + toolDisplayName(tool) + ']' : ''}`, 'll-sys');
  });

  window.api.on('up:link', ({ name, link, size, email, password, folderLink, folderName, fileSizeKb, lastLogin }) => {
    upLinks.push({ name, link });
    // Live-update the data usage bar after each file completes
    if (fileSizeKb) {
      const usageEl = document.getElementById('hdrAccUsedGb');
      const barFill = document.getElementById('hdrAccBarFill');
      const prevKb  = parseFloat(usageEl.dataset.usageKb || '0');
      const newKb   = prevKb + fileSizeKb;
      usageEl.dataset.usageKb = newKb;
      const MAX_KB = 20 * 1024 * 1024;
      const pct    = Math.min(100, (newKb / MAX_KB) * 100).toFixed(1);
      usageEl.textContent = (newKb / 1024 / 1024).toFixed(2);
      barFill.style.width = pct + '%';
      barFill.className   = 'hdr-acc-bar-fill' +
        (parseFloat(pct) >= 90 ? ' full' : parseFloat(pct) >= 65 ? ' high' : '');
    }
    const item = liveQueue.find(i => i.name === name);
    if (item) item.status = 'done';
    upRenderLiveQueue();
    upLinksEmpty.style.display = 'none';
    const entryData = { name, link, size: size || '', email: email || '', password: password || '', folderLink: folderLink || '', folderName: folderName || '', lastLogin: lastLogin || '' };
    upLinksList.appendChild(buildLinkItem(entryData));
    upLog(`✓ Link: ${name}`, 'll-done');
  });

  window.api.on('up:group', ({ parts }) => {
    // Auto-select all parts of a just-completed split upload so the user can
    // immediately generate a group post without manually ticking checkboxes.
    if (!parts || parts.length === 0) return;
    parts.forEach(p => { if (p.link) _selectedLinks.add(p.link); });
    // Re-sync the checkboxes on the already-rendered link items
    parts.forEach(p => {
      if (!p.link) return;
      const li = upLinksList.querySelector(`[data-link="${CSS.escape(p.link)}"]`);
      if (li) {
        li.classList.add('selected');
        const chk = li.querySelector('.up-li-chk');
        if (chk) chk.checked = true;
      }
    });
    syncActionBar();
  });

  window.api.on('up:fileError', ({ file, error }) => {
    const item = liveQueue.find(i => i.name === file);
    if (item) { item.status = 'failed'; item.pct = 0; item.speed = ''; item.error = error || 'Unknown error'; }
    upRenderLiveQueue();
    // Clear the top-bar status so stale progress/speed doesn't linger until the next file starts
    upStatSpeed.textContent = '—';
    const fileNameEl = document.getElementById('up-statFileName');
    if (fileNameEl) fileNameEl.textContent = 'Idle — add files to the queue and press Start Engine';
    upLog(`✕ Failed: ${file}`, 'll-error');
  });

  // up:fileSkipped fires for both cancel-current-file and skip-pending-file
  window.api.on('up:fileSkipped', ({ file }) => {
    const item = liveQueue.find(i => i.name === file);
    if (item) { item.status = 'cancelled'; item.pct = 0; item.speed = ''; }
    upRenderLiveQueue();
    // Clear the top-bar status so stale progress/speed doesn't linger until the next file starts
    upStatSpeed.textContent = '—';
    const fileNameEl = document.getElementById('up-statFileName');
    if (fileNameEl) fileNameEl.textContent = 'Idle — add files to the queue and press Start Engine';
    upLog(`⊘ Skipped: ${file}`, 'll-notice');
  });

  function buildUploadReportLines() {
    const elapsedMs   = _upSessStartTime > 0 ? Date.now() - _upSessStartTime : 0;
    const succeeded   = liveQueue.filter(i => i.status === 'done').length;
    const failed      = liveQueue.filter(i => i.status === 'failed').length;
    const cancelled   = liveQueue.filter(i => i.status === 'cancelled').length;
    const totalQ      = liveQueue.length;
    const totalBytes  = liveQueue
    .filter(i => i.status === 'done')
    .reduce((s, i) => s + (i.size || 0), 0);
    const avgBps = elapsedMs > 0 && totalBytes > 0
    ? (totalBytes / elapsedMs) * 1000 : 0;
    const avgSampleBps = _upSessSpeedSamples.length > 0
    ? _upSessSpeedSamples.reduce((a, b) => a + b, 0) / _upSessSpeedSamples.length : 0;
    const sep = '  ' + '─'.repeat(50);
    const out = [sep, '  ■ UPLOAD SESSION REPORT', sep];

    // ── Time & queue summary ───────────────────────────────────────────────────
    if (elapsedMs > 0)
      out.push(`  Elapsed time       : ${fmtDuration(elapsedMs)}`);
    out.push(`  Files              : ${totalQ}`);
    out.push(`  Succeeded          : ${succeeded}`);
    if (failed)    out.push(`  Failed             : ${failed}`);
    if (cancelled) out.push(`  Cancelled          : ${cancelled}`);
    if (totalQ > 1) {
      const rate = Math.round((succeeded / totalQ) * 100);
      out.push(`  Success rate       : ${rate}%  (${succeeded} / ${totalQ})`);
    }

    // ── Throughput ─────────────────────────────────────────────────────────────
    if (totalBytes > 0)
      out.push(`  Total uploaded     : ${fmtBytes(totalBytes)}`);
    if (avgBps > 0)
      out.push(`  Avg throughput     : ${fmtSpeed(avgBps)}`);

    if (_upSessSpeedSamples.length > 0) {
      if (_upSessPeakBps > 0)
        out.push(`  Peak speed         : ${fmtSpeed(_upSessPeakBps)}`);
      if (isFinite(_upSessMinBps) && _upSessMinBps > 0)
        out.push(`  Min speed          : ${fmtSpeed(_upSessMinBps)}`);
      if (avgSampleBps > 0)
        out.push(`  Avg sample speed   : ${fmtSpeed(avgSampleBps)}`);
      out.push(`  Speed samples      : ${_upSessSpeedSamples.length}`);
      if (_upSessPeakBps > 0 && isFinite(_upSessMinBps) && _upSessMinBps > 0) {
        const ratio = (_upSessPeakBps / _upSessMinBps).toFixed(1);
        out.push(`  Speed range        : ${fmtSpeed(_upSessMinBps)} – ${fmtSpeed(_upSessPeakBps)}  (${ratio}× variance)`);
      }
    }

    // ── Per-file stats ─────────────────────────────────────────────────────────
    if (succeeded > 0 && elapsedMs > 0)
      out.push(`  Avg time per file  : ${fmtDuration(elapsedMs / succeeded)}`);

    const doneItems = liveQueue.filter(i => i.status === 'done' && i.size > 0);
    if (doneItems.length > 0) {
      const sizes = doneItems.map(i => i.size);
      out.push(`  Avg file size      : ${fmtBytes(sizes.reduce((a, b) => a + b, 0) / sizes.length)}`);
      if (doneItems.length > 1) {
        out.push(`  Largest file       : ${fmtBytes(Math.max(...sizes))}`);
        out.push(`  Smallest file      : ${fmtBytes(Math.min(...sizes))}`);
      }
    }

    out.push(sep);
    return out;
  }

  window.api.on('up:complete', result => {
    upRunning = false;
    const completed = Boolean(result?.email);
    if (completed) {
      upProgFill.style.width = '100%'; upProgPct.textContent = '100%';
    }
    upStatSpeed.textContent = '—';
    upStatSpeed.title = '';
    liveQueue.forEach(i => { if (i.status === 'uploading') i.status = 'failed'; });
    upRenderLiveQueue();
    const failed = liveQueue.filter(i => i.status === 'failed').length;
    if (!completed) upLog('Upload queue stopped. Pending files are retained; check any uncertain remote file before retrying.', 'll-notice');
    else if (failed > 0) upLog(`Process complete — ${failed} file(s) failed.`, 'll-notice');
    else            upLog('Process complete!', 'll-done');
    buildUploadReportLines().forEach(line => upLog(line, 'll-sys'));
    // Swap buttons: hide Kill, show Start + New Queue
    upKillBtn.style.display     = 'none';
    upStartBtn.style.display    = '';
    upNewQueueBtn.style.display = '';
    // Derive disabled state from current staging queue contents
    upRenderStaging();
    // Log has content after completion — keep log visible; drop zone returns on clear
    upSyncLogVsDrop();
    // Re-enable refresh buttons now that no upload is running
    const _rAll = document.getElementById('btn-refreshAll');
    const _rInc = document.getElementById('btn-refreshInactive');
    if (_rAll) _rAll.disabled = _refreshActive;
    if (_rInc) _rInc.disabled = _refreshActive;
    const _rBat = document.getElementById('btn-refreshDormantBatch');
    if (_rBat) _rBat.disabled = _refreshActive;
    if (document.getElementById('up-accountsPanel').style.display !== 'none') {
      document.getElementById('up-tabAccounts').click();
    }
  });

  // ── Multi-link action bar button wiring ──────────────────────────────────────
  document.getElementById('up-selectAllChk').addEventListener('change', (e) => {
    if (e.target.checked) selectAll();
    else deselectAll();
  });

  document.getElementById('up-labDeselectBtn').addEventListener('click', () => deselectAll());

  document.getElementById('up-labPostBtn').addEventListener('click', async () => {
    const items = getSelectedItems();
    if (items.length === 0) return;
    const text = await renderMultiPostTemplate(postTemplate, items, omdbCache);
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('up-labPostBtn');
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Post Selected'; btn.classList.remove('copied'); }, 2000);
    } catch { /* non-fatal */ }
  });

  document.getElementById('up-labTitleBtn').addEventListener('click', async () => {
    const items = getSelectedItems();
    if (items.length === 0) return;
    const text = await renderMultiPostTemplate(titleTemplate, items, omdbCache);
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById('up-labTitleBtn');
      btn.textContent = '✓ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Title'; btn.classList.remove('copied'); }, 2000);
    } catch { /* non-fatal */ }
  });

  // ── Imported Links action bar button wiring ───────────────────────────────────
  document.getElementById('up-importedSelectAllChk').addEventListener('change', (e) => {
    if (e.target.checked) selectAllImports();
    else deselectAllImports();
  });

    document.getElementById('up-iabDeselectBtn').addEventListener('click', () => deselectAllImports());

    document.getElementById('up-iabPostBtn').addEventListener('click', async () => {
      const items = getSelectedImportItems();
      if (items.length === 0) return;
      const text = await renderMultiPostTemplate(postTemplate, items, omdbCache);
      try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('up-iabPostBtn');
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '📋 Post Selected'; btn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });

    document.getElementById('up-iabTitleBtn').addEventListener('click', async () => {
      const items = getSelectedImportItems();
      if (items.length === 0) return;
      const text = await renderMultiPostTemplate(titleTemplate, items, omdbCache);
      try {
        await navigator.clipboard.writeText(text);
        const btn = document.getElementById('up-iabTitleBtn');
        btn.textContent = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '📋 Title'; btn.classList.remove('copied'); }, 2000);
      } catch { /* non-fatal */ }
    });

    document.getElementById('up-openImportCsv').addEventListener('click', () => {
      const p = (dataDirPath || '').replace(/[/\\]+$/, '');
      if (p) window.api.openFile(p + '/import_log.csv');
    });

  // Init
  upRenderStaging();
  upSyncLogVsDrop();
  initToolCfgUI();
}());
