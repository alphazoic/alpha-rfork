'use strict';

(function () {
  const $ = id => document.getElementById(id);
  let state = null, draft = null, dirty = false, busy = false, localError = null, latestRevision = -1;
  let catalog = null, editingPool = false, previewTimer, searchTimer, recoveryTimer, previewSequence = 0, searchSequence = 0;
  function list(id) {
    const result = [], input = $(id).value + '\n'; let value = '', quoted = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (char === '"' && quoted && input[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (!quoted && (char === ',' || char === '\n')) { if (value.trim()) result.push(value.trim()); value = ''; }
      else value += char;
    }
    if (quoted) throw new Error('Close the quoted country or server entry.');
    return result;
  }
  const formatList = values => values.map(value => value.includes(',') || value.includes('"') ? '"' + value.replaceAll('"', '""') + '"' : value).join(', ');
  const retryFields = { attemptsPerServer: ['vpn-retry-attempts', 1], maxCandidates: ['vpn-retry-candidates', 1],
    attemptTimeoutMs: ['vpn-retry-process', 1000], roundTimeoutMs: ['vpn-retry-round', 1000],
    initialDelayMs: ['vpn-retry-initial', 1000], maxDelayMs: ['vpn-retry-max', 1000],
    failedServerCooldownMs: ['vpn-retry-cooldown', 60000], roundRetryDelayMs: ['vpn-retry-restart', 1000] };
  const poolInputs = ['vpn-pool-mode', 'vpn-servers', 'vpn-countries', 'vpn-cities', 'vpn-exclude-servers',
    'vpn-exclude-countries', 'vpn-exclude-cities', 'vpn-order', 'vpn-recent', 'vpn-fallback'];
  function poolDraft() {
    const recentLimit = Number($('vpn-recent').value);
    if (!$('vpn-recent').value.trim() || !$('vpn-recent').checkValidity() || !Number.isSafeInteger(recentLimit)) throw new Error('Choose a valid number of recent servers to avoid.');
    const cities = id => [...$(id).selectedOptions].map(option => JSON.parse(option.value));
    return { mode: $('vpn-pool-mode').value, servers: list('vpn-servers'), countries: list('vpn-countries'), cities: cities('vpn-cities'),
      excludeServers: list('vpn-exclude-servers'), excludeCountries: list('vpn-exclude-countries'), excludeCities: cities('vpn-exclude-cities'),
      order: $('vpn-order').value, recentLimit, fallbackToAll: $('vpn-fallback').checked };
  }
  function poolRows() {
    const mode = $('vpn-pool-mode').value;
    $('vpn-country-row').hidden = !['countries', 'mixed'].includes(mode);
    $('vpn-server-row').hidden = !['servers', 'mixed'].includes(mode);
    $('vpn-city-row').hidden = mode !== 'cities';
  }
  async function preview() {
    const sequence = ++previewSequence;
    try {
      const result = await window.api.vpnPoolPreview(poolDraft());
      if (sequence !== previewSequence) return;
      text('vpn-pool-summary', result.ok ? result.pool.servers.toLocaleString() + ' eligible local server records in ' + result.pool.countries.length + ' countries.' +
        (result.pool.missingServers.length ? '\nIDs absent from this catalog: ' + result.pool.missingServers.join(', ') : '') +
        (result.pool.fallbackServers ? '\n' + result.pool.fallbackServers.toLocaleString() + ' other records may be used because fallback is enabled.' : '') +
        (!result.pool.servers && !result.pool.fallbackServers ? '\nThis selection is empty. Choose another pool or import a list.' : '') +
        '\nCurrent/recent-server avoidance and cooldowns apply when connecting.' : result.error.message);
    } catch (error) { if (sequence === previewSequence) text('vpn-pool-summary', error.message); }
  }
  function citiesOptions(id, selected) {
    const chosen = new Set(selected.map(value => JSON.stringify(value)));
    const values = new Map();
    for (const country of catalog?.locations || []) for (const city of country.cities) {
      const value = { country: country.country, city: city.city }; values.set(JSON.stringify(value), country.country + ' · ' + city.city);
    }
    for (const value of selected) if (!values.has(JSON.stringify(value))) values.set(JSON.stringify(value), value.country + ' · ' + value.city + ' (saved filter)');
    $(id).replaceChildren(...[...values].map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = chosen.has(value); return option; }));
  }
  function fillPool(policy) {
    $('vpn-pool-mode').value = policy.mode;
    for (const [id, key] of [['vpn-servers', 'servers'], ['vpn-countries', 'countries'], ['vpn-exclude-servers', 'excludeServers'], ['vpn-exclude-countries', 'excludeCountries']]) $(id).value = formatList(policy[key]);
    citiesOptions('vpn-cities', policy.cities); citiesOptions('vpn-exclude-cities', policy.excludeCities);
    $('vpn-order').value = policy.order; $('vpn-recent').value = policy.recentLimit; $('vpn-fallback').checked = policy.fallbackToAll;
    poolRows(); clearTimeout(previewTimer); previewTimer = setTimeout(preview, 0);
  }
  async function loadCatalog(result) {
    result ||= await window.api.vpnCatalog();
    if (!result.ok) { text('vpn-catalog-summary', result.error.message); return result; }
    if (result.canceled) return result;
    catalog = result.catalog;
    text('vpn-catalog-summary', (catalog.source === 'imported' ? 'Imported list' : 'Bundled list') + ': ' + catalog.servers.toLocaleString() + ' regular servers, ' + catalog.countries + ' countries, ' + catalog.cities + ' cities.' +
      (catalog.excludedTor ? '\nExcluded ' + catalog.excludedTor + ' Tor entries.' : '') + (catalog.duplicateRows ? '\nSkipped ' + catalog.duplicateRows + ' duplicate rows.' : ''));
    $('vpn-country-picker').replaceChildren(...catalog.locations.map(location => { const option = document.createElement('option'); option.value = location.country; option.textContent = location.country; return option; }));
    const policy = poolDraft(); citiesOptions('vpn-cities', policy.cities); citiesOptions('vpn-exclude-cities', policy.excludeCities);
    await preview(); await search(); return result;
  }
  async function search() {
    const sequence = ++searchSequence;
    const result = await window.api.vpnCatalogSearch({ query: $('vpn-search').value });
    if (sequence !== searchSequence) return;
    if (!result.ok) { text('vpn-search-summary', result.error.message); $('vpn-server-results').replaceChildren(); return; }
    $('vpn-server-results').replaceChildren(...result.results.map(server => { const option = document.createElement('option'); option.value = server.id; option.textContent = server.id + ' · ' + server.country + ' · ' + server.city; return option; }));
    if (result.results.length) $('vpn-server-results').selectedIndex = 0;
    text('vpn-search-summary', 'Showing ' + result.results.length + ' of ' + result.total.toLocaleString() + ' local matches.');
  }
  const stateNames = { disabled: 'Control off', disconnected: 'Disconnected', connecting: 'Connecting',
    connected: 'Connected', checking: 'Checking status', switching: 'Switching', recovering: 'Recovering', waiting: 'Waiting to retry', attention: 'Needs attention' };
  const kindNames = { upload: 'upload', download: 'download', browser: 'MEGA browser', 'account-refresh': 'account refresh',
    'bulk-import': 'bulk import', 'single-account': 'account check', 'security-upgrade': 'account upgrade',
    'folder-link': 'folder link', metadata: 'metadata read', mediainfo: 'MediaInfo read', import: 'import' };
  const historyNames = { connect: 'Connected', disconnect: 'Disconnected', recovered: 'Recovered connection',
    'catalog-import': 'Imported local server list', 'catalog-reload': 'Reloaded saved server list', 'catalog-reset': 'Restored bundled server list',
    'waiting-pool-changed': 'Saved pool and resumed waiting work',
    'connection-retrying': 'Retrying connection',
    'connection-attempt-failed': 'Server attempt failed', 'connection-waiting': 'Waiting for another retry round',
    'connection-attention': 'Connection recovery needs attention',
    'connection-diagnostic': 'Proton CLI diagnostic',
    'status-unavailable': 'Proton status temporarily unavailable',
    'status-unavailable-paused': 'Work paused while Proton status recovers',
    'proton-disconnected': 'Proton reports disconnected', 'work-interrupted': 'Work paused for recovery',
    'connection-failed': 'Connection failed', 'tunnel-lost': 'Connection lost', 'preferences-saved': 'Settings saved',
    'setup-checked': 'Setup checked', 'command-queued': 'Connection request queued', 'command-complete': 'Connection request completed',
    'command-canceled': 'Connection request canceled', 'command-failed': 'Connection request failed',
    'settings-failed': 'Settings were not saved',
    'refresh-rotation-queued': 'Account refresh rotation queued', 'refresh-rotation-complete': 'Account refresh connection changed',
    'refresh-rotation-failed': 'Account refresh rotation stopped',
    'download-speed-recovery': 'Download speed recovery queued', 'download-loss-recovery': 'Download connection recovery queued',
    'download-recovery-complete': 'Download recovery connection verified', 'download-recovery-failed': 'Download recovery needs attention',
    'upload-speed-recovery': 'Upload speed recovery queued', 'upload-loss-recovery': 'Upload connection recovery queued',
    'upload-recovery-complete': 'Upload recovery connection verified', 'upload-recovery-failed': 'Upload recovery needs attention',
    'recovery-held': 'Recovery limit reached; work held' };
  function text(id, value) { $(id).textContent = value; }
  const statusText = value => value?.state === 'connected' ? 'Connected to ' + (value.server?.id || 'an unspecified server') :
    value?.state === 'disconnected' ? 'Disconnected' : 'Temporarily unavailable';
  const commandNames = { inspect: 'Proton CLI discovery', info: 'protonvpn info', status: 'protonvpn status',
    connect: 'protonvpn connect', disconnect: 'protonvpn disconnect' };
  const reasonNames = { 'status-unavailable': 'Proton status is temporarily unavailable',
    'candidate-limit': 'This round’s candidate limit was reached', 'pool-exhausted': 'Waiting for an eligible server',
    'round-timeout': 'This round’s time budget was reached', 'server-mismatch': 'Proton reported a different server',
    'speed-switch-limit': 'Waiting for the speed-switch cooldown or rolling limit',
    'process-unconfirmed': 'Waiting for the previous CLI process to close',
    'background-agent-error': 'Proton reported a background agent error',
    'cli-error-output': 'The CLI reported an error in its output', 'process-exit': 'The CLI exited unsuccessfully' };
  function recoveryClock() {
    if (!state?.supported) return;
    const ctl = state.controller, progress = ctl.connectionProgress;
    const due = progress?.nextRetryAt ?? ctl.statusUncertainty?.nextRetryAt;
    text('vpn-recovery-next', ctl.poolEditing ? 'Paused while editing the pool' : Number.isFinite(due) ?
      (due > Date.now() ? 'In ' + Math.ceil((due - Date.now()) / 1000) + ' seconds' : 'Due now; waiting for the CLI') :
      ctl.connectionCommandActive ? 'After the current command finishes' : ctl.state === 'checking' ? 'Checking again automatically' : 'After active work finishes');
    const uncertain = ctl.statusUncertainty;
    $('vpn-recovery-grace').hidden = !uncertain;
    if (uncertain) text('vpn-recovery-grace', uncertain.interrupted ?
      'VPN work is paused. The job is retained while Proton status recovers.' :
      'Existing work continues during the status grace period (' + Math.max(0, Math.ceil((uncertain.graceUntil - Date.now()) / 1000)) +
      ' seconds remaining). New work waits.');
  }
  function recoveryDetails(ctl, pending, active) {
    const progress = ctl.connectionProgress, request = ctl.connectionRequest;
    const visible = Boolean(pending || ctl.connectionCommandActive || ctl.pendingSwitches || ctl.waitingOperations.length || ctl.state === 'checking');
    $('vpn-waiting').hidden = !visible;
    $('vpn-recovery-facts').hidden = !visible;
    text('vpn-waiting-message', ctl.poolEditing ? 'Automatic retries are paused while you edit the waiting pool. Apply the pool or discard edits to continue.' :
      ctl.state === 'checking' ? 'Proton status is temporarily unavailable. M3 is checking again automatically.' :
      pending || ctl.connectionCommandActive || ctl.pendingSwitches ? pending?.preparing ? 'Preparing the connection request…' :
      progress?.message?.replace(/(?:automatically (?:retrying|checking for CLI process closure)|retrying) in \d+ seconds\.?/gi, 'retrying automatically.') || (active.length ? 'Connection request waiting for: ' + [...new Set(active)].join(', ') + '. Finish or stop the work; close the MEGA browser if it is open.' :
        'Connection request in progress. Canceling does not undo a connection change already applied.') :
      ctl.waitingOperations.length + ' network operation(s) waiting for the connection or shared account session.');
    const error = progress?.error || ctl.lastError;
    const diagnostic = error?.diagnostic || error;
    const command = diagnostic?.operation || (ctl.state === 'checking' ? 'status' : request?.action);
    const target = progress?.server || request?.target?.server || request?.target?.city || request?.target?.country ||
      (request?.fastest ? 'Fastest available (Proton chooses)' : request?.action === 'connect' ? 'Saved server pool' : '');
    text('vpn-recovery-command', (commandNames[command] || 'Waiting for a connection or account session') + (target ? ' · ' + target : ''));
    const attempt = [progress?.candidateNumber ? 'Candidate ' + progress.candidateNumber + ' of up to ' + progress.maxCandidates : '',
      progress?.attempt ? 'attempt ' + progress.attempt + ' of ' + progress.maxAttempts : '', progress?.round ? 'round ' + progress.round : ''].filter(Boolean);
    text('vpn-recovery-candidate', attempt.join(' · ') || 'No server attempt in progress');
    text('vpn-recovery-reason', reasonNames[progress?.reason] || reasonNames[diagnostic?.reason] || error?.message ||
      (active.length ? 'Waiting for active work to finish' : progress?.message || 'Waiting for the connection or shared account session'));
    text('vpn-recovery-status', statusText(ctl.status));
    const last = ctl.lastConfirmed || progress?.lastConfirmed;
    text('vpn-recovery-last', last ? statusText(last.status) + ' · ' + new Date(last.time).toLocaleString() : 'No confirmed status yet');
    recoveryClock();
    clearInterval(recoveryTimer); recoveryTimer = visible ? setInterval(recoveryClock, 1000) : null;
  }
  function readDraft() {
    if (!draft) return null;
    if (!dirty) return state.controller.connectionCommandActive || state.refreshing || state.transferring ? null : structuredClone(state.preferences);
    const number = (id, multiplier = 1) => {
      const value = Number($(id).value);
      const scaled = value * multiplier, rounded = Math.round(scaled);
      if (!$(id).value.trim() || !Number.isFinite(value) || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .001 || !$(id).checkValidity()) {
        throw new Error('Enter valid VPN thresholds and durations.');
      }
      return rounded;
    };
    if ($('vpn-enabled').checked && $('vpn-mode').value === 'required' && !state.controller.protectionVerified) {
      throw new Error('Select Manual control to enable app controls. VPN-required protection has not been verified.');
    }
    return { ...draft, enabled: $('vpn-enabled').checked, required: $('vpn-mode').value === 'required',
      preferredServers: [], preferredCountries: [], serverSelection: poolDraft(),
      connectionRetry: Object.fromEntries(Object.entries(retryFields).map(([key, [id, multiplier]]) => [key, number(id, multiplier)])),
      autoRecover: $('vpn-auto-recover').checked,
      recoveryCooldownMs: number('vpn-cooldown', 60000), maxRecoverySwitches: number('vpn-attempts'), recoveryWindowMs: number('vpn-window', 60000),
      refreshMode: $('vpn-refresh-mode').value, refreshBatchSize: number('vpn-refresh-batch'),
      downloadRecoveryEnabled: $('vpn-download-enabled').checked, downloadThresholdBps: number('vpn-download-speed', 1000000),
      downloadDurationMs: number('vpn-download-duration', 1000),
      uploadRecoveryEnabled: $('vpn-upload-enabled').checked, uploadThresholdBps: number('vpn-upload-speed', 1000000),
      uploadDurationMs: number('vpn-upload-duration', 1000), warmupMs: number('vpn-warmup', 1000), averagingMs: number('vpn-averaging', 1000) };
  }
  function fill(preferences) {
    draft = { ...preferences }; dirty = false;
    $('vpn-enabled').checked = preferences.enabled;
    $('vpn-mode').value = preferences.required ? 'required' : 'manual';
    fillPool(preferences.serverSelection);
    for (const [key, [id, multiplier]] of Object.entries(retryFields)) $(id).value = preferences.connectionRetry[key] / multiplier;
    $('vpn-auto-recover').checked = preferences.autoRecover;
    $('vpn-cooldown').value = preferences.recoveryCooldownMs / 60000;
    $('vpn-attempts').value = preferences.maxRecoverySwitches;
    $('vpn-window').value = preferences.recoveryWindowMs / 60000;
    $('vpn-refresh-mode').value = preferences.refreshMode;
    $('vpn-refresh-batch').value = preferences.refreshBatchSize;
    $('vpn-download-enabled').checked = preferences.downloadRecoveryEnabled;
    $('vpn-upload-enabled').checked = preferences.uploadRecoveryEnabled;
    $('vpn-download-speed').value = preferences.downloadThresholdBps / 1000000;
    $('vpn-upload-speed').value = preferences.uploadThresholdBps / 1000000;
    $('vpn-download-duration').value = preferences.downloadDurationMs / 1000;
    $('vpn-warmup').value = preferences.warmupMs / 1000;
    $('vpn-averaging').value = preferences.averagingMs / 1000;
    $('vpn-upload-duration').value = preferences.uploadDurationMs / 1000;
    targets(preferences);
  }
  function targets(preferences) {
    const select = $('vpn-target'), selected = select.value;
    const options = [{ value: 'fastest', label: 'Fastest available (Proton chooses)' }, { value: 'pool', label: 'Use saved catalog pool' }];
    for (const server of preferences.serverSelection.servers.slice(0, 100)) options.push({ value: 'server:' + server, label: server });
    for (const country of preferences.serverSelection.countries.slice(0, 100)) options.push({ value: 'country:' + country, label: country });
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
    select.value = options.some(option => option.value === selected) ? selected : 'fastest';
  }
  function render(next) {
    if (next.revision < latestRevision) return;
    latestRevision = next.revision; state = next;
    $('vpn-settings-card').hidden = !next.supported; $('vpn-status-pill').hidden = !next.supported;
    if (!next.supported) { clearInterval(recoveryTimer); return; }
    if (!draft) fill(next.preferences);
    const ctl = next.controller, pending = next.commands[0];
    const observed = ctl.settings.enabled ? ctl.status : next.diagnostics?.status;
    const server = observed?.state === 'connected' ? observed.server : null;
    const stateName = ctl.state === 'attention' && ctl.retryWaiting ? 'Waiting for Proton' : stateNames[ctl.state] || 'Unknown';
    text('vpn-state', stateName);
    text('vpn-status-label', ctl.state === 'disabled' ? 'VPN off' : 'VPN ' + stateName.toLowerCase());
    $('vpn-status-pill').dataset.state = ctl.state;
    $('vpn-status-pill').title = stateName + ' — open VPN terminal';
    text('vpn-server', server?.id || '—'); text('vpn-location', server?.location || '—');
    text('vpn-cli', next.diagnostics ? (next.diagnostics.version || 'Not detected') + ' / ' +
      ({ 'signed-in': 'signed in', 'signed-out': 'sign-in needed', unknown: 'account unknown' }[next.diagnostics.authentication] || 'account unknown') : 'Not checked');
    text('vpn-mode-summary', !ctl.settings.enabled ? 'M3 is not controlling your VPN.' : ctl.settings.required ? 'VPN is required for MEGA work.' : 'Manual control. Your normal connection is allowed when disconnected.');
    const issue = next.diagnostics?.diagnostics?.[0];
    text('vpn-setup-message', issue ? issue.message + '\n' + issue.action : next.diagnostics?.ready ?
      'Proton CLI is ready. Connection and server selection depend on your Proton plan.' :
      'Use Check setup to detect the CLI and existing Proton sign-in. M3 does not store your Proton password.');
    const error = localError || ctl.lastError || next.serviceError;
    $('vpn-error').hidden = !error;
    $('vpn-error').dataset.recovering = Boolean(!localError && (ctl.retryWaiting || ctl.state === 'checking'));
    if (error) text('vpn-error', (error.server ? error.server + ': ' : '') + error.message +
      (error.protonSelectedServer ? '\nCLI-selected server: ' + error.protonSelectedServer + '.' : '') +
      (error.exitCode !== undefined && error.exitCode !== null ? '\nCLI exit code: ' + error.exitCode + '.' : '') +
      (error.operation ? '\nCommand: ' + (commandNames[error.operation] || error.operation) + '.' : '') +
      (error.diagnostic ? '\n' + error.diagnostic.message : '') +
      (error.action ? '\n' + error.action : ''));
    $('vpn-mode').querySelector('option[value="required"]').disabled = !ctl.protectionVerified;
    const active = ctl.activeOperations.map(operation => kindNames[operation.kind] || operation.kind);
    recoveryDetails(ctl, pending, active);
    const locked = busy || next.saving || next.checking;
    $('vpn-refresh-fields').disabled = locked || Boolean(pending) || Boolean(next.refreshing) || Boolean(next.transferring) || !next.availability.refreshRotation;
    $('vpn-download-fields').disabled = locked || Boolean(pending) || Boolean(next.transferring) || Boolean(next.refreshing) || !next.availability.downloadRecovery;
    $('vpn-upload-fields').disabled = locked || Boolean(pending) || Boolean(next.transferring) || Boolean(next.refreshing) || !next.availability.uploadRecovery;
    const commandBusy = locked || Boolean(pending) || ctl.connectionCommandActive;
    const held = Boolean(ctl.retryWaiting), blocked = Boolean(ctl.retryBlocked);
    editingPool = held && Boolean(ctl.poolEditing);
    $('vpn-held-actions').hidden = !held && !pending && !ctl.connectionCommandActive && !ctl.pendingSwitches;
    $('vpn-retry').hidden = !held; $('vpn-change-pool').hidden = !held;
    const speedLimited = ctl.connectionProgress?.reason === 'speed-switch-limit';
    $('vpn-retry').disabled = locked || blocked || editingPool || speedLimited;
    $('vpn-retry').title = blocked ? 'M3 automatically checks for the previous CLI process to close.' : speedLimited ?
      'The job resumes automatically when the configured speed-switch limit permits.' : 'Retry early; automatic retries continue without this button.';
    $('vpn-change-pool').disabled = locked || blocked || editingPool;
    $('vpn-pool-fields').disabled = locked || (commandBusy || next.refreshing || next.transferring) && !(held && editingPool && !blocked);
    $('vpn-retry-fields').disabled = locked || commandBusy || next.refreshing || next.transferring;
    $('vpn-apply-pool-row').hidden = !editingPool;
    $('vpn-apply-pool').disabled = locked || !held || blocked;
    for (const action of ['import', 'reload', 'reset']) $('vpn-catalog-' + action).disabled = locked || (commandBusy || next.refreshing || next.transferring) && !held;
    $('vpn-diagnose').disabled = commandBusy;
    for (const id of ['vpn-connect', 'vpn-switch', 'vpn-disconnect']) $(id).disabled = commandBusy || dirty || !ctl.settings.enabled;
    $('vpn-switch').disabled ||= ctl.state !== 'connected';
    const activeJob = Boolean(next.refreshing || next.transferring);
    $('vpn-disconnect').disabled ||= ctl.state === 'disconnected' || activeJob;
    $('vpn-disconnect').title = activeJob ? 'Stop the active account refresh or transfer before disconnecting.' : 'Disconnect Proton VPN.';
    $('vpn-cancel').hidden = !pending && !ctl.connectionCommandActive && !ctl.pendingSwitches; $('vpn-cancel').disabled = locked;
    $('vpn-save').disabled = commandBusy || Boolean(next.refreshing) || Boolean(next.transferring);
    for (const id of ['vpn-enabled', 'vpn-mode', 'vpn-auto-recover', 'vpn-cooldown', 'vpn-attempts', 'vpn-window']) $(id).disabled = commandBusy || Boolean(next.refreshing) || Boolean(next.transferring);
    $('vpn-target').disabled = commandBusy;
    text('vpn-save-status', editingPool ? 'Editing the waiting pool. Use Apply pool and retry.' : dirty ? 'Unsaved VPN changes. Apply settings before connecting to this pool.' : 'No unsaved VPN changes.');
    const entries = next.history.slice(-30).reverse();
    $('vpn-history-list').replaceChildren(...(entries.length ? entries : [{ action: 'empty' }]).map(entry => {
      const li = document.createElement('li');
      li.textContent = entry.action === 'empty' ? 'No VPN activity yet.' : new Date(entry.time).toLocaleTimeString() + ' · ' +
        (historyNames[entry.action] || entry.action) + (entry.message ? ' — ' + entry.message : '') +
        (entry.operation ? '\nCommand: ' + (commandNames[entry.operation] || entry.operation) : '') +
        (entry.exitCode !== undefined && entry.exitCode !== null ? ' · exit code ' + entry.exitCode : '') +
        (entry.server ? ' · ' + entry.server : '') + (entry.help ? '\n' + entry.help : '');
      return li;
    }));
  }
  async function invoke(fn) {
    busy = true; localError = null; if (state) render(state);
    try {
      const result = await fn(); if (result.state) render(result.state);
      if (!result.ok) { localError = result.error || { message: 'VPN action failed.' }; return null; }
      return result;
    } catch (error) { localError = { message: error.message || 'VPN action failed.' }; return null; }
    finally { busy = false; if (state) render(state); }
  }
  function chosenTarget() {
    const value = $('vpn-target').value;
    if (value.startsWith('server:')) return { server: value.slice(7) };
    if (value.startsWith('country:')) return { country: value.slice(8) };
    return {};
  }
  for (const id of [...poolInputs, ...Object.values(retryFields).map(([id]) => id), 'vpn-enabled', 'vpn-mode', 'vpn-auto-recover', 'vpn-cooldown', 'vpn-attempts', 'vpn-window', 'vpn-refresh-mode', 'vpn-refresh-batch', 'vpn-download-enabled', 'vpn-download-speed', 'vpn-download-duration', 'vpn-upload-enabled', 'vpn-upload-speed', 'vpn-upload-duration', 'vpn-warmup', 'vpn-averaging']) {
    $(id).addEventListener('input', () => { dirty = true; localError = null; if (state) render(state); });
  }
  for (const id of poolInputs) $(id).addEventListener('input', () => { poolRows(); clearTimeout(previewTimer); previewTimer = setTimeout(preview, 200); });
  $('vpn-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search().catch(() => text('vpn-search-summary', 'Local search could not be loaded.')), 200); });
  function addValue(id, value) {
    try { const values = new Set(list(id)); if (value) values.add(value); $(id).value = formatList([...values]); $(id).dispatchEvent(new Event('input', { bubbles: true })); }
    catch (error) { localError = { message: error.message }; if (state) render(state); }
  }
  $('vpn-country-add').addEventListener('click', () => addValue('vpn-countries', $('vpn-country-picker').value));
  $('vpn-server-add').addEventListener('click', () => { if (!['servers', 'mixed'].includes($('vpn-pool-mode').value)) $('vpn-pool-mode').value = 'servers'; addValue('vpn-servers', $('vpn-server-results').value); poolRows(); });
  $('vpn-server-exclude').addEventListener('click', () => addValue('vpn-exclude-servers', $('vpn-server-results').value));
  for (const action of ['import', 'reload', 'reset']) $('vpn-catalog-' + action).addEventListener('click', () => invoke(async () => {
    const pause = state.controller.retryWaiting && !state.controller.poolEditing && !state.controller.retryBlocked;
    if (pause) { const result = await window.api.vpnEditPool('begin'); if (!result.ok) return result; }
    try {
      const result = await window.api.vpnCatalogAction(action);
      if (result.ok && !result.canceled) await loadCatalog(result);
      else if (!result.ok && action === 'reload') { catalog = null; text('vpn-catalog-summary', result.error.message); $('vpn-server-results').replaceChildren(); }
      return result;
    }
    finally { if (pause) { const result = await window.api.vpnEditPool('discard'); if (result.state) render(result.state); } }
  }));
  $('vpn-retry').addEventListener('click', () => invoke(() => window.api.vpnRetry()));
  $('vpn-change-pool').addEventListener('click', () => invoke(async () => { const result = await window.api.vpnEditPool('begin'); if (result.ok) { fillPool(state.preferences.serverSelection); $('vpn-pool-fields').scrollIntoView({ block: 'start', behavior: 'smooth' }); } return result; }));
  $('vpn-abandon-pool').addEventListener('click', () => invoke(async () => { const result = await window.api.vpnEditPool('discard'); if (result.ok) fill(result.state.preferences); return result; }));
  $('vpn-apply-pool').addEventListener('click', () => invoke(async () => {
    const result = await window.api.vpnChangePool(poolDraft()); if (result.ok) { editingPool = false; fill(result.state.preferences); } return result;
  }));
  $('vpn-save').addEventListener('click', () => invoke(async () => {
    const result = await window.api.vpnSaveSettings(readDraft());
    if (result.ok) { fill(result.state.preferences); render(result.state); }
    return result;
  }));
  $('vpn-diagnose').addEventListener('click', () => invoke(() => window.api.vpnDiagnose()));
  for (const action of ['connect', 'switch', 'disconnect']) $('vpn-' + action).addEventListener('click', () =>
    invoke(() => window.api.vpnCommand({ action, target: action === 'disconnect' ? {} : chosenTarget(), usePool: $('vpn-target').value === 'pool' })));
  $('vpn-cancel').addEventListener('click', () => invoke(() => window.api.vpnCancelCommand(state.commands[0]?.id)));
  $('vpn-status-pill').addEventListener('click', () => {
    window.vpnTerminal.open();
  });
  $('vpn-open-terminal').addEventListener('click', () => window.vpnTerminal.open());
  window.vpnSettings = { readDraft: () => state?.supported ? readDraft() : null,
    saved: async () => { const next = await window.api.vpnGetState(); localError = null; fill(next.preferences); render(next); } };
  window.api.on('vpn:state', render);
  window.api.vpnGetState().then(next => { render(next); if (next.supported) loadCatalog().catch(() => text('vpn-catalog-summary', 'The local catalog could not be loaded. Reload or import a local list.')); }).catch(() => {
    $('vpn-settings-card').hidden = false; $('vpn-error').hidden = false; text('vpn-error', 'VPN status could not be loaded.');
  });
})();
