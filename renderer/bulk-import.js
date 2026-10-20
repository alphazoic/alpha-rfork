'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Bulk Import UI renderer
// ═══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────────
  // biStaging  : links added in the sidebar BEFORE the run starts (mirrors upStaging)
  // biLiveQueue: items driven by bi:* IPC events (mirrors liveQueue). Items may be
  // appended on the fly when bi:status/bi:itemError/bi:itemSkipped reference a URL
  // that wasn't in the original textarea (e.g. a file expanded out of a folder link
  // by bulk-import-engine.js's queue-analysis step) — see biFindOrCreateItem().
  let biStaging      = [];
  let biStagingId    = 1;
  let biLiveQueue    = [];   // { id, url, name, size, status:'pending'|'importing'|'done'|'failed'|'cancelled', error }
  let biRunning      = false;
  let _biCurrentIdx  = 0;    // 1-based index of the item currently importing
  let _biTotalItems  = 0;    // total item count for the current run
  let _biSessStartTime = 0;  // wall-clock time the current run started (for the session report)

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const biBulkTextarea = document.getElementById('bi-bulkTextarea');
  const biLoadTxtBtn   = document.getElementById('bi-loadTxtBtn');
  const biAddBulkBtn   = document.getElementById('bi-addBulkBtn');
  const biFolderName   = document.getElementById('bi-folderName');
  const biQueueList    = document.getElementById('bi-queueList');
  const biQueueEmpty   = document.getElementById('bi-queueEmpty');
  const biQueueCount   = document.getElementById('bi-queueCount');
  const biStartBtn     = document.getElementById('bi-startBtn');
  const biKillBtn      = document.getElementById('bi-killBtn');
  const biClearBtn     = document.getElementById('bi-clearBtn');
  const biLiveList     = document.getElementById('bi-liveList');
  const biLiveEmpty    = document.getElementById('bi-liveQueueEmpty');
  const biLogEl        = document.getElementById('bi-log');
  const biLogScroller  = document.getElementById('bi-logScroller');
  const biStatFileName = document.getElementById('bi-statFileName');
  const biStatIdx      = document.getElementById('bi-statIdx');
  const biClearLogBtn  = document.getElementById('bi-clearLogBtn');

  // ── Log — near-identical copy of upLog (upload.js line 437) ───────────────────
  function biLog(msg, cls) {
    const ph = biLogEl.querySelector('.log-empty');
    if (ph) ph.remove();
    const el = document.createElement('span');
    el.className = 'll ' + (cls || 'll-sys');
    el.textContent = msg;
    biLogEl.appendChild(el);
    biLogScroller.scrollTop = biLogScroller.scrollHeight;
  }

  biClearLogBtn.addEventListener('click', () => { biLogEl.innerHTML = ''; });

  // ── Staging (sidebar) render — ports upRenderStaging, simplified for links ────
  function biRenderStaging() {
    biQueueCount.textContent = biStaging.length;
    biQueueList.innerHTML = '';

    if (!biRunning) {
      const isEmpty = biStaging.length === 0;
      biStartBtn.disabled = isEmpty;
      biClearBtn.disabled = isEmpty;
    }

    if (biStaging.length === 0) {
      biQueueList.appendChild(biQueueEmpty);
      biQueueEmpty.style.display = '';
      return;
    }

    biStaging.forEach(item => {
      const el = document.createElement('div');
      el.className = 'q-item';
      el.dataset.id = item.id;

      const dot = document.createElement('span');
      dot.className = 'q-dot';

      const info = document.createElement('div');
      info.className = 'q-info';
      const urlEl = document.createElement('div');
      urlEl.className = 'q-url';
      urlEl.textContent = item.url;
      info.appendChild(urlEl);

      const ctrl = document.createElement('div');
      ctrl.className = 'q-controls';
      const delBtn = document.createElement('button');
      delBtn.className = 'q-btn del';
      delBtn.title = 'Remove from queue';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => {
        biStaging = biStaging.filter(i => i.id !== item.id);
        biRenderStaging();
      });
      ctrl.appendChild(delBtn);

      el.appendChild(dot);
      el.appendChild(info);
      el.appendChild(ctrl);
      biQueueList.appendChild(el);
    });
  }

  // ── Live queue (center panel) render — ports upRenderLiveQueue, simplified ────
  // No per-item progress bar/speed — imports are effectively atomic server-side
  // ops; a status badge (Pending / Importing… / Done / Failed / Skipped) is all
  // that's needed (there is intentionally no bi:progress channel).
  const BI_STATUS_LABEL = {
    pending:   'Pending',
    importing: 'Importing…',
    done:      'Done',
    failed:    'Failed',
    cancelled: 'Skipped',
  };

  function biRenderLiveQueue() {
    biLiveList.innerHTML = '';

    if (biLiveQueue.length === 0) {
      biLiveList.appendChild(biLiveEmpty);
      biLiveEmpty.style.display = '';
      return;
    }
    biLiveEmpty.style.display = 'none';

    biLiveQueue.forEach(item => {
      const isActive    = item.status === 'importing';
      const isDone      = item.status === 'done';
      const isFailed    = item.status === 'failed';
      const isCancelled = item.status === 'cancelled';

      const el = document.createElement('div');
      el.className = 'lq-item' +
        (isActive    ? ' lq-active'    : '') +
        (isDone      ? ' lq-done'      : '') +
        (isFailed    ? ' lq-failed'    : '') +
        (isCancelled ? ' lq-cancelled' : '');
      el.dataset.id = item.id;

      const icon = document.createElement('span');
      icon.className = 'lq-icon';
      icon.textContent = isActive ? '↻' : isDone ? '✓' : isFailed ? '✕' : isCancelled ? '—' : '·';

      const body = document.createElement('div');
      body.className = 'lq-body';

      const nameRow = document.createElement('div');
      nameRow.className = 'lq-name-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'lq-name' + (!item.name ? ' lq-name-copyable' : '');
      nameEl.textContent = item.name || item.url;
      nameEl.title = !item.name ? 'Click to copy URL' : (item.name || item.url);
      if (!item.name) {
        nameEl.addEventListener('click', () => {
          navigator.clipboard.writeText(item.url).catch(() => {});
          const prev = nameEl.textContent;
          nameEl.textContent = '✓ Copied';
          setTimeout(() => { nameEl.textContent = prev; }, 1400);
        });
      }
      nameRow.appendChild(nameEl);

      if (item.size) {
        const sizeEl = document.createElement('span');
        sizeEl.className = 'lq-speed';
        sizeEl.textContent = fmtBytes(item.size);
        nameRow.appendChild(sizeEl);
      }
      body.appendChild(nameRow);

      if (isFailed && item.error) {
        const errEl = document.createElement('div');
        errEl.className = 'lq-error';
        errEl.textContent = item.error;
        body.appendChild(errEl);
      }

      const ctrl = document.createElement('div');
      ctrl.className = 'lq-ctrl';
      const statusEl = document.createElement('span');
      statusEl.className = 'lq-pct';
      statusEl.textContent = BI_STATUS_LABEL[item.status] || item.status;
      ctrl.appendChild(statusEl);

      el.appendChild(icon);
      el.appendChild(body);
      el.appendChild(ctrl);
      biLiveList.appendChild(el);
    });
  }

  // Finds a biLiveQueue entry by url and/or name, creating one on the fly if it
  // doesn't exist yet. Needed because folder links get expanded into per-file
  // jobs at queue-analysis time inside bulk-import-engine.js — those expanded
  // URLs were never in biStaging, so biLiveQueue must grow to track them.
  function biFindOrCreateItem(url, name) {
    let item = biLiveQueue.find(i => (url && i.url === url) || (name && i.name === name));
    if (!item) {
      item = { id: 'bi-x' + (biStagingId++), url: url || '', name: name || url || '', size: null, status: 'pending', error: '' };
      biLiveQueue.push(item);
    }
    return item;
  }

  // ── Link textarea parsing + Add to Queue ───────────────────────────────────────
  // Splits on newlines, trims, drops blanks, basic mega.nz sanity check, and
  // resolves obfuscated/base64-wrapped links via the global helper from
  // app-bootstrap.js if present (matches view-import.js's doOpenPublic pattern).
  function biParseLinksFromText(text) {
    return (text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => (typeof resolveObfuscatedUrl === 'function' ? resolveObfuscatedUrl(l) : l))
      .filter(l => /mega\.nz\//.test(l));
  }

  biAddBulkBtn.addEventListener('click', () => {
    const links = biParseLinksFromText(biBulkTextarea.value);
    if (links.length === 0) {
      biLog('No valid MEGA links found in the text box.', 'll-error');
      return;
    }
    links.forEach(url => biStaging.push({ id: biStagingId++, url }));
    biBulkTextarea.value = '';
    biRenderStaging();
    biLog(`Added ${links.length} link(s) to the queue.`, 'll-sys');
  });

  biLoadTxtBtn.addEventListener('click', async () => {
    try {
      const content = await window.api.selectTxt();
      if (!content) return;
      const text = typeof content === 'string' ? content : (content.content || content.text || '');
      biBulkTextarea.value = text;
    } catch {
      biLog('Could not read the selected .txt file.', 'll-error');
    }
  });

  biClearBtn.addEventListener('click', () => {
    biStaging = [];
    biRenderStaging();
  });

  // ── Account strategy now lives ONLY in upload.js (the up-strategy /
  // up-resumePreview / up-manualLoginFields block is shared by Upload and
  // Bulk Import — see index.html's single #upSidebar). upload.js's
  // upSyncResumePreview()/upLoadResumePreview() and its up-strategy 'change'
  // listener already keep that block in sync regardless of which subtab is
  // active, so there is nothing left to wire up here.

  // ── Start button — ports upStartBtn's normal-mode click handler ───────────────
  biStartBtn.addEventListener('click', () => {
    if (biStaging.length === 0) { biLog('Nothing to import — paste links first.'); return; }
    if (biRunning) { biLog('Bulk import already running.', 'll-notice'); return; }

    const strategy        = document.querySelector('input[name="up-strategy"]:checked').value;
    const resumeAccount   = strategy === 'resume';
    const manualEmail     = strategy === 'manual' ? document.getElementById('up-manualEmail').value.trim() : '';
    const manualPassword  = strategy === 'manual' ? document.getElementById('up-manualPassword').value.trim() : '';
    if (strategy === 'manual' && (!manualEmail || !manualPassword)) {
      biLog('Enter both email and password.', 'll-error');
      return;
    }

    biLiveQueue = biStaging.map(i => ({ id: i.id, url: i.url, name: null, size: null, status: 'pending', error: '' }));
    biStaging = [];
    biRenderStaging();
    biRenderLiveQueue();

    biRunning = true;
    biStartBtn.style.display = 'none';
    biKillBtn.style.display  = '';
    biStatFileName.textContent = 'Starting…';
    biStatIdx.textContent = '';
    _biCurrentIdx = 0;
    _biTotalItems = biLiveQueue.length;
    _biSessStartTime = Date.now();

    const folderName = biFolderName.value.trim() || 'folder';

    window.api.startBulkImport({
      queue: biLiveQueue.map(i => i.url),
      resumeAccount, manualEmail, manualPassword, folderName,
      // Reuse the existing global cfg.toolOrderCreate setting (no new Settings UI
      // for v1) — bulk-import-engine.js's createBulkImportAccount() falls back
      // to it when createToolOrder is undefined, same pattern upload-engine.js
      // already uses for its own fallback.
      createToolOrder: undefined,
      smartOrderingEnabled: !!(document.getElementById('bi-smartOrdering')?.checked),
    });
  });

  // ── Kill button ─────────────────────────────────────────────────────────────
  biKillBtn.addEventListener('click', () => {
    window.api.killBulkImportQueue();
    biLiveQueue.forEach(i => { if (i.status === 'pending') i.status = 'cancelled'; });
    biRenderLiveQueue();
    biLog('Queue killed by user.', 'll-notice');
    // biRunning + button states are cleaned up when bi:complete arrives
  });

  // ── Session report — trimmed buildUploadReportLines, no throughput/speed ──────
  function biBuildReportLines() {
    const elapsedMs = _biSessStartTime > 0 ? Date.now() - _biSessStartTime : 0;
    const succeeded = biLiveQueue.filter(i => i.status === 'done').length;
    const failed    = biLiveQueue.filter(i => i.status === 'failed').length;
    const cancelled = biLiveQueue.filter(i => i.status === 'cancelled').length;
    const totalQ    = biLiveQueue.length;
    const sep = '  ' + '─'.repeat(50);
    const out = [sep, '  ■ BULK IMPORT SESSION REPORT', sep];
    if (elapsedMs > 0) out.push(`  Elapsed time       : ${fmtDuration(elapsedMs)}`);
    out.push(`  Links              : ${totalQ}`);
    out.push(`  Succeeded          : ${succeeded}`);
    if (failed)    out.push(`  Failed             : ${failed}`);
    if (cancelled) out.push(`  Skipped            : ${cancelled}`);
    if (totalQ > 1) {
      const rate = Math.round((succeeded / totalQ) * 100);
      out.push(`  Success rate       : ${rate}%  (${succeeded} / ${totalQ})`);
    }
    out.push(sep);
    return out;
  }

  // ── IPC: from main process ─────────────────────────────────────────────────────

  window.api.on('bi:log', msg => {
    biLog(msg, (msg || '').toLowerCase().startsWith('error') ? 'll-error' : 'll-sys');
  });

  window.api.on('bi:status', ({ item, idx, total }) => {
    const url  = item && item.url  ? item.url  : (typeof item === 'string' ? item : null);
    const name = item && item.name ? item.name : null;
    biLiveQueue.forEach(i => { if (i.status === 'importing') i.status = 'pending'; });
    const target = biFindOrCreateItem(url, name);
    target.status = 'importing';
    if (name) target.name = name;
    if (item && item.size) target.size = item.size;
    biRenderLiveQueue();

    _biCurrentIdx = idx;
    _biTotalItems = total;
    biStatFileName.textContent = target.name || target.url;
    biStatIdx.textContent = ` (${idx} / ${total})`;
  });

  window.api.on('bi:account', ({ email, password, usageKb }) => {
    updateAccountBanner(email, password, usageKb || 0);
    const accEl    = document.getElementById('bi-accLabel');
    const passEl2  = document.getElementById('bi-passLabel');
    const passWrap = document.getElementById('bi-passStatWrap');
    accEl.textContent   = email;
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
    biLog(`Account: ${email}`, 'll-notice');
  });

  window.api.on('bi:folderLink', ({ link, tool }) => {
    const bar    = document.getElementById('bi-folderBar');
    const linkEl = document.getElementById('bi-folderLinkEl');
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
    biLog(`Folder: ${link || 'n/a'}${tool ? ' [' + toolDisplayName(tool) + ']' : ''}`, 'll-sys');
  });

  // v1: no separate live "Generated Import Links" list — import_log.csv already
  // gets the row, and the existing Imported Links sub-tab (up-tabImportedLinks /
  // renderImportsPage() in upload.js) will show it on next visit/refresh.
  window.api.on('bi:link', ({ url, name, link, email, password, folderName }) => {
    const item = (url && biLiveQueue.find(i => i.url === url)) || biFindOrCreateItem(null, name);
    item.name   = name || item.name;
    item.status = 'done';
    biRenderLiveQueue();
    showToast(`✓ Imported: ${name} — view it in the Imported Links tab`);
  });

  window.api.on('bi:itemError', ({ item, error }) => {
    const url  = item && item.url ? item.url : item;
    const name = item && item.name ? item.name : null;
    const target = biFindOrCreateItem(url, name);
    target.status = 'failed';
    target.error  = error || 'Unknown error';
    biRenderLiveQueue();
    biLog(`✕ Failed: ${target.name || target.url} — ${target.error}`, 'll-error');
  });

  window.api.on('bi:itemSkipped', ({ item }) => {
    const url  = item && item.url ? item.url : item;
    const name = item && item.name ? item.name : null;
    const target = biFindOrCreateItem(url, name);
    target.status = 'cancelled';
    biRenderLiveQueue();
    biLog(`⊘ Skipped: ${target.name || target.url}`, 'll-notice');
  });

  window.api.on('bi:complete', () => {
    biRunning = false;
    biLiveQueue.forEach(i => { if (i.status === 'importing') i.status = 'done'; });
    biRenderLiveQueue();
    const failed = biLiveQueue.filter(i => i.status === 'failed').length;
    if (failed > 0) biLog(`Bulk import complete — ${failed} link(s) failed.`, 'll-notice');
    else            biLog('Bulk import complete!', 'll-done');
    biBuildReportLines().forEach(line => biLog(line, 'll-sys'));
    biStatFileName.textContent = 'Idle — add links to the queue and press Import';
    biStatIdx.textContent = '';
    biKillBtn.style.display  = 'none';
    biStartBtn.style.display = '';
    biRenderStaging();
  });

  // ── Subtab integration: panel + sidebar switching ────────────────────────────
  // Bulk Import lives as a sub-tab inside the Upload section, alongside Progress /
  // Generated Links / Accounts / MediaInfo / View & Import / Imported Links — all
  // switched through upload.js's showSubtab(), exposed globally as
  // window.upShowSubtab. Calling it here (instead of toggling bi-dashPanel /
  // upSidebar / biSidebar by hand) keeps the active-button state and every other
  // sub-panel's visibility in sync from the one place that already owns that logic.
  document.getElementById('up-tabBulkImport').addEventListener('click', () => {
    window.upShowSubtab('bulkimport');
  });

  // Init
  biRenderStaging();
  biRenderLiveQueue();
}());
