'use strict';

// ── Update notification ────────────────────────────────────────────────────────
(function () {
  const UPDATE_PASSWORD = 'harry.lime';
  let _updateData = null;

  // Inject styles for the update button and modal
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .up-subtab--update {
      background: var(--accent2) !important;
      color: #fff !important;
      box-shadow: none !important;
      margin-left: 6px;
    }
    .up-subtab--update:hover {
      background: var(--accent2) !important;
      color: #fff !important;
      opacity: 0.88;
    }
    #updateOverlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
    }
    #updateOverlay .update-modal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      max-width: 520px; width: 90%;
      display: flex; flex-direction: column;
      max-height: 80vh;
      user-select: text; -webkit-user-select: text;
    }
    #updateOverlay .update-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      user-select: none; -webkit-user-select: none;
    }
    #updateOverlay .update-modal-title {
      font-weight: 600; font-size: 14px; color: var(--hi);
    }
    #updateOverlay .update-modal-close {
      background: none; border: none; cursor: pointer;
      color: var(--text2); font-size: 15px; padding: 0 2px; line-height: 1;
      user-select: none; -webkit-user-select: none;
    }
    #updateOverlay .update-modal-body {
      padding: 18px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 14px;
      font-size: 13px; line-height: 1.6; color: var(--text);
    }
    #updateOverlay .update-modal-notes { white-space: pre-wrap; }
    #updateOverlay .update-modal-pw {
      border-top: 1px solid var(--border);
      padding-top: 12px;
      font-family: var(--mono); font-size: 12px; color: var(--text2);
    }
  `;
  document.head.appendChild(styleEl);

  function buildModal() {
    const overlay = document.createElement('div');
    overlay.id = 'updateOverlay';

    const modal = document.createElement('div');
    modal.className = 'update-modal';

    // Header — hardcoded title + close button
    const header = document.createElement('div');
    header.className = 'update-modal-header';
    const title = document.createElement('span');
    title.className = 'update-modal-title';
    title.textContent = 'Update Available — Password: harry.lime';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'update-modal-close';
    closeBtn.textContent = '✕';
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body
    const body = document.createElement('div');
    body.className = 'update-modal-body';

    // Middle — notes from the Gist (version, download link, etc.)
    const notesEl = document.createElement('div');
    notesEl.className = 'update-modal-notes';
    const rawNotes = _updateData ? (_updateData.notes || '') : '';
    // Parse **bold** and bare URLs into DOM nodes — no innerHTML needed
    const urlPattern = /https?:\/\/[^\s]+/g;
    const boldPattern = /\*\*(.+?)\*\*/g;
    function parseNotesLine(text) {
      const frag = document.createDocumentFragment();
      // Split on URLs first, then handle bold within non-URL segments
      const parts = text.split(urlPattern);
      const urls  = text.match(urlPattern) || [];
      parts.forEach((part, i) => {
        // Render bold within plain text segments
        const boldParts = part.split(boldPattern);
        boldParts.forEach((bp, j) => {
          if (j % 2 === 1) {
            const strong = document.createElement('strong');
            strong.textContent = bp;
            frag.appendChild(strong);
          } else if (bp) {
            frag.appendChild(document.createTextNode(bp));
          }
        });
        // Append the URL that followed this segment, if any
        if (urls[i]) {
          const a = document.createElement('a');
          a.textContent = urls[i];
          a.href = '#';
          a.style.cssText = 'color:var(--accent);word-break:break-all;cursor:pointer';
          a.addEventListener('click', e => {
            e.preventDefault();
            window.api.openExternal(urls[i]);
          });
          frag.appendChild(a);
        }
      });
      return frag;
    }
    rawNotes.split('\n').forEach((line, idx, arr) => {
      notesEl.appendChild(parseNotesLine(line));
      if (idx < arr.length - 1) notesEl.appendChild(document.createElement('br'));
    });

    // Bottom — hardcoded password
    const pwEl = document.createElement('div');
    pwEl.className = 'update-modal-pw';
    pwEl.textContent = `Download Password: ${UPDATE_PASSWORD}`;

    body.appendChild(notesEl);
    body.appendChild(pwEl);
    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() { overlay.remove(); }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    }
    document.addEventListener('keydown', onKey);
  }

  function showUpdateModal() {
    const existing = document.getElementById('updateOverlay');
    if (existing) existing.remove();
    buildModal();
  }

  function addUpdateButton(bar) {
    if (!bar || bar.querySelector('.up-subtab--update')) return;
    const btn = document.createElement('button');
    btn.className = 'up-subtab up-subtab--update';
    btn.textContent = '⬆ Update Available';
    btn.addEventListener('click', showUpdateModal);
    bar.appendChild(btn);
  }

  window.api.on('app:updateAvailable', data => {
    _updateData = data;
    addUpdateButton(document.getElementById('dl-tabProgress')?.closest('.up-subtab-bar'));
    addUpdateButton(document.getElementById('up-tabProgress')?.closest('.up-subtab-bar'));
  });
})();

init();

// ─── Obfuscated-URL resolver ──────────────────────────────────────────────────
/**
 * If `raw` doesn't contain "mega", assume it is base64-encoded and try decoding
 * up to 3 times. Handles URL-safe base64 (- and _) and missing padding.
 * Returns the decoded URL if "mega" is found, otherwise returns the original string.
 */
function resolveObfuscatedUrl(raw) {
  const s = raw.trim();
  if (!s || /mega/i.test(s)) return s;

  let current = s;
  for (let i = 0; i < 3; i++) {
    try {
      const b64     = current.replace(/-/g, '+').replace(/_/g, '/');
      const padded  = b64 + '='.repeat((4 - b64.length % 4) % 4);
      const decoded = atob(padded).trim();
      if (/mega/i.test(decoded)) return decoded;
      current = decoded;
    } catch {
      break; // not valid base64, stop early
    }
  }

  return s; // 'mega' never appeared — return original and let validation handle it
}

