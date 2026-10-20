'use strict';
(() => {
  const dialog = document.getElementById('rfork-recovery-dialog');
  const list = dialog.querySelector('[data-recovery-list]');
  const status = dialog.querySelector('[data-recovery-status]');
  let busy = false, currentId;
  const close = dialog.querySelector('[data-recovery-close]');
  async function refresh() {
    list.replaceChildren();
    const entries = await window.api.listRforkRecovery();
    if (!entries.length) { const p = document.createElement('p'); p.textContent = 'No interrupted uploads need recovery.'; list.appendChild(p); }
    for (const entry of entries) {
      const card = document.createElement('div'); card.className = 'stg-card';
      const detail = document.createElement('p'); detail.style.whiteSpace = 'pre-wrap'; detail.textContent = `Account: ${entry.account}\nDestination: /${entry.destination}\nSource: ${entry.source}\nState: ${entry.state}${entry.resumable ? '\nCheckpoint retained' : '\nEarlier upload has no restart checkpoint'}`;
      card.appendChild(detail);
      const password = document.createElement('input'); password.type = 'password'; password.autocomplete = 'off'; password.className = 'fi'; password.placeholder = 'Original account password (optional if saved in M3)'; password.setAttribute('aria-label', 'Original account password');
      if (entry.resumable) {
        card.appendChild(password);
        const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'btn btn-accent'; resume.textContent = 'Resume original transfer'; resume.disabled = busy;
        resume.addEventListener('click', async () => {
          if (busy) return; busy = true; currentId = entry.id; close.disabled = true;
          list.querySelectorAll('button').forEach(el => { el.disabled = true; });
          status.textContent = 'Verifying source and checkpoint…';
          try {
            const result = await window.api.resumeRforkUpload({ id: entry.id, password: password.value });
            password.value = ''; status.textContent = result.ok ? 'Upload verified and recorded.' : result.error;
          } catch (e) { status.textContent = e.message; }
          finally { busy = false; currentId = null; close.disabled = false; await refresh(); }
        }); card.appendChild(resume);
      }
      const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'btn btn-ghost'; inspect.textContent = 'Inspect / discard hold'; inspect.disabled = busy;
      inspect.addEventListener('click', async () => {
        if (busy) return;
        try { const result = await window.api.discardRforkRecovery(entry.id); status.textContent = result.ok ? 'Hold discarded; private checkpoint files retained.' : result.error; await refresh(); }
        catch (e) { status.textContent = e.message; }
      }); card.appendChild(inspect); list.appendChild(card);
    }
  }
  document.getElementById('up-rforkRecovery').addEventListener('click', async () => {
    status.textContent = ''; if (!dialog.open) dialog.showModal();
    try { await refresh(); } catch (e) { status.textContent = e.message; }
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.querySelector('[data-recovery-stop]').addEventListener('click', () => window.api.killQueue());
  window.api.on('up:recoveryProgress', value => {
    if (value.id === currentId) status.textContent = `Current attempt: ${value.bytes.toLocaleString()} payload bytes · ${value.speed}. Restored progress is confirmed at completion.`;
  });
})();
