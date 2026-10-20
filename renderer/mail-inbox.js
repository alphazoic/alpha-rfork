'use strict';

(() => {
  const el = id => document.getElementById('mail-' + id), panel = document.getElementById('mailPanel');
  let state = { connections: [] }, messages = [], selectedMessage = null, selectedDomain = null;
  let cursor = null, domainCursor = null, domainAfter = null, timer, debounce, domainDebounce;
  let listRevision = 0, domainRevision = 0, readRevision = 0, initialized = false, syncing = false;
  const active = () => !panel.hidden && !document.hidden;
  const checked = result => { if (!result?.ok) throw new Error(result?.error || 'Inbox request failed.'); return result; };
  const identity = message => message.connection_id + ':' + message.id;
  const date = value => new Date(value).toLocaleString();
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text !== undefined) n.textContent = text;
    if (className) n.className = className; return n;
  }
  function status(text, error = false) { el('status').textContent = text; el('status').classList.toggle('mail-error', error); }
  function connection(id) { return state.connections.find(item => item.id === id); }
  function options(select, first, value) {
    const nodes = [new Option(first, '')];
    for (const item of state.connections) nodes.push(new Option(item.label, item.id));
    select.replaceChildren(...nodes); select.value = value || '';
  }
  function storageNote(item) {
    el('storage-note').textContent = item?.storage === 'encrypted' ? 'Token saved using OS-protected encryption.' :
      item?.storage === 'local' ? 'Token saved locally in your user-data folder.' :
      item?.tokenUnavailable ? 'The previously encrypted token could not be read. Enter it once to save it again.' :
      'Your token will be saved automatically, using OS-protected encryption when available or your user-data folder otherwise.';
  }
  function fillConnection() {
    const item = connection(el('connections').value);
    el('name').value = item?.label || ''; el('url').value = item?.url || ''; el('token').value = '';
    el('token').placeholder = item?.hasToken ? 'Saved token — leave blank to keep' : 'Worker access token';
    storageNote(item); managementAvailability();
  }
  function managementAvailability() {
    const item = connection(el('connections').value);
    el('disconnect').disabled = !item;
    el('add').disabled = !item?.hasToken || item.version === 1;
    el('add-note').textContent = item?.version === 1 ?
      'This is a legacy single-domain Worker. Export the setup files and upgrade it before adding domains.' :
      'Add domains to this connection, then configure each catch-all rule in Cloudflare. Delivery is confirmed separately with a test email.';
  }
  function updateState(next, choose, fill = false) {
    state = next;
    const current = choose !== undefined ? choose : el('connections').value;
    const source = el('source-filter').value;
    options(el('connections'), 'New connection…', current);
    options(el('source-filter'), 'All connections', source);
    if (fill) fillConnection(); else { storageNote(connection(el('connections').value)); managementAvailability(); }
    el('refresh').disabled = !state.connections.some(item => item.hasToken) || syncing;
    el('connection-problems').textContent = state.connections.filter(item => item.error)
      .map(item => item.label + ': ' + item.error).join('\n');
    if (!selectedDomain) el('domain-label').textContent = 'All domains · ' +
      state.connections.reduce((total, item) => total + item.domainCount, 0) + ' domains across ' + state.connections.length + ' connections';
  }
  function schedule() {
    clearTimeout(timer);
    const runnable = state.connections.some(item => item.pending && !item.error && item.hasToken);
    if (active() && state.connections.some(item => item.hasToken)) timer = setTimeout(() => refresh(false), runnable ? 800 : 15000);
  }
  function clearReader() {
    ++readRevision; selectedMessage = null;
    el('reader').replaceChildren(node('p', 'Select a message to read it.', 'mail-placeholder'));
  }
  function renderList() {
    const fragment = document.createDocumentFragment(), scroll = el('list').parentElement.scrollTop;
    for (const item of messages) {
      const row = node('div'); row.setAttribute('role', 'listitem');
      const button = node('button', undefined, 'mail-message'); button.type = 'button';
      button.classList.toggle('selected', identity(item) === selectedMessage);
      button.setAttribute('aria-pressed', String(identity(item) === selectedMessage));
      button.append(node('strong', item.subject || '(No subject)'), node('span', item.sender),
        node('span', 'To: ' + item.recipient, 'mail-recipient'), node('span', item.domain, 'mail-domain-badge'),
        node('time', date(item.received_at)));
      button.addEventListener('click', () => read(item)); row.append(button); fragment.append(row);
    }
    el('list').replaceChildren(fragment); el('list').parentElement.scrollTop = scroll;
    el('empty').hidden = messages.length > 0;
    el('empty').textContent = state.connections.length ? 'No matching mail in the local inbox. Refresh to sync messages delivered to your Workers.' : 'No mail connections yet.';
    el('more').hidden = !cursor;
  }
  async function read(item) {
    const revision = ++readRevision; selectedMessage = identity(item); renderList();
    el('reader').replaceChildren(node('p', 'Loading message…', 'mail-placeholder'));
    try {
      const { message } = checked(await window.api.mailRead({ connectionId: item.connection_id, id: item.id }));
      if (revision !== readRevision) return;
      const header = node('header', undefined, 'mail-message-head');
      header.append(node('h2', message.subject || '(No subject)'), node('p', 'From: ' + message.sender),
        node('p', 'To: ' + message.recipient), node('p', 'Domain: ' + (message.domain || item.domain)),
        node('p', date(message.received_at)));
      const body = node('pre', message.body || '(Empty message)', 'mail-message-body'), links = node('div', undefined, 'mail-links');
      for (const raw of Array.isArray(message.links) ? message.links : []) {
        let url; try { url = new URL(raw); } catch { continue; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        const button = node('button', url.href, 'mail-link'); button.type = 'button';
        button.addEventListener('click', () => window.api.openExternal(url.href)); links.append(button);
      }
      if (links.childElementCount) links.prepend(node('h3', 'Links in this message'));
      el('reader').replaceChildren(header, body, links);
      if (message.attachments?.length) el('reader').append(node('p', 'Attachments (not stored): ' + message.attachments.join(', '), 'mail-attachment-note'));
    } catch (error) { if (revision === readRevision) el('reader').replaceChildren(node('p', error.message, 'mail-error')); }
  }
  function filters() {
    return { connectionId: selectedDomain?.connection_id || el('source-filter').value,
      domain: selectedDomain?.name, recipient: el('recipient').value, q: el('search').value };
  }
  async function loadMessages({ older = false, preserve = false } = {}) {
    const revision = ++listRevision;
    const result = checked(await window.api.mailList({ ...filters(), before: older ? cursor : null }));
    if (revision !== listRevision) return;
    updateState(result.state);
    const combined = older ? [...messages, ...result.messages] : preserve ? [...result.messages, ...messages] : result.messages;
    messages = [...new Map(combined.filter(item => item.expires_at > Date.now()).map(item => [identity(item), item])).values()]
      .sort((a, b) => b.received_at - a.received_at || (a.connection_id < b.connection_id ? -1 : a.connection_id > b.connection_id ? 1 : 0) || b.id - a.id);
    if (!preserve || !cursor) cursor = result.nextCursor;
    renderList();
  }
  function domainStatus(item) {
    const source = connection(item.connection_id);
    if (source?.error) return 'Connection error';
    if (!item.enabled) return 'Receiving disabled';
    if (source?.version === 1) return 'Legacy Worker';
    if (item.last_test_received_at && item.last_test_received_at >= (item.test_requested_at || 0)) return 'Receiving confirmed';
    if (!item.test_requested_at && !item.last_received_at) return 'Setup incomplete';
    return 'Awaiting test email';
  }
  async function domainDetails() {
    if (!selectedDomain) { el('domain-details').hidden = true; return; }
    const selection = selectedDomain;
    const result = checked(await window.api.mailDomains({ connectionId: selection.connection_id, name: selection.name }));
    if (selectedDomain !== selection) return;
    const found = result.domains.find(item => item.name === selectedDomain.name);
    if (found) selectedDomain = found;
    const item = selectedDomain, legacy = connection(item.connection_id)?.version === 1;
    el('domain-details').hidden = false; el('selected-domain').textContent = item.name;
    el('domain-state').textContent = domainStatus(item) + (item.last_received_at ? ' · Last mail: ' + date(item.last_received_at) : '');
    el('domain-label').textContent = item.name + ' · ' + (connection(item.connection_id)?.label || '');
    el('test-domain').disabled = legacy || !item.enabled;
    el('toggle-domain').disabled = legacy;
    el('toggle-domain').textContent = item.enabled ? 'Disable receiving…' : 'Enable receiving';
    el('test-wrap').hidden = !item.test_recipient; el('test-note').hidden = !item.test_recipient;
    el('test-address').value = item.test_recipient || '';
  }
  async function loadDomains() {
    const revision = ++domainRevision;
    const result = checked(await window.api.mailDomains({ connectionId: el('source-filter').value, q: el('domain-search').value, after: domainAfter }));
    if (revision !== domainRevision) return;
    domainCursor = result.nextCursor;
    const fragment = document.createDocumentFragment();
    for (const item of result.domains) {
      const row = node('div'); row.setAttribute('role', 'listitem');
      const button = node('button', undefined, 'mail-domain-button');
      button.type = 'button'; button.dataset.domain = item.name; button.dataset.connectionId = item.connection_id;
      button.classList.toggle('selected', selectedDomain?.name === item.name && selectedDomain?.connection_id === item.connection_id);
      button.append(node('strong', item.name), node('span', domainStatus(item)),
        node('small', connection(item.connection_id)?.label || ''));
      button.addEventListener('click', async () => {
        selectedDomain = item; cursor = null; messages = []; clearReader();
        try { await domainDetails(); await loadDomains(); await loadMessages(); } catch (error) { status(error.message, true); }
      });
      row.append(button); fragment.append(row);
    }
    el('domains').replaceChildren(fragment);
    el('all').classList.toggle('selected', !selectedDomain);
    el('domain-more').hidden = !domainCursor; el('domain-first').hidden = !domainAfter;
    await domainDetails();
  }
  async function refresh(force = false) {
    clearTimeout(timer);
    if (syncing) { schedule(); return; }
    syncing = true; el('refresh').disabled = true; status('Syncing mail connections…');
    try {
      const result = checked(await window.api.mailSync({ force }));
      updateState(result.state);
      await loadDomains(); await loadMessages({ preserve: true });
      const failed = state.connections.filter(item => item.error).length, pending = state.connections.some(item => item.pending && !item.error);
      status(failed ? failed + ' connection(s) unavailable. Showing cached mail and updates from working connections.' :
        pending ? 'Syncing more history… You can read messages already loaded.' : 'Updated ' + new Date().toLocaleTimeString() + ' · Refreshes while this tab is open.', Boolean(failed));
    } catch (error) { status(error.message, true); }
    finally { syncing = false; el('refresh').disabled = !state.connections.some(item => item.hasToken); schedule(); }
  }
  el('form').addEventListener('submit', async event => {
    event.preventDefault(); clearTimeout(timer); el('connect').disabled = true;
    try {
      const saved = checked(await window.api.mailSave({ id: el('connections').value || undefined,
        label: el('name').value, url: el('url').value, token: el('token').value }));
      updateState(saved.state, saved.state.savedId, true);
      const tested = checked(await window.api.mailTest({ connectionId: saved.state.savedId }));
      updateState(tested.state);
      status(tested.version === 1 ? 'Legacy Worker connected. Upgrade it to add more domains.' : 'Connection tested. Add your domains, then test email delivery.');
      await refresh(true);
    } catch (error) { status(error.message, true); }
    finally { el('connect').disabled = false; managementAvailability(); }
  });
  el('add').addEventListener('click', async () => {
    const names = el('add-domains').value.trim(); if (!names) return;
    el('add').disabled = true;
    try {
      const result = checked(await window.api.mailAddDomains({ connectionId: el('connections').value, names }));
      updateState(result.state);
      const counts = {}; for (const item of result.results) counts[item.status] = (counts[item.status] || 0) + 1;
      el('add-results').replaceChildren(node('p', Object.entries(counts).map(([key, value]) => value + ' ' + key).join(' · ')));
      for (const item of result.results.filter(item => ['invalid', 'failed'].includes(item.status)).slice(0, 50)) {
        el('add-results').append(node('p', (item.input || item.name) + ': ' + item.error, 'mail-error'));
      }
      if (!counts.invalid && !counts.failed) el('add-domains').value = '';
      domainAfter = null; await loadDomains(); await loadMessages({ preserve: true });
      status('Domains registered. Configure each catch-all rule in Cloudflare, then use Test delivery.');
    } catch (error) { status(error.message, true); }
    finally { managementAvailability(); schedule(); }
  });
  for (const [id, action] of [['test-domain', 'test'], ['toggle-domain', 'enabled']]) el(id).addEventListener('click', async () => {
    if (!selectedDomain) return;
    const item = selectedDomain;
    if (action === 'enabled' && item.enabled && !window.confirm('Disable receiving for ' + item.name + '? The Worker will reject incoming mail for this domain. Existing messages remain until they expire.')) return;
    el(id).disabled = true;
    try {
      const result = checked(await window.api.mailDomainAction({ connectionId: item.connection_id, domain: item.name, action, enabled: !item.enabled }));
      updateState(result.state); await loadDomains();
      status(action === 'test' ? 'Send a message to the test address shown in the domain sidebar, then refresh to confirm delivery.' : 'Receiving setting updated.');
    } catch (error) { status(error.message, true); await domainDetails(); }
  });
  el('disconnect').addEventListener('click', async () => {
    const item = connection(el('connections').value); if (!item) return;
    if (!window.confirm('Disconnect ' + item.label + ' from M3? Cloudflare will continue receiving mail. Its stored messages will not be deleted.')) return;
    try {
      const result = checked(await window.api.mailDisconnect(item.id));
      selectedDomain = null; cursor = null; messages = []; clearReader();
      updateState(result.state, result.state.connections[0]?.id || '', true);
      await loadDomains(); await loadMessages(); status('Connection removed from M3.');
    } catch (error) { status(error.message, true); }
  });
  el('connections').addEventListener('change', fillConnection);
  el('manage').addEventListener('click', () => { el('connection').open = !el('connection').open; });
  el('refresh').addEventListener('click', () => refresh(true));
  el('more').addEventListener('click', () => loadMessages({ older: true }).catch(error => status(error.message, true)));
  el('test-address').addEventListener('click', event => event.target.select());
  el('domain-more').addEventListener('click', () => { domainAfter = domainCursor; loadDomains().catch(error => status(error.message, true)); });
  el('domain-first').addEventListener('click', () => { domainAfter = null; loadDomains().catch(error => status(error.message, true)); });
  async function allDomains() {
    selectedDomain = null; cursor = null; messages = []; clearReader(); updateState(state);
    await loadDomains(); await loadMessages();
  }
  el('all').addEventListener('click', () => allDomains().catch(error => status(error.message, true)));
  el('source-filter').addEventListener('change', () => { domainAfter = null; allDomains().catch(error => status(error.message, true)); });
  el('domain-search').addEventListener('input', () => {
    ++domainRevision; clearTimeout(domainDebounce); domainAfter = null;
    domainDebounce = setTimeout(() => loadDomains().catch(error => status(error.message, true)), 250);
  });
  for (const id of ['recipient', 'search']) el(id).addEventListener('input', () => {
    ++listRevision; clearTimeout(debounce); cursor = null; messages = []; clearReader();
    debounce = setTimeout(() => loadMessages().catch(error => status(error.message, true)), 250);
  });
  el('export').addEventListener('click', async () => {
    try {
      const result = checked(await window.api.mailExportSetup());
      if (!result.canceled) status('Worker files exported to ' + result.destination + '. Open SETUP.md to continue.');
    } catch (error) { status(error.message, true); }
  });
  function tabChanged() { clearTimeout(timer); if (initialized && active()) refresh(false); }
  document.querySelectorAll('.tab[data-tab]').forEach(tab => tab.addEventListener('click', tabChanged));
  document.addEventListener('visibilitychange', tabChanged);
  window.api.mailState().then(checked).then(async result => {
    updateState(result.state, result.state.connections[0]?.id || '', true); initialized = true;
    el('connection').open = state.connections.length === 0;
    await loadDomains(); await loadMessages();
    if (active() && state.connections.length) refresh(false);
  }).catch(error => status(error.message, true));
})();
