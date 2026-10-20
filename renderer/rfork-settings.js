'use strict';
(() => {
  const { fields, normalizeRforkSettings, summarizeRforkSettings } = window.RforkSettings;
  const card = document.getElementById('stg-rforkUploads');
  const sections = { basic: card.querySelector('[data-rfork-basic]'), advanced: card.querySelector('[data-rfork-advanced]'), recovery: card.querySelector('[data-rfork-recovery]') };
  const controls = {};
  let defaultCheckpointRoot = 'M3 private local profile (default)';
  for (const f of fields) {
    const row = document.createElement('div'); row.className = 'stg-row';
    const label = document.createElement('label'); label.htmlFor = 'cfg-rfork-' + f.key; label.textContent = f.label;
    const wrap = document.createElement('div');
    const input = document.createElement(f.type === 'select' ? 'select' : 'input');
    input.id = label.htmlFor; input.className = f.type === 'select' ? 'font-select' : 'fi';
    if (f.type === 'select') for (const option of f.options) { const el = document.createElement('option'); el.value = el.textContent = option; input.appendChild(el); }
    else {
      input.type = f.type === 'boolean' ? 'checkbox' : f.type === 'number' ? 'number' : 'text';
      if (f.type === 'number') { input.min = f.min; input.max = f.max; input.step = f.integer ? '1' : 'any'; }
    }
    if (f.key === 'checkpointRoot') input.readOnly = true;
    wrap.appendChild(input);
    if (f.key === 'checkpointRoot') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm'; button.textContent = 'Change location';
      button.addEventListener('click', async () => {
        try { const p = await window.api.chooseRforkCheckpointRoot(); if (p) { input.value = p; refresh(); } }
        catch (e) { status.textContent = e.message; }
      }); wrap.appendChild(button);
    }
    if (f.help) { const help = document.createElement('div'); help.className = 'stg-hint'; help.textContent = f.help; wrap.appendChild(help); }
    controls[f.key] = input; input.addEventListener('input', refresh); input.addEventListener('change', refresh);
    row.append(label, wrap); sections[f.recovery ? 'recovery' : f.basic ? 'basic' : 'advanced'].appendChild(row);
  }
  const status = card.querySelector('[data-rfork-summary]');
  function readDraft() {
    const draft = { schemaVersion: 1 };
    for (const f of fields) {
      const el = controls[f.key];
      draft[f.key] = f.type === 'boolean' ? el.checked : f.type === 'number' ? (el.value.trim() === '' ? NaN : Number(el.value)) : el.value;
    }
    return normalizeRforkSettings(draft);
  }
  function refresh() {
    controls.bundleSizeMiB.disabled = !controls.bundling.checked;
    controls.readBufferMiB.disabled = controls.resume.checked;
    controls.checkpointIntervalSeconds.disabled = !controls.resume.checked;
    try { status.textContent = summarizeRforkSettings(readDraft()); status.style.color = ''; }
    catch (e) { status.textContent = e.message; status.style.color = 'var(--danger, #c54b4b)'; }
  }
  function apply(value) {
    const s = normalizeRforkSettings(value);
    for (const f of fields) { if (f.type === 'boolean') controls[f.key].checked = s[f.key]; else controls[f.key].value = s[f.key]; }
    controls.checkpointRoot.placeholder = defaultCheckpointRoot; refresh();
  }
  card.querySelector('[data-rfork-reset]').addEventListener('click', () => apply());
  apply();
  window.api.rforkSettingsInfo().then(info => { defaultCheckpointRoot = info.checkpointRoot; controls.checkpointRoot.placeholder = defaultCheckpointRoot; card.querySelector('h3').textContent = 'rfork Uploads · ' + info.version; }).catch(() => {});
  window.rforkSettingsUI = { readDraft, apply };
})();
