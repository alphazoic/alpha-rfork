'use strict';

// Header progress belongs to this run, rather than old rows left in the queue.
// Keep settled records when rows are cleared so their results cannot disappear.
const downloadStatusRun = { items: new Map(), current: null, phase: 'idle' };

function trackDownloadItem(item) {
  const record = { item, outcome: 'pending', failed: 0, skipped: 0,
    totalBytes: 0, completedBytes: 0, receivedBytes: 0, fileSize: 0, partials: new Map(),
    fileName: '', vpnState: '', message: '' };
  downloadStatusRun.items.set(item.id, record);
  return record;
}

function beginDownloadStatusRun() {
  downloadStatusRun.items.clear();
  queue.filter(item => item.status === 'pending').forEach(trackDownloadItem);
  downloadStatusRun.current = null;
  downloadStatusRun.phase = 'active';
  updateDownloadStatus();
}

function updateDownloadStatus() {
  const records = [...downloadStatusRun.items.values()];
  const total = records.length;
  const succeeded = records.filter(record => record.outcome === 'done').length;
  const failed = records.reduce((count, record) => count + record.failed, 0);
  const skipped = records.reduce((count, record) => count + record.skipped, 0);
  const cur = downloadStatusRun.current;
  const totalBytes = cur?.totalBytes || cur?.fileSize || 0;
  const receivedBytes = cur ? [...cur.partials.values()].reduce((sum, bytes) => sum + bytes, 0) : 0;
  // Bytes received may still need verification; reserve 100% for success.
  const pct = totalBytes > 0 ? Math.min(99, Math.max(0,
    Math.round(((cur.completedBytes + receivedBytes) / totalBytes) * 100))) : 0;
  const filePct = cur?.fileSize > 0 ? Math.min(99, Math.max(0,
    Math.round(cur.receivedBytes / cur.fileSize * 100))) : 0;
  const summary = `${succeeded}/${total} queued items successfully completed this run.` +
    (failed ? ` ${failed} file(s) failed.` : '') + (skipped ? ` ${skipped} item(s) skipped.` : '');
  const current = cur ? ` Current file: ${cur.fileName || cur.item.displayName || 'fetching file information'}${cur.fileSize ? ` (${filePct}%)` : ''}.` : '';
  const lastError = records.findLast(record => record.failed && record.message)?.message;
  const detail = `${summary}${current}${cur?.message ? ' ' + cur.message : ''}`;
  if (downloadStatusRun.phase === 'idle' || !total) {
    setStatus('idle', 'Downloads: idle', 'No downloads running.');
  } else if (downloadStatusRun.phase === 'stopping') {
    setStatus('stopping', 'Downloads: stopping', `${detail} Stopping the current download; wait for cleanup to finish.`);
  } else if (running && downloadStatusRun.phase === 'active' && (cur || records.some(record => record.outcome === 'pending'))) {
    if (cur?.vpnState === 'attention') {
      setStatus('error', 'Downloads: check VPN', `${detail} Connection recovery needs attention.`);
    } else if (cur?.vpnState && !['resuming', 'deferred'].includes(cur.vpnState)) {
      setStatus('waiting', 'Downloads: VPN wait', `${detail} Waiting for VPN connection or recovery.`);
    } else {
      setStatus('running', `Downloads: ${total > 1 ? succeeded + '/' + total : pct + '%'}`,
        detail);
    }
  } else if (failed) {
    setStatus('error', `Downloads: ${failed} failed`, `${detail}${lastError ? ' ' + lastError : ''}`);
  } else if (succeeded === total) {
    setStatus('done', 'Downloads: complete', `${summary} All downloads in this run completed successfully.`);
  } else {
    setStatus('idle', 'Downloads: stopped', `${detail} Unfinished or skipped work remains.`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Queue management
// ═══════════════════════════════════════════════════════════════════════════════
function truncUrl(url, max=40) {
  if (url.length <= max) return url;
  // show domain + end
  try {
    const u = new URL(url);
    const short = u.hostname + '/…/' + url.slice(-14);
    return short.length < url.length ? short : url.slice(0, max-1) + '…';
  } catch { return url.slice(0, max-1) + '…'; }
}

function renderQueue() {
  const pending = queue.filter(i => i.status === 'pending');
  queueCount.textContent = pending.length;

  queueList.innerHTML = '';
  if (queue.length === 0) {
    queueList.appendChild(queueEmpty);
    queueEmpty.style.display = '';
    return;
  }
  queueEmpty.style.display = 'none';

  // Drag state for sidebar reorder
  let sbDragSrcId = null;

  queue.forEach((item) => {
    const isPending = item.status === 'pending';
    const isRunning = item.status === 'running';
    const isDone    = item.status === 'done';
    const isError   = item.status === 'error';

    const el = document.createElement('div');
    el.className = 'q-item draggable' +
      (isRunning ? ' active' : '') +
      (isDone    ? ' done'   : '') +
      (isError   ? ' error'  : '');
    el.dataset.id = item.id;

    // Drag handle (pending only)
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = isPending ? '⠿' : '';
    handle.title = isPending ? 'Drag to reorder' : '';

    // Status dot
    const dot = document.createElement('span');
    dot.className = 'q-dot' +
      (isRunning ? ' s-running' : isDone ? ' s-done' : isError ? ' s-error' : '');

    // Info
    const info = document.createElement('div');
    info.className = 'q-info';
    const urlEl = document.createElement('div');
    urlEl.className = 'q-url';
    urlEl.textContent = item.displayName || truncUrl(item.url);
    urlEl.title = item.url;
    const metaEl = document.createElement('div');
    metaEl.className = 'q-meta';
    if (isError && item.errorMsg) {
      metaEl.textContent = '⚠ ' + item.errorMsg.slice(0, 55);
    } else if (item.fileSize) {
      metaEl.textContent = fmtBytes(item.fileSize) + (item.relPath ? ' · ' + item.relPath : '');
    } else {
      metaEl.textContent = (item.relPath ? item.relPath + ' · ' : '') + item.status;
    }
    info.appendChild(urlEl);
    info.appendChild(metaEl);

    // Controls
    const ctrl = document.createElement('div');
    ctrl.className = 'q-controls';

    if (isError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'q-btn retry'; retryBtn.title = 'Retry'; retryBtn.textContent = '↺';
      retryBtn.addEventListener('click', () => { const i = queue.indexOf(item); if (i !== -1) retryQueue(i); });
      ctrl.appendChild(retryBtn);
    }
    if (!isRunning) {
      const delBtn = document.createElement('button');
      delBtn.className = 'q-btn del'; delBtn.title = 'Remove'; delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => { const i = queue.indexOf(item); if (i !== -1) removeQueue(i); });
      ctrl.appendChild(delBtn);
    }

    // Drag-to-reorder (pending items only)
    if (isPending) {
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        sbDragSrcId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => el.classList.add('dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging', 'drag-over');
        queueList.querySelectorAll('.q-item').forEach(r => r.classList.remove('drag-over'));
        sbDragSrcId = null;
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        if (sbDragSrcId !== null && sbDragSrcId !== item.id) el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (sbDragSrcId === null || sbDragSrcId === item.id) return;
        const si = queue.findIndex(i => i.id === sbDragSrcId);
        const di = queue.findIndex(i => i.id === item.id);
        if (si === -1 || di === -1 || queue[si].status !== 'pending' || queue[di].status !== 'pending') return;
        const [moved] = queue.splice(si, 1);
        queue.splice(di, 0, moved);
        sbDragSrcId = null;
        renderQueue();
        dlRenderLiveQueue();
      });
    }

    el.appendChild(handle);
    el.appendChild(dot);
    el.appendChild(info);
    el.appendChild(ctrl);
    queueList.appendChild(el);
  });
}

function addToQueue(url, outDir, relPath) {
  url = url.trim();
  if (!url) return false;
  const item = { id: nextId++, url, outDir, relPath: relPath || '', status: 'pending' };
  queue.push(item);
  if (running) { trackDownloadItem(item); updateDownloadStatus(); }
  renderQueue();
  dlRenderLiveQueue();
  return true;
}

function removeQueue(idx) {
  if (queue[idx].status === 'running') return;
  const record = downloadStatusRun.items.get(queue[idx].id);
  if (record?.outcome === 'pending') downloadStatusRun.items.delete(queue[idx].id);
  queue.splice(idx, 1);
  updateDownloadStatus();
  renderQueue();
  dlRenderLiveQueue();
}

function retryQueue(idx) {
  if (running) return;
  queue[idx].status = 'pending';
  queue[idx].pct = 0;
  queue[idx].speed = '';
  delete queue[idx].errorMsg;
  running = true;
  stopBtn.disabled  = false;
  openOutBtn.style.display = 'none';
  sysLog(`Retrying: ${queue[idx].url.slice(0, 70)}`);
  startElapsedTimer();
  renderQueue();
  dlRenderLiveQueue();
  startNextInQueue();
}

// ─────────────────────────────────────────────────────────────────────────────
// Download live queue (center panel)
// ─────────────────────────────────────────────────────────────────────────────
function dlRenderLiveQueue() {
  const scrollTop = dlLqList.parentElement ? dlLqList.parentElement.scrollTop : 0;
  dlLqList.innerHTML = '';

  if (queue.length === 0) {
    dlLqList.appendChild(dlLqEmpty);
    dlLqEmpty.style.display = '';
    return;
  }
  dlLqEmpty.style.display = 'none';

  queue.forEach(item => {
    const isPending = item.status === 'pending';
    const isRunning = item.status === 'running';
    const isDone    = item.status === 'done';
    const isError   = item.status === 'error';
    const isSkipped = item.status === 'skipped';

    const el = document.createElement('div');
    el.className = 'lq-item' +
    (isRunning ? ' lq-active'  : '') +
    (isDone    ? ' lq-done'    : '') +
    (isError   ? ' lq-failed'  : '') +
    (isSkipped ? ' lq-skipped' : '');
    el.dataset.id = item.id;

    // Status icon
    const icon = document.createElement('span');
    icon.className = 'lq-icon';
    icon.textContent = isRunning ? '↓' : isDone ? '✓' : isError ? '✕' : isSkipped ? '↩' : '·';

    // Body
    const body = document.createElement('div');
    body.className = 'lq-body';

    const nameRow = document.createElement('div');
    nameRow.className = 'lq-name-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'lq-name';
    nameEl.textContent = item.displayName || truncUrl(item.url, 52);
    nameEl.title = item.displayName || item.url;
    nameRow.appendChild(nameEl);

    if (isRunning) {
      const recEl = document.createElement('span');
      recEl.className = 'lq-speed';
      recEl.id = 'dlb-rec-' + item.id;
      if (item.fileSize) {
        const received = item.receivedBytes || 0;
        recEl.textContent = fmtBytes(received) + ' / ' + fmtBytes(item.fileSize);
      } else {
        recEl.textContent = item.receivedBytes ? fmtBytes(item.receivedBytes) : '—';
      }
      nameRow.appendChild(recEl);
    }

    if (item.fileSize && !isRunning) {
      const szEl = document.createElement('span');
      szEl.className = 'lq-speed';
      szEl.textContent = fmtBytes(item.fileSize);
      nameRow.appendChild(szEl);
    }

    body.appendChild(nameRow);
    if (isRunning && item.sparsePreview?.state === 'available') {
      const notice = document.createElement('div'); notice.className = 'lq-meta sparse-preview-note';
      notice.textContent = 'Preview — awaiting verification'; body.appendChild(notice);
    }
    if (isRunning && item.vpnMessage) {
      const notice = document.createElement('div'); notice.className = 'lq-meta'; notice.textContent = item.vpnMessage;
      body.appendChild(notice);
    }

    if (isRunning) {
      const barWrap = document.createElement('div');
      barWrap.className = 'lq-bar-wrap';
      const barInner = document.createElement('div');
      barInner.className = 'lq-bar-inner';
      barInner.id = 'dlb-bar-' + item.id;
      barInner.style.width = (item.pct || 0) + '%';
      barWrap.appendChild(barInner);
      body.appendChild(barWrap);
    }

    if (isError && item.errorMsg) {
      const errEl = document.createElement('div');
      errEl.className = 'lq-error';
      errEl.textContent = item.errorMsg.slice(0, 80);
      body.appendChild(errEl);
    }

    // Controls
    const ctrl = document.createElement('div');
    ctrl.className = 'lq-ctrl';

    if (isRunning) {
      const pctEl = document.createElement('span');
      pctEl.className = 'lq-pct';
      pctEl.id = 'dlb-pct-' + item.id;
      pctEl.textContent = (item.pct || 0) + '%';
      ctrl.appendChild(pctEl);

      const skipFileBtn = document.createElement('button');
      skipFileBtn.className = 'q-btn del';
      skipFileBtn.title = 'Skip this item (whole folder) — queue continues';
      skipFileBtn.textContent = '↩';
      skipFileBtn.addEventListener('click', () => {
        clearSparsePreview(item);
        window.api.skipCurrentDownload();
        item.status = 'skipped'; // optimistic
        dlRenderLiveQueue();
      });
      ctrl.appendChild(skipFileBtn);

      // Stream-mode action buttons — available immediately during download
      if (item.streamMode) {
        const streamFolderBtn = document.createElement('button');
        streamFolderBtn.className = 'lq-act-btn act-folder';
        streamFolderBtn.title = 'Open containing folder';
        streamFolderBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 013.5 3h3l2 2H13a1.5 1.5 0 011.5 1.5v6A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5v-9z" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
        streamFolderBtn.addEventListener('click', () => window.api.openFolder(item.folderPath || item.outDir));
        ctrl.appendChild(streamFolderBtn);

        const streamPlayPath = item.streamMethod === 'http' ? item.streamM3uPath : sparsePlaybackPath(item);
        if (streamPlayPath) {
          const streamPlayBtn = document.createElement('button');
          streamPlayBtn.className = 'lq-act-btn act-play';
          streamPlayBtn.title = item.streamMethod === 'sparse' && item.sparsePreview?.state === 'available'
            ? 'Play preview — awaiting verification' : 'Open with default application';
          streamPlayBtn.innerHTML = '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.5v9l8-4.5L1 1.5z" fill="currentColor"/></svg>';
          streamPlayBtn.addEventListener('click', () => window.api.openFile(streamPlayPath));
          ctrl.appendChild(streamPlayBtn);
        }
      }

    } else if (isDone) {
      // Folder button — always shown
      const folderBtn = document.createElement('button');
      folderBtn.className = 'lq-act-btn act-folder';
      folderBtn.title = 'Open containing folder';
      folderBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4.5A1.5 1.5 0 013.5 3h3l2 2H13a1.5 1.5 0 011.5 1.5v6A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5v-9z" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
      folderBtn.addEventListener('click', () => window.api.openFolder(item.folderPath || item.outDir));
      ctrl.appendChild(folderBtn);

      // Play button — only when we know the single full path
      if (item.fullPath) {
        const playBtn = document.createElement('button');
        playBtn.className = 'lq-act-btn act-play';
        playBtn.title = 'Open with default application';
        playBtn.innerHTML = '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1.5v9l8-4.5L1 1.5z" fill="currentColor"/></svg>';
        playBtn.addEventListener('click', () => window.api.openFile(item.fullPath));
        ctrl.appendChild(playBtn);
      }

    } else if (isError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'q-btn retry'; retryBtn.title = 'Retry'; retryBtn.textContent = '↺';
      retryBtn.addEventListener('click', () => { const i = queue.indexOf(item); if (i !== -1) retryQueue(i); });
      ctrl.appendChild(retryBtn);
    }

    // Remove button (not while running)
    if (!isRunning) {
      const delBtn = document.createElement('button');
      delBtn.className = 'q-btn del'; delBtn.title = 'Remove'; delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => { const i = queue.indexOf(item); if (i !== -1) removeQueue(i); });
      ctrl.appendChild(delBtn);
    }

    // Drag-to-reorder (pending items only)
    let dragHandle = null;
    if (isPending) {
      dragHandle = document.createElement('span');
      dragHandle.className = 'lq-drag-handle';
      dragHandle.textContent = '⠿';
      dragHandle.title = 'Drag to reorder';

      el.draggable = true;
      el.addEventListener('dragstart', e => {
        dlLqDragSrcId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => el.classList.add('lq-dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('lq-dragging', 'lq-drag-over');
        dlLqList.querySelectorAll('.lq-item').forEach(r => r.classList.remove('lq-drag-over'));
        dlLqDragSrcId = null;
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dlLqDragSrcId !== null && dlLqDragSrcId !== item.id) el.classList.add('lq-drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('lq-drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('lq-drag-over');
        if (dlLqDragSrcId === null || dlLqDragSrcId === item.id) return;
        const si = queue.findIndex(i => i.id === dlLqDragSrcId);
        const di = queue.findIndex(i => i.id === item.id);
        if (si === -1 || di === -1 || queue[si].status !== 'pending' || queue[di].status !== 'pending') return;
        const [moved] = queue.splice(si, 1);
        queue.splice(di, 0, moved);
        dlLqDragSrcId = null;
        renderQueue();
        dlRenderLiveQueue();
      });
    }

    if (dragHandle) el.appendChild(dragHandle);
    el.appendChild(icon);
    el.appendChild(body);
    el.appendChild(ctrl);
    dlLqList.appendChild(el);
  });

  if (dlLqList.parentElement) dlLqList.parentElement.scrollTop = scrollTop;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Progress card
// ═══════════════════════════════════════════════════════════════════════════════
function showProgCard() { progCard.classList.add('visible'); }
function hideProgCard() { progCard.classList.remove('visible'); }

function buildChunkBlocks(total) {
  chunkRow.innerHTML = '';
  if (total <= 1) { chunkRow.style.display = 'none'; return; }
  chunkRow.style.display = 'flex';
  for (let i = 0; i < total; i++) {
    const b = document.createElement('div');
    b.className = 'chunk-block';
    b.dataset.idx = i;
    chunkRow.appendChild(b);
  }
}

function updateChunkBlocks(currentChunk, total) {
  // currentChunk is 1-indexed
  chunkRow.querySelectorAll('.chunk-block').forEach((b, i) => {
    b.className = 'chunk-block' +
      (i < currentChunk - 1 ? ' done' : i === currentChunk - 1 ? ' active' : '');
  });
}

// ── Overall queue progress ────────────────────────────────────────────────────
// Drives the top progress bar and % label.  Uses file-count fractions so it
// works with no prior knowledge of pending file sizes.
function updateQueueProgress() {
  const total = queue.length;
  if (total === 0) return;
  const doneCount = queue.filter(i => i.status === 'done' || i.status === 'error' || i.status === 'skipped').length;
  const cur       = queue.find(i => i.status === 'running');
  const curFrac   = cur ? (cur.pct || 0) / 100 : 0;
  const pct       = (doneCount + curFrac) / total * 100;

  progFill.classList.remove('indeterminate');
  progFill.style.width = pct.toFixed(1) + '%';
  progPct.textContent  = pct.toFixed(1) + '%';

  if (total > 1) {
    const curPos = cur ? doneCount + 1 : doneCount;
    progIdx.textContent = `(${curPos} / ${total})`;
  } else {
    progIdx.textContent = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream-mode watch-time estimate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the user's download speed in bytes/sec, averaged over the most
 * recent 60 seconds.  Falls back to the short-window EMA for the first
 * minute (when fewer than 60 s of history exist).
 */
function getRollingSpeed() {
  const samples = P.speedSamples;
  if (!samples || samples.length < 2) return P.speed;

  const now    = Date.now();
  const cutoff = now - 60_000; // 1 minute ago

  // Prefer the last-60-s window; if we haven't been running that long, use
  // everything we have since the download began.
  const window60 = samples.filter(s => s.t >= cutoff);
  const pool     = window60.length >= 2 ? window60 : samples;

  if (pool.length < 2) return P.speed;

  const oldest = pool[0];
  const newest = pool[pool.length - 1];
  const dt     = (newest.t - oldest.t) / 1000; // seconds
  if (dt <= 0) return P.speed;

  return (newest.bytes - oldest.bytes) / dt;
}

/**
 * Recalculates and updates the "you can start watching in …" indicator.
 *
 * The maths: given file size S, video duration D (seconds), download speed
 * v (bytes/sec), and bytes already received R, the minimum additional wait
 * time W before uninterrupted playback is possible is:
 *
 *   W = max(0, (S − R) / v − D)
 *
 * Derivation: at wait time W the user starts the player.  For any playback
 * position τ (seconds), the download must have produced ≥ τ·B bytes ahead
 * of the player (B = S/D, the bitrate).  The tightest constraint is at
 * τ = D (end of video), which simplifies to the formula above.
 */
function sparsePlaybackPath(item) {
  const preview = item?.sparsePreview;
  return preview?.state === 'available' ? preview.previewPath : preview?.state === 'published' ? preview.finalPath : null;
}

function clearSparsePreview(item) {
  if (item?.sparsePreview && item.sparsePreview.state !== 'published') {
    item.sparsePreview = { ...item.sparsePreview, state: 'invalidated' };
  }
  P.videoDurationMs = null;
}

function tryLaunchSparseFile() {
  if (P.streamMethod !== 'sparse') return; // http mode is launched via dl:streamUrl
  const launchWhenReady = document.getElementById('cfg-launchWhenReady')?.checked;
  if (!launchWhenReady) return;
  const cur = queue.find(item => item.status === 'running'), preview = cur?.sparsePreview;
  if (!preview || preview.state !== 'available' || preview.fileName !== P.fileName) return;
  if ((cur.sparseLaunched || []).includes(preview.fileName)) return;
  (cur.sparseLaunched ||= []).push(preview.fileName);
  window.api.openFile(preview.previewPath);
}

function updateWatchTime() {
  const watchWrap = document.getElementById('statWatchWrap');
  const watchEl   = document.getElementById('statWatch');
  if (!watchWrap || !watchEl) return;

  // Only show during an active stream-mode download
  if (!P.streamMode) { watchWrap.style.display = 'none'; return; }

  // Keep showing "Scanning…" until mediainfo has returned
  if (!P.videoDurationMs || !P.fileSize) return;

  const v   = getRollingSpeed();
  if (v <= 0) { watchEl.textContent = '—'; return; }

  const S   = P.fileSize;              // total file bytes
  const dur = P.videoDurationMs / 1000; // video duration in seconds
  const B   = S / dur;                  // bitrate (bytes/sec)
  const R   = P.receivedBytes || 0;

  if (v >= B) {
    // Download is faster than the bitrate — can watch right now
    watchEl.textContent = 'Now!';
    tryLaunchSparseFile();
    return;
  }

  const waitSec = Math.max(0, (S - R) / v - dur);
  watchEl.textContent = waitSec < 5 ? 'Now!' : fmtEta(waitSec);
  if (waitSec < 5) tryLaunchSparseFile();
}

function onProgress(data) {
  const { fileName, fileSize, receivedBytes, chunk, totalChunks } = data;

  // First time seeing this file
  if (fileName !== P.fileName) {
    P.fileName       = fileName;
    P.fileSize       = fileSize;
    P.receivedBytes  = 0;
    P.chunk          = chunk;
    P.totalChunks    = totalChunks;
    P.windowBytes    = 0;
    P.windowTime     = Date.now();
    P.speed          = 0;
    P.warmupEndTime  = P.windowTime + 5000;  // ignore first 5s of each file for minSpeed
    if (!P.startTime) P.startTime = Date.now();

    progFilename.textContent = fileName;
    progSize.textContent     = fileSize ? `(${fmtBytes(fileSize)})` : '';
    buildChunkBlocks(totalChunks);
    progFill.classList.remove('indeterminate');
  }

  // Speed: EMA over a ~2s window
  const now = Date.now();
  const dt  = (now - P.windowTime) / 1000;
  if (dt >= 0.5) {
    const rawSpeed = (receivedBytes - P.windowBytes) / dt;
    P.speed      = P.speed ? P.speed * 0.6 + rawSpeed * 0.4 : rawSpeed;
    P.windowBytes = receivedBytes;
    P.windowTime  = now;
    if (P.speed > P.peakSpeed)                                         P.peakSpeed = P.speed;
    if (P.speed > 0 && P.speed < P.minSpeed && now > P.warmupEndTime &&
      (!P.fileSize || receivedBytes < P.fileSize * 0.95))            P.minSpeed  = P.speed;

    // Accumulate a sample for the 1-minute rolling-average speed used by
    // the stream-mode watch-time estimate.
    P.speedSamples = P.speedSamples || [];
    P.speedSamples.push({ t: now, bytes: receivedBytes });
    // Trim entries older than ~70 s to keep the array bounded.
    if (P.speedSamples.length > 250) {
      const trim = now - 70_000;
      P.speedSamples = P.speedSamples.filter(s => s.t >= trim);
    }
  }

  P.receivedBytes = receivedBytes;
  P.chunk         = chunk;
  P.totalChunks   = totalChunks;

  // Chunk blocks
  if (totalChunks > 1) {
    if (Array.isArray(data.completedChunks)) {
      const completed = new Set(data.completedChunks);
      chunkRow.querySelectorAll('.chunk-block').forEach((block, index) => {
        block.className = 'chunk-block' + (completed.has(index + 1) ? ' done' : index === chunk - 1 ? ' active' : '');
      });
    } else updateChunkBlocks(chunk, totalChunks);
    statChunkLbl.style.display = '';
    statChunk.style.display    = '';
    statChunk.textContent      = `${chunk} / ${totalChunks}`;
  }

  // Stats
  statSpeed.textContent = fmtSpeed(P.speed);
  const remaining = fileSize > 0 ? fileSize - receivedBytes : 0;
  statEta.textContent = P.speed > 0 ? fmtEta(remaining / P.speed) : '—';

  // Update the stream-mode watch-time indicator on every tick
  updateWatchTime();
}

function startElapsedTimer() {
  beginDownloadStatusRun();
  if (elapsedTimer) clearInterval(elapsedTimer);
  queueStartTime = Date.now();
  elapsedTimer = setInterval(() => {
    statElapsed.textContent = fmtElapsed(Date.now() - queueStartTime);
  }, 500);
  // Reset queue-level accumulators so each new run starts clean
  P.peakSpeed = 0; P.minSpeed = Infinity;
  P.queueCompletedBytes = 0; P.queueCompletedFiles = 0;
  P.fileDurations = []; P.fileSizes = [];
}
function stopElapsedTimer() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

function resetProgress() {
  P.fileName = ''; P.fileSize = 0; P.receivedBytes = 0;
  P.chunk = 0; P.totalChunks = 0; P.speed = 0;
  P.windowBytes = 0; P.windowTime = 0; P.startTime = 0; P.warmupEndTime = 0;
  P.totalFiles = 0; P.totalBytes = 0;
  P.completedFiles = 0; P.completedBytes = 0;
  P.failedFiles = 0; P.unknownSizeFiles = 0;

  P.videoDurationMs = null;
  P.speedSamples    = [];
  P.streamMode      = false;
  P.launched        = false;

  progFill.classList.add('indeterminate');
  progFill.style.width = '';
  progPct.textContent  = '—%';
  statSpeed.textContent= '— B/s';
  statEta.textContent  = '—';
  // statElapsed is intentionally not reset here — the queue elapsed timer runs continuously
  statChunkLbl.style.display    = 'none';
  statChunk.style.display       = 'none';
  statDecryptWrap.style.display = 'none';
  statDecrypt.textContent       = '—';
  const _watchWrap = document.getElementById('statWatchWrap');
  if (_watchWrap) _watchWrap.style.display = 'none';
  chunkRow.style.display     = 'none';
  batchBar.classList.remove('visible');
  progFilename.textContent = 'Initialising…';
  progSize.textContent     = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Batch info
// ═══════════════════════════════════════════════════════════════════════════════
function onBatchStart({ totalFiles, totalBytes, unknownSizeFiles = 0 }) {
  P.totalFiles     = totalFiles;
  P.totalBytes     = totalBytes;
  P.completedFiles = 0;
  P.completedBytes = 0;
  P.failedFiles = 0;
  P.unknownSizeFiles = unknownSizeFiles;
  batchBar.classList.remove('has-failures');

  if (totalFiles > 1) {
    batchBar.classList.add('visible');
    updateBatchBar();
  }
}

function onFileComplete({ fileName, fileSize, skipped, success, canceled, duration }) {
  P.completedFiles++;
  if (!success && !skipped && !canceled) P.failedFiles++;
  if (success && !canceled) {
    P.completedBytes += fileSize || 0;
    // Verified existing outputs settle the batch without adding new transfer
    // bytes or duration samples to the session's download statistics.
    if (!skipped) {
      P.queueCompletedBytes += fileSize || 0;
      P.queueCompletedFiles++;
      if (duration) P.fileDurations.push(duration);
      if (fileSize) P.fileSizes.push(fileSize);
    }
  }
  updateBatchBar();
  // Write CSV row — suppressed for retried URLs because dl:done / dl:error
  // will update the existing row in place rather than appending a new one.
  if (!skipped && !pendingRetries.has(currentUrl)) {
    const csvPath = dataDirPath
      ? dataDirPath.replace(/[/\\]+$/, '') + '/download_log.csv'
      : (currentOutDir || '').replace(/\/$/, '') + '/download_log.csv';
    window.api.writeCsv({
      csvPath,
      fileName: fileName.split('/').pop(),
      fileSize: fileSize || 0,
      status:   success ? 'success' : (canceled ? 'canceled' : 'error'),
      durationSec: (duration || 0) / 1000,
      timestamp:   new Date().toISOString(),
      megaUrl:     currentUrl,
      outputDir:   currentOutDir || '',
    });
  }
}

function updateBatchBar() {
  if (P.totalFiles <= 1) return;
  batchText.textContent = `Files settled: ${P.completedFiles} / ${P.totalFiles}` + (P.failedFiles ? ` · ${P.failedFiles} failed` : '');
  batchBytes.textContent = `Verified: ${fmtBytes(P.completedBytes)} / ${fmtBytes(P.totalBytes)}` +
    (P.unknownSizeFiles ? ` known (+${P.unknownSizeFiles} size unknown)` : '');
  batchBar.classList.toggle('has-failures', P.failedFiles > 0);
  const pct = P.totalFiles > 0 ? (P.completedFiles / P.totalFiles) * 100 : 0;
  batchFill.style.width  = pct.toFixed(1) + '%';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Download session report
// ═══════════════════════════════════════════════════════════════════════════════
function buildDownloadReportLines() {
  const elapsedMs  = Date.now() - queueStartTime;
  const succeeded  = queue.filter(i => i.status === 'done').length;
  const failed     = queue.filter(i => i.status === 'error').length;
  const skipped    = queue.filter(i => i.status === 'skipped').length;
  const totalQ     = queue.length;
  const totalBytes = P.queueCompletedBytes;
  const avgBps     = elapsedMs > 0 ? (totalBytes / elapsedMs) * 1000 : 0;
  const sep        = '  ' + '─'.repeat(50);
  const out        = [sep, '  ■ DOWNLOAD SESSION REPORT', sep];

  // ── Time & queue summary ─────────────────────────────────────────────────────
  out.push(`  Elapsed time       : ${fmtDuration(elapsedMs)}`);
  out.push(`  Queue items        : ${totalQ}`);
  out.push(`  Succeeded          : ${succeeded}`);
  if (failed)  out.push(`  Failed             : ${failed}`);
  if (skipped) out.push(`  Skipped by user    : ${skipped}`);
  if (totalQ > 1) {
    const rate = Math.round((succeeded / totalQ) * 100);
    out.push(`  Success rate       : ${rate}%  (${succeeded} / ${totalQ})`);
  }

  // ── Throughput ───────────────────────────────────────────────────────────────
  if (totalBytes > 0) {
    out.push(`  Total transferred  : ${fmtBytes(totalBytes)}`);
    if (avgBps > 0)
      out.push(`  Avg throughput     : ${fmtSpeed(avgBps)}`);
    if (P.peakSpeed > 0)
      out.push(`  Peak speed         : ${fmtSpeed(P.peakSpeed)}`);
    if (isFinite(P.minSpeed) && P.minSpeed > 0)
      out.push(`  Min speed          : ${fmtSpeed(P.minSpeed)}`);
    if (P.peakSpeed > 0 && isFinite(P.minSpeed) && P.minSpeed > 0) {
      const ratio = (P.peakSpeed / P.minSpeed).toFixed(1);
      out.push(`  Speed range        : ${fmtSpeed(P.minSpeed)} – ${fmtSpeed(P.peakSpeed)}  (${ratio}× variance)`);
    }
  }

  // ── Per-file time stats ───────────────────────────────────────────────────────
  if (P.fileDurations.length > 0) {
    const durs   = P.fileDurations;
    const sumDur = durs.reduce((a, b) => a + b, 0);
    const avgDur = sumDur / durs.length;
    out.push(`  Files w/ timing    : ${durs.length}`);
    out.push(`  Avg time per file  : ${fmtDuration(avgDur)}`);
    if (durs.length > 1) {
      out.push(`  Fastest file       : ${fmtDuration(Math.min(...durs))}`);
      out.push(`  Slowest file       : ${fmtDuration(Math.max(...durs))}`);
    }
    // Effective per-file throughput (excludes queue overhead, retries, etc.)
    if (P.fileSizes.length === durs.length && sumDur > 0) {
      const sumSz       = P.fileSizes.reduce((a, b) => a + b, 0);
      const fileAvgBps  = sumSz / (sumDur / 1000);
      if (fileAvgBps > 0)
        out.push(`  Avg file speed     : ${fmtSpeed(fileAvgBps)}`);
    }
  }

  // ── Per-file size stats ───────────────────────────────────────────────────────
  if (P.fileSizes.length > 0) {
    const szs   = P.fileSizes;
    const sumSz = szs.reduce((a, b) => a + b, 0);
    out.push(`  Avg file size      : ${fmtBytes(sumSz / szs.length)}`);
    if (szs.length > 1) {
      out.push(`  Largest file       : ${fmtBytes(Math.max(...szs))}`);
      out.push(`  Smallest file      : ${fmtBytes(Math.min(...szs))}`);
    }
  }

  out.push(sep);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Queue runner
// ═══════════════════════════════════════════════════════════════════════════════
function startNextInQueue() {
  const next = queue.find(i => i.status === 'pending');
  if (!next) {
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled  = true;
    downloadStatusRun.phase = 'finished';
    updateDownloadStatus();
    hideProgCard();
    stopElapsedTimer();
    openOutBtn.style.display = '';
    renderQueue();
    dlRenderLiveQueue();
    sysLog('Queue finished.');
    buildDownloadReportLines().forEach(line => appendLog(line, 'll-sys'));
    dlSyncLogVsEntry();
    return;
  }

  next.status = 'running';
  downloadStatusRun.current = downloadStatusRun.items.get(next.id) || trackDownloadItem(next);
  downloadStatusRun.current.outcome = 'running';
  stopBtn.disabled = false;
  next.pct    = 0;
  next.speed  = '';
  currentUrl    = next.url;
  currentOutDir = next.outDir;
  renderQueue();
  dlRenderLiveQueue();

  resetProgress();
  updateQueueProgress();
  showProgCard();
  updateDownloadStatus();

  sysLog(`Starting: ${next.url.slice(0,70)}`);
  sysLog(`Output → ${next.outDir}`);

  const streamMode = document.getElementById('streamModeCheckbox')?.checked || false;
  const streamingChunkSize = parseInt(document.getElementById('cfg-streamingChunkSize')?.value, 10) || 100;
  const streamMethod = document.getElementById('cfg-streamMethod')?.value || 'http';

  // Store stream-mode flag on the shared progress state so updateWatchTime
  // knows whether to show the indicator.
  P.streamMode      = streamMode;
  P.streamMethod    = streamMethod;
  P.videoDurationMs = null; // clear any result from a previous download

  // Also store on the queue item so dlRenderLiveQueue can check it per-item
  next.streamMode   = streamMode;
  next.streamMethod = streamMethod;
  next.sparsePreview = null; next.sparseAttempts = []; next.sparseLaunched = [];

  // Show the watch-time stat immediately with a "Scanning…" placeholder so
  // the user sees the feature is active before mediainfo responds.
  const _watchWrap = document.getElementById('statWatchWrap');
  const _watchEl   = document.getElementById('statWatch');
  if (_watchWrap && _watchEl) {
    const showWatch = streamMode;
    _watchWrap.style.display = showWatch ? '' : 'none';
    if (showWatch) _watchEl.textContent = 'Scanning…';
  }

  window.api.startDownload({ url: next.url, outputDir: next.outDir, relPath: next.relPath, streamMode, streamingChunkSize });
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC listeners
// ═══════════════════════════════════════════════════════════════════════════════
window.api.on('dl:log',      raw  => appendLog(raw));
window.api.on('dl:vpnState', ({ state, message }) => {
  P.vpnPaused = !['resuming', 'deferred'].includes(state);
  P.windowBytes = P.receivedBytes || 0; P.windowTime = Date.now(); P.speed = 0; P.speedSamples = [];
  const cur = queue.find(item => item.status === 'running');
  if (cur) { cur.vpnMessage = P.vpnPaused ? message : ''; cur.speed = ''; }
  if (downloadStatusRun.current) {
    downloadStatusRun.current.vpnState = state;
    downloadStatusRun.current.message = message || '';
  }
  statSpeed.textContent = '—'; statEta.textContent = '—';
  if (running) {
    updateDownloadStatus();
  }
  dlRenderLiveQueue();
});
window.api.on('dl:speed', ({ fileName, speedBps }) => {
  if (P.vpnPaused || !running || fileName && fileName !== P.fileName || !Number.isFinite(speedBps) || speedBps < 0) return;
  P.speed = speedBps; statSpeed.textContent = fmtSpeed(speedBps);
  const cur = queue.find(item => item.status === 'running'); if (cur) cur.speed = fmtSpeed(speedBps);
});
window.api.on('dl:progress', data => {
  // Reset speed window so the EMA doesn't bleed the pre-decrypt speed
  // into the first tick of the next chunk's download.
  if (data.chunk !== P.chunk || data.fileName !== P.fileName || data.receivedBytes < P.receivedBytes || P.vpnPaused) {
    P.windowBytes = data.receivedBytes;
    P.windowTime  = Date.now();
    P.speed       = 0;
    P.speedSamples = [];
  }
  P.vpnPaused = false;
  const resumedItem = queue.find(item => item.status === 'running');
  if (resumedItem?.vpnMessage) { resumedItem.vpnMessage = ''; dlRenderLiveQueue(); }
  const record = downloadStatusRun.current;
  if (record) {
    record.receivedBytes = data.receivedBytes || 0;
    record.fileSize = data.fileSize || 0;
    record.fileName = data.fileName || '';
    record.partials.set(record.fileName, record.receivedBytes);
    record.vpnState = ''; record.message = '';
  }
  // Hide decrypt stat — we're back in download phase
  statDecryptWrap.style.display = 'none';
  onProgress(data);

  // Update the running item's display fields and patch DOM in-place
  const cur = queue.find(i => i.status === 'running');
  if (cur) {
    const pct = data.fileSize > 0 ? Math.min(100, Math.round((data.receivedBytes / data.fileSize) * 100)) : 0;
    cur.pct           = pct;
    cur.speed         = fmtSpeed(P.speed);
    cur.receivedBytes = data.receivedBytes;
    if (data.fileName && !cur.displayName) cur.displayName = data.fileName.split('/').pop();
    if (data.fileSize && !cur.fileSize)    cur.fileSize     = data.fileSize;
    const barEl = document.getElementById('dlb-bar-' + cur.id);
    if (barEl) barEl.style.width = pct + '%';
    const pctEl = document.getElementById('dlb-pct-' + cur.id);
    if (pctEl) pctEl.textContent = pct + '%';
    const recEl = document.getElementById('dlb-rec-' + cur.id);
    if (recEl) {
      recEl.textContent = cur.fileSize
        ? fmtBytes(cur.receivedBytes) + ' / ' + fmtBytes(cur.fileSize)
        : fmtBytes(cur.receivedBytes);
    }
  }
  updateQueueProgress();
  updateDownloadStatus();
});
window.api.on('dl:batchStart', data => {
  onBatchStart(data);
  if (downloadStatusRun.current) downloadStatusRun.current.totalBytes = data.totalBytes || 0;
  const cur = queue.find(i => i.status === 'running');
  if (cur) {
    cur._totalFiles = data.totalFiles;
    if (data.totalFiles === 1) cur.fileSize = data.totalBytes;
  }
});
window.api.on('dl:fileComplete', data => {
  onFileComplete(data);
  const record = downloadStatusRun.current;
  if (record) {
    // Existing verified outputs have success:true, skipped:true. A user skip
    // has success:false and contributes neither bytes nor a failure.
    if (data.success && !data.canceled) record.completedBytes += data.fileSize || 0;
    else if (!data.canceled && !data.skipped) record.failed++;
    record.partials.delete(data.fileName || '');
    record.receivedBytes = 0;
    record.fileName = ''; record.fileSize = 0;
    updateDownloadStatus();
  }
  const cur = queue.find(i => i.status === 'running');
  if (cur && !data.success && !data.skipped && !data.canceled) {
    cur.errorMsg = data.errorMessage
      ? `${data.fileName}: ${data.errorMessage}`
      : `${data.fileName}: download failed.`;
  }
  if (cur && !data.canceled && data.success) {
    const rel = (data.fileName || '').replace(/\\/g, '/');
    // Display name — leaf filename only
    if (!cur.displayName) cur.displayName = rel.split('/').pop() || rel;
    if (data.fileSize)    cur.fileSize     = data.fileSize;

    // For single-file downloads, record the full path so the play button works
    if (cur._totalFiles === 1) {
      const base = cur.outDir.replace(/[/\\]+$/, '');
      cur.fullPath = base + '/' + rel;
      // Folder to open is the directory containing the file
      const parts = rel.split('/');
      parts.pop();
      cur.folderPath = parts.length ? base + '/' + parts.join('/') : base;
    } else {
      // Folder download — open the output dir (or the specific subfolder)
      const parts = rel.split('/');
      parts.pop();
      const base = cur.outDir.replace(/[/\\]+$/, '');
      cur.folderPath = parts.length ? base + '/' + parts.join('/') : base;
    }
  }
});

// ── Decrypt progress ────────────────────────────────────────────────────────
window.api.on('dl:decryptProgress', ({ chunk, totalChunks, bytesDecrypted, totalBytes }) => {
  const pct = totalBytes > 0 ? Math.round((bytesDecrypted / totalBytes) * 100) : 0;

  // Clear speed and ETA — meaningless during decryption
  statSpeed.textContent = '—';
  statEta.textContent   = '—';

  // Show decrypt stat in the stats row
  statDecryptWrap.style.display = '';
  statDecrypt.textContent = `${pct}%`;

  // Transition the active chunk block from amber → rose (decrypting state)
  if (totalChunks > 1) {
    chunkRow.querySelectorAll('.chunk-block').forEach((b, i) => {
      if (i < chunk - 1)       b.className = 'chunk-block done';
      else if (i === chunk - 1) b.className = 'chunk-block decrypting';
      else                      b.className = 'chunk-block';
    });
  }
});

// ── Stream-mode mediainfo result ───────────────────────────────────────────
// Fired by the main process once mediainfo successfully reads the video
// duration from the partially-downloaded sparse file.
window.api.on('dl:mediainfo', result => {
  if (typeof result === 'object' && result) {
    const preview = queue.find(item => item.status === 'running')?.sparsePreview;
    if (!preview || !['started', 'available'].includes(preview.state) || preview.attemptId !== result.attemptId || preview.fileName !== result.fileName) return;
    P.videoDurationMs = result.durationMs;
  } else {
    if (P.streamMethod === 'sparse') return;
    P.videoDurationMs = result;
  }
  updateWatchTime();
});

window.api.on('dl:sparsePreview', data => {
  const cur = queue.find(item => item.status === 'running');
  if (!cur || !cur.streamMode || cur.streamMethod !== 'sparse') return;
  if (data.state === 'started') {
    if ((cur.sparseAttempts || []).includes(data.attemptId)) return;
    (cur.sparseAttempts ||= []).push(data.attemptId);
    cur.sparsePreview = data; delete cur.fullPath; P.videoDurationMs = null;
  } else {
    const previous = cur.sparsePreview;
    if (!previous || previous.attemptId !== data.attemptId || previous.fileName !== data.fileName ||
        !['started', 'available'].includes(previous.state)) return;
    if (!['available', 'invalidated', 'published'].includes(data.state)) return;
    cur.sparsePreview = data;
    if (data.state === 'published') cur.fullPath = data.finalPath;
    if (data.state === 'invalidated') {
      delete cur.fullPath; P.videoDurationMs = null;
      if (data.reason === 'integrity') sysLog('Preview verification failed. This preview is no longer available.');
    }
  }
  cur.folderPath = data.outputFolder || cur.outDir;
  dlRenderLiveQueue(); updateWatchTime();
});

window.api.on('dl:streamUrl', ({ url, m3uPath, outputFolder }) => {
  // Store the m3u path on the running queue item so the play button works
  const cur = queue.find(i => i.status === 'running');
  if (cur) {
    cur.streamM3uPath = m3uPath;
    // Playlists live in staging; the folder button opens the output folder.
    const parts = m3uPath.replace(/\\/g, '/').split('/');
    parts.pop();
    cur.folderPath = outputFolder || (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '/' : (parts.join('/') || cur.outDir));
    dlRenderLiveQueue();
  }
  // The head and tail chunks are on the local HTTP server — open the .m3u
  // playlist so the user's default video player starts streaming immediately.
  const launchWhenReady = document.getElementById('cfg-launchWhenReady')?.checked;
  if (launchWhenReady) window.api.openFile(m3uPath);
});

window.api.on('dl:done', ({ duration, totalFiles, failedFiles, succeededFiles, skipped, canceled }) => {
  const failed = failedFiles || 0;
  P.vpnPaused = false;
  const record = downloadStatusRun.current;
  if (record) {
    record.failed = Math.max(record.failed, failed);
    if (skipped && !record.skipped) record.skipped = 1;
    record.outcome = canceled ? 'stopped' : record.failed ? 'failed' : skipped || record.skipped ? 'skipped' : 'done';
    record.vpnState = ''; record.message = '';
  }
  downloadStatusRun.current = null;
  if (canceled) { running = false; downloadStatusRun.phase = 'stopped'; stopElapsedTimer(); }
  // Mark current queue item done or skipped
  // Stop and Skip optimistically change the row status before this event.
  const cur = queue.find(i => i.status === 'running') || record?.item;
  if (cur) {
    clearSparsePreview(cur);
    if (failed && !cur.errorMsg) cur.errorMsg = `${failed} of ${totalFiles} files failed.`;
    cur.status = canceled || failed ? 'error' : skipped ? 'skipped' : 'done';
    cur.pct = skipped ? 0 : canceled || failed ? cur.pct : 100;
    cur.speed = ''; cur.vpnMessage = '';
  }

  // Advance overall bar to reflect the newly-completed item
  updateQueueProgress();

  statSpeed.textContent= fmtSpeed(0);
  statEta.textContent  = '0s';

  if (skipped) {
    sysLog(`File skipped. Queue continuing…`);
  } else if (canceled) {
    sysLog('Download stopped. Retained partial data can be resumed later.');
  } else {
    if (failed > 0) sysLog(`Done. ${succeededFiles ?? totalFiles - failed}/${totalFiles} files succeeded.`);
    else sysLog(`Done in ${fmtDuration(duration)}.`);
  }

  // Retrying updates the original row. Stop/Skip must not erase failures that
  // were already observed, or leave a stale retry suppressing future CSV rows.
  const retryRow = pendingRetries.get(currentUrl);
  pendingRetries.delete(currentUrl);
  if (retryRow && (!skipped || failed)) {
    const { csvPath, originalTimestamp } = retryRow;
    window.api.updateCsvRow({
      csvPath,
      megaUrl:           currentUrl,
      originalTimestamp,
      updates: {
        status:      failed ? 'error' : canceled ? 'canceled' : 'success',
        durationSec: (duration || 0) / 1000,
        fileName:    cur && cur.displayName ? cur.displayName : undefined,
        fileSize:    cur && cur.fileSize    ? cur.fileSize    : undefined,
        timestamp:   new Date().toISOString(),
      },
    });
  }

  stopBtn.disabled = !running;
  if (!running) { startBtn.disabled = false; downloadStatusRun.phase = 'stopped'; }
  updateDownloadStatus();

  renderQueue();
  dlRenderLiveQueue();

  // Auto-start next after brief pause
   if (running) setTimeout(() => { if (running) startNextInQueue(); }, 800);
});

window.api.on('dl:error', ({ message }) => {
  const record = downloadStatusRun.current;
  if (record) { record.failed = Math.max(1, record.failed); record.outcome = 'failed'; record.message = message; }
  downloadStatusRun.current = null;
  downloadStatusRun.phase = 'paused';
  const cur = queue.find(i => i.status === 'running');
  if (cur) { clearSparsePreview(cur); cur.status = 'error'; cur.errorMsg = message; cur.speed = ''; }

  if (currentUrl) {
    const csvPath = dataDirPath
      ? dataDirPath.replace(/[/\\]+$/, '') + '/download_log.csv'
      : (currentOutDir || '').replace(/\/$/, '') + '/download_log.csv';
    const durationSec = P.startTime ? (Date.now() - P.startTime) / 1000 : 0;

    if (pendingRetries.has(currentUrl)) {
      // Retry attempt also failed — update the existing row, keep it as error
      const { originalTimestamp } = pendingRetries.get(currentUrl);
      pendingRetries.delete(currentUrl);
      window.api.updateCsvRow({
        csvPath,
        megaUrl:           currentUrl,
        originalTimestamp,
        updates: {
          status:      'error',
          durationSec: durationSec,
          timestamp:   new Date().toISOString(),
        },
      });
    } else {
      // Fresh failure — append a new row
      window.api.writeCsv({
        csvPath,
        fileName:    (cur && cur.displayName) ? cur.displayName : currentUrl.split('/').pop() || currentUrl,
        fileSize:    (cur && cur.fileSize) ? cur.fileSize : 0,
        status:      'error',
        durationSec: durationSec,
        timestamp:   new Date().toISOString(),
        megaUrl:     currentUrl,
        outputDir:   currentOutDir || '',
      });
    }
  }

  updateQueueProgress();

  running = false;
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  updateDownloadStatus();
  stopElapsedTimer();
  sysLog(`Error: ${message}`);
  sysLog('Queue paused. Hit ↺ on the failed item to retry it, or Start to skip it and continue.');
  renderQueue();
  dlRenderLiveQueue();
  dlSyncLogVsEntry();
});

// ═══════════════════════════════════════════════════════════════════════════════
// UI event handlers
// ═══════════════════════════════════════════════════════════════════════════════

// Browse output folder
browseDirBtn.addEventListener('click', async () => {
  const p = await window.api.selectFolder();
  if (p) outDirInput.value = p;
});

// ─────────────────────────────────────────────────────────────────────────────
// URL classifier — shared by single-add and bulk-add
// Returns { kind: 'modern' | 'legacy' | 'unrecognized' | 'not-mega', reason? }
// 'modern'       = mega.nz/file/… or /folder/…           — fully supported
// 'legacy'       = mega.nz/#!… or /#F!…                  — supported, but old
// 'unrecognized' = contains mega.nz but doesn't parse     — discard + explain
// 'not-mega'     = no mega.nz hostname at all             — discard silently
// ─────────────────────────────────────────────────────────────────────────────
function classifyMegaUrl(raw) {
  const url = raw.trim();
  if (!url) return { kind: 'not-mega' };

  const hasMegaHost = url.includes('mega.nz') || url.includes('mega.co.nz');
  if (!hasMegaHost) return { kind: 'not-mega' };

  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return { kind: 'unrecognized', reason: 'missing # fragment' };

  const fragment = url.slice(hashIdx + 1);

  // Legacy: /#!ID!KEY  (file)  or  /#F!ID!KEY  (folder)
  if (fragment.startsWith('!') || fragment.startsWith('F!')) {
    return { kind: 'legacy' };
  }

  // Modern: /file/ID#KEY  or  /folder/ID#KEY
  const pathPart  = url.slice(0, hashIdx);
  const segments  = pathPart.replace(/\/$/, '').split('/');
  const linkType  = segments[3]; // index 3 after https: '' 'mega.nz'
  if (linkType === 'file' || linkType === 'folder') {
    return { kind: 'modern' };
  }

  const hint = linkType ? `unexpected path segment "${linkType}"` : 'could not find /file/ or /folder/ in path';
  return { kind: 'unrecognized', reason: hint };
}

// Load .txt file
loadTxtBtn.addEventListener('click', async () => {
  const text = await window.api.selectTxt();
  if (text) bulkTextarea.value = text.trim();
});

// Add all from textarea
addBulkBtn.addEventListener('click', () => {
  const outDir  = outDirInput.value.trim();
  if (!outDir) {
    showToast('⚠ Please choose an output folder before adding to the queue.');
    flashOutputFolder();
    return;
  }

  const rawLines = bulkTextarea.value.split('\n').map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) { sysLog('Paste some links first.'); return; }

  const modern = [], legacy = [], unrecognized = [], notMega = [];

  for (const line of rawLines) {
    const url = resolveObfuscatedUrl(line);
    const { kind, reason } = classifyMegaUrl(url);
    if      (kind === 'modern')       modern.push(url);
    else if (kind === 'legacy')       legacy.push(url);
    else if (kind === 'unrecognized') unrecognized.push({ line: url, reason });
    else                              notMega.push(url);
  }

  const toAdd = [...modern, ...legacy];

  if (toAdd.length === 0) {
    if (unrecognized.length + notMega.length > 0) {
      sysLog(`No recognizable MEGA links found — ${rawLines.length} line(s) discarded.`, 'll-error');
    } else {
      sysLog('No links found. Paste one MEGA URL per line.', 'll-error');
    }
    return;
  }

  toAdd.forEach(url => addToQueue(url, outDir, ''));
  sysLog(`Added ${toAdd.length} URL(s) to queue.`);

  // Legacy notice — shown once covering all legacy links in the batch
  if (legacy.length) {
    const s = legacy.length === 1 ? 'link uses' : 'links use';
    sysLog(`NOTICE  | ${legacy.length} ${s} the old mega.nz/#! format — still supported but deprecated. Consider getting fresh links from MEGA.`, 'll-notice');
  }

  // Unrecognized mega.nz URLs — show count + up to 3 examples
  if (unrecognized.length) {
    sysLog(`Skipped ${unrecognized.length} unrecognized mega.nz URL(s):`, 'll-error');
    unrecognized.slice(0, 3).forEach(({ line, reason }) => {
      const preview = line.length > 72 ? line.slice(0, 69) + '…' : line;
      sysLog(`  ↳ ${preview}  (${reason})`, 'll-error');
    });
    if (unrecognized.length > 3) sysLog(`  ↳ …and ${unrecognized.length - 3} more.`, 'll-error');
  }

  // Non-mega lines — just a count, no per-line dump
  if (notMega.length) {
    sysLog(`Skipped ${notMega.length} line(s) with no mega.nz hostname.`, 'll-error');
  }

  bulkTextarea.value = '';
});

// Start queue
startBtn.addEventListener('click', () => {
  const hasPending = queue.some(i => i.status === 'pending');
  if (!hasPending) { sysLog('Queue is empty. Add some URLs first.'); return; }
  running = true;
  dlSyncLogVsEntry();
  startBtn.disabled = true;
  stopBtn.disabled  = false;
  openOutBtn.style.display = 'none';
  startElapsedTimer();
  startNextInQueue();
});

// Stop
stopBtn.addEventListener('click', () => {
  const cur = queue.find(i => i.status === 'running');
  if (cur) { clearSparsePreview(cur); cur.status = 'error'; cur.errorMsg ||= 'Stopped by user'; cur.speed = ''; }
  running = false;
  downloadStatusRun.phase = downloadStatusRun.current ? 'stopping' : 'stopped';
  updateDownloadStatus();
  stopBtn.disabled  = true;
  startBtn.disabled = !!cur; // stays locked until dl:done confirms the engine has stopped
  stopElapsedTimer();
  window.api.abortDownload();
  sysLog('Stopped by user. Aborting current download…');
  renderQueue();
  dlRenderLiveQueue();
});

// Clear completed items from sidebar queue
clearDoneBtn.addEventListener('click', () => {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].status === 'done') queue.splice(i, 1);
  }
  renderQueue();
  dlRenderLiveQueue();
});

// Clear log
clearLogBtn.addEventListener('click', () => {
  logEl.innerHTML = '';
  dlSyncLogVsEntry();
});

// Open output folder
openOutBtn.addEventListener('click', () => {
  if (currentOutDir) window.api.openFolder(currentOutDir);
});

// ── Link entry zone ────────────────────────────────────────────────────────────
function dlSyncLogVsEntry() {
  const entryZone = document.getElementById('dl-linkEntry');
  const logWrap   = document.getElementById('dl-logWrap');
  if (!entryZone || !logWrap) return;
  const logHasContent = logEl.children.length > 0 && !logEl.querySelector('.log-empty');
  const showLog = running || logHasContent;
  entryZone.style.display = showLog ? 'none' : 'flex';
  logWrap.style.display   = showLog ? ''     : 'none';
}

// Focus border on the link entry textarea
(function () {
  const ta = document.getElementById('dl-linkEntryInput');
  if (!ta) return;
  ta.addEventListener('focus', () => ta.style.borderColor = 'var(--accent)');
  ta.addEventListener('blur',  () => ta.style.borderColor = '');
})();

// "Add to queue" button in the link entry zone
document.getElementById('dl-linkEntryAddBtn').addEventListener('click', () => {
  const ta     = document.getElementById('dl-linkEntryInput');
  const hint   = document.getElementById('dl-linkEntryHint');
  const outDir = outDirInput.value.trim();
  if (!outDir) {
    showToast('⚠ Please choose an output folder before adding to the queue.');
    flashOutputFolder();
    hint.textContent  = '⚠ Set an output folder in the sidebar first.';
    hint.style.color  = 'var(--red)';
    setTimeout(() => {
      hint.textContent = 'Set your output folder in the sidebar first.';
      hint.style.color = '';
    }, 3000);
    return;
  }
  const urls = ta.value.split('\n').map(l => resolveObfuscatedUrl(l.trim())).filter(Boolean);
  if (!urls.length) return;
  let added = 0;
  urls.forEach(url => { if (addToQueue(url, outDir, '')) added++; });
  if (added) ta.value = '';
});

// "Download Now" button — adds to queue and immediately starts
document.getElementById('dl-linkEntryDownloadNowBtn').addEventListener('click', () => {
  const ta     = document.getElementById('dl-linkEntryInput');
  const hint   = document.getElementById('dl-linkEntryHint');
  const outDir = outDirInput.value.trim();
  if (!outDir) {
    showToast('⚠ Please choose an output folder before adding to the queue.');
    flashOutputFolder();
    hint.textContent = '⚠ Set an output folder in the sidebar first.';
    hint.style.color = 'var(--red)';
    setTimeout(() => {
      hint.textContent = 'Set your output folder in the sidebar first.';
      hint.style.color = '';
    }, 3000);
    return;
  }
  const urls = ta.value.split('\n').map(l => resolveObfuscatedUrl(l.trim())).filter(Boolean);
  if (!urls.length) return;
  let added = 0;
  urls.forEach(url => { if (addToQueue(url, outDir, '')) added++; });
  if (added) ta.value = '';
  if (!running && queue.some(i => i.status === 'pending')) {
    running = true;
    dlSyncLogVsEntry();
    startBtn.disabled = true;
    stopBtn.disabled  = false;
    openOutBtn.style.display = 'none';
    startElapsedTimer();
    startNextInQueue();
  }
});

// "Stream" button — checks the Stream Mode checkbox, adds to queue, and immediately starts
document.getElementById('dl-linkEntryStreamBtn').addEventListener('click', () => {
  const ta     = document.getElementById('dl-linkEntryInput');
  const hint   = document.getElementById('dl-linkEntryHint');
  const outDir = outDirInput.value.trim();
  if (!outDir) {
    showToast('⚠ Please choose an output folder before adding to the queue.');
    flashOutputFolder();
    hint.textContent = '⚠ Set an output folder in the sidebar first.';
    hint.style.color = 'var(--red)';
    setTimeout(() => {
      hint.textContent = 'Set your output folder in the sidebar first.';
      hint.style.color = '';
    }, 3000);
    return;
  }
  const urls = ta.value.split('\n').map(l => resolveObfuscatedUrl(l.trim())).filter(Boolean);
  if (!urls.length) return;
  let added = 0;
  urls.forEach(url => { if (addToQueue(url, outDir, '')); added++; });
  if (added) ta.value = '';
  if (!running && queue.some(i => i.status === 'pending')) {
    const streamCheckbox = document.getElementById('streamModeCheckbox');
    if (streamCheckbox) {
      streamCheckbox.checked = true;
    }
    running = true;
    dlSyncLogVsEntry();
    startBtn.disabled = true;
    stopBtn.disabled  = false;
    openOutBtn.style.display = 'none';
    startElapsedTimer();
    startNextInQueue();
  }
});

// Ctrl/Cmd+Enter in the textarea submits too
document.getElementById('dl-linkEntryInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    document.getElementById('dl-linkEntryAddBtn').click();
  }
});

// Initial state
dlSyncLogVsEntry();

// ═══════════════════════════════════════════════════════════════════════════════
// Tab switching (Download | Upload | Settings)
// ═══════════════════════════════════════════════════════════════════════════════
const downloadPanel = document.getElementById('downloadPanel');
const settingsPanel = document.getElementById('settingsPanel');
const uploadPanel   = document.getElementById('uploadPanel');
const dlSidebar     = document.getElementById('dlSidebar');
const upSidebar     = document.getElementById('upSidebar');

document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const t = tab.dataset.tab;
    dlSidebar.style.display = t === 'download' ? '' : 'none';
    upSidebar.style.display = t === 'upload'   ? '' : 'none';
    downloadPanel.classList.toggle('hidden', t !== 'download');
    uploadPanel.classList.toggle('hidden',   t !== 'upload');
    settingsPanel.classList.toggle('active', t === 'settings');
    document.getElementById('mailPanel').hidden = t !== 'inbox';
  });
});
