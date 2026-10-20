/* Global, read-only Proton output viewer. Opening it never invokes Proton. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('vpn-terminal'), output = $('vpn-terminal-output'), follow = $('vpn-terminal-follow');
  let events = [], cursor = 0, first = 1, snapshot = null, state = null, opener = null;
  let reading = false, dirty = false, redraw = false, clock = null, destroyed = false;
  let selectionHeld = false;
  const names = { connected: 'Connected', disconnected: 'Disconnected', disabled: 'Control off',
    waiting: 'Waiting', attention: 'Needs attention', checking: 'Checking status', connecting: 'Connecting',
    recovering: 'Recovering', switching: 'Switching server' };
  // Raw export stays in the main process. Strip control sequences only from
  // display; textContent prevents HTML, URLs and tracebacks becoming markup.
  const display = text => String(text).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  function feedback(message) { $('vpn-terminal-feedback').textContent = message; $('vpn-terminal-feedback').hidden = !message; }
  function setFollow(value) { follow.checked = value; $('vpn-terminal-latest').hidden = value; }
  function context() {
    if (!state) return;
    const ctl = state.controller, uncertain = ctl.status?.state === 'unknown' && ctl.settings?.enabled;
    $('vpn-terminal-state').textContent = uncertain ? 'Proton status unavailable' : names[ctl.state] || ctl.state;
    $('vpn-terminal-state').classList.toggle('vpn-terminal-warning', uncertain || ['waiting', 'attention'].includes(ctl.state));
    const last = ctl.lastConfirmed;
    $('vpn-terminal-confirmed').textContent = last ? 'Last confirmed: ' + (last.status?.server?.id || last.status?.state || 'unknown') +
      ' · ' + new Date(last.time).toLocaleString() : 'No confirmed Proton status yet';
    const next = ctl.connectionProgress?.nextRetryAt || ctl.statusUncertainty?.nextRetryAt;
    $('vpn-terminal-retry').textContent = next ? 'Retry in ' + Math.max(0, Math.ceil((next - Date.now()) / 1000)) + 's' : '';
  }
  function progress() {
    context();
    const commands = snapshot?.active || [];
    $('vpn-terminal-progress').textContent = commands.length ? commands.map(command =>
      '#' + command.id + ' running · ' + Math.max(0, (Date.now() - command.startedAt) / 1000).toFixed(1) + 's' +
      (command.outputBytes ? '' : ' · No output yet')).join(' | ') : events.length ? 'No Proton command running.' : 'Waiting for command output.';
  }
  function render() {
    redraw = false;
    if (!dialog.open) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && output.contains(selection.anchorNode)) { selectionHeld = true; return; }
    selectionHeld = false;
    const scrollTop = output.scrollTop;
    const fragment = document.createDocumentFragment();
    let previous = null;
    for (const event of events) {
      // Join split pipe chunks so a single printed line stays a single line.
      if (previous && ['stdout', 'stderr'].includes(event.kind) && previous.event.kind === event.kind && previous.event.commandId === event.commandId) {
        previous.raw += event.text; previous.code.textContent = display(previous.raw); continue;
      }
      const row = document.createElement('div'); row.className = 'vpn-terminal-line vpn-terminal-' + event.kind;
      if (event.code === 'TIMEOUT' || event.phase === 'unconfirmed') row.classList.add('vpn-terminal-warning');
      const time = document.createElement('time'); time.dateTime = new Date(event.time).toISOString(); time.textContent = new Date(event.time).toLocaleTimeString();
      const label = document.createElement('span'); label.className = 'vpn-terminal-source';
      label.textContent = ({ stdout: 'OUT', stderr: 'ERR', cmd: 'CMD', m3: 'M3' })[event.kind] || 'M3';
      label.title = event.commandId ? 'Command #' + event.commandId : 'M3 VPN coordinator';
      const code = document.createElement('code');
      code.textContent = (event.kind === 'cmd' ? '#' + event.commandId + '  ' : event.kind === 'm3' && event.commandId ? '#' + event.commandId + '  ' : '') + display(event.text) +
        (event.phase === 'start' ? ' · deadline ' + (event.deadlineMs / 1000) + 's' : '');
      row.append(time, label, code); fragment.append(row); previous = { event, code, raw: event.text };
    }
    if (!events.length) { const empty = document.createElement('div'); empty.className = 'vpn-terminal-empty'; empty.textContent = 'No Proton commands captured yet. Output will appear here when M3 runs a Proton command.'; fragment.append(empty); }
    output.replaceChildren(fragment);
    output.scrollTop = follow.checked ? output.scrollHeight : scrollTop;
    const notices = [];
    if (snapshot?.dropped) notices.push(snapshot.dropped + ' earlier events expired from the session buffer.');
    if (snapshot?.diskError) notices.push('Some rolling log output could not be saved; session capture continues.');
    if (snapshot?.diskDropped) notices.push(snapshot.diskDropped + ' events omitted from rolling files because disk writing fell behind.');
    $('vpn-terminal-retention').textContent = notices.join(' '); $('vpn-terminal-retention').hidden = !notices.length;
    $('vpn-terminal-size').textContent = ((snapshot?.bytes || 0) / 1024).toFixed(1) + ' KiB retained';
    progress();
  }
  function scheduleRender() { if (!redraw && dialog.open) { redraw = true; requestAnimationFrame(render); } }
  async function read() {
    dirty = true;
    if (reading || !dialog.open || destroyed) return;
    reading = true;
    try {
      do {
        dirty = false;
        const next = await window.api.vpnTerminalRead(cursor);
        // A main-process restart is unusual but must not strand an old cursor.
        if (snapshot && snapshot.session !== next.session) { events = []; cursor = 0; }
        snapshot = next; first = next.first;
        events = events.filter(event => event.seq >= first);
        for (const event of next.events) if (event.seq > cursor) { events.push(event); cursor = event.seq; }
        cursor = Math.max(cursor, next.cursor);
        dirty ||= next.hasMore;
        scheduleRender();
      } while (dirty && dialog.open && !destroyed);
    } catch { feedback('VPN output could not be loaded. Close and reopen the terminal to try again.'); }
    finally { reading = false; }
  }
  function open() {
    if (dialog.open) return;
    opener = document.activeElement; feedback(''); dialog.showModal();
    render(); clock = setInterval(progress, 250); read();
  }
  function close() { dialog.close(); }
  dialog.addEventListener('close', () => { clearInterval(clock); clock = null; opener?.focus({ preventScroll: true }); });
  // Native dialog provides modal focus trapping and Escape handling.
  let backdropDown = false;
  dialog.addEventListener('pointerdown', event => { backdropDown = event.target === dialog; });
  dialog.addEventListener('click', event => { if (backdropDown && event.target === dialog) close(); backdropDown = false; });
  $('vpn-terminal-close').addEventListener('click', close);
  $('vpn-terminal-settings').addEventListener('click', () => {
    close(); document.querySelector('.tab[data-tab="settings"]')?.click();
    $('vpn-settings-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  follow.addEventListener('change', () => { setFollow(follow.checked); if (follow.checked) output.scrollTop = output.scrollHeight; });
  $('vpn-terminal-latest').addEventListener('click', () => { setFollow(true); output.scrollTop = output.scrollHeight; });
  output.addEventListener('scroll', () => { if (output.scrollHeight - output.scrollTop - output.clientHeight > 24 && follow.checked) setFollow(false); });
  document.addEventListener('selectionchange', () => { if (selectionHeld) scheduleRender(); });
  const resize = new ResizeObserver(() => { if (dialog.open && follow.checked) output.scrollTop = output.scrollHeight; });
  resize.observe(output);
  for (const action of ['copy', 'save']) $('vpn-terminal-' + action).addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; feedback('');
    try {
      const result = await window.api[action === 'copy' ? 'vpnTerminalCopy' : 'vpnTerminalSave']();
      if (!result.canceled) feedback(result.ok ? action === 'copy' ? 'Retained session log copied.' : 'Retained session log saved.' : result.message);
    } catch { feedback('The VPN log could not be ' + (action === 'copy' ? 'copied.' : 'saved.')); }
    finally { button.disabled = false; }
  });
  const unsubscribeLogs = window.api.on('vpn:terminal-changed', () => { if (dialog.open) read(); });
  const unsubscribeState = window.api.on('vpn:state', next => { state = next; if (dialog.open) context(); });
  window.api.vpnGetState().then(next => { state ||= next; }).catch(() => {});
  window.addEventListener('beforeunload', () => { destroyed = true; clearInterval(clock); resize.disconnect(); unsubscribeLogs?.(); unsubscribeState?.(); });
  window.vpnTerminal = { open };
})();
