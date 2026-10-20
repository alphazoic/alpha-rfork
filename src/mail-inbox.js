'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { domainToASCII } = require('node:url');
const { createInboxStore } = require('./mail-inbox-store');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function normalizeDomain(input) {
  if (/[\s/@:#?\\\\]/.test(String(input || '').trim())) throw new Error('Enter a domain name without an address or URL.');
  const domain = domainToASCII(String(input || '').trim().toLowerCase().replace(/\.$/, ''));
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Enter a valid domain name, for example example.com.');
  return domain;
}
function normalizeConnection(input) {
  let url;
  try { url = new URL(input?.url); } catch { throw new Error('Enter a valid HTTPS mail Worker URL.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/i.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the mail Worker’s HTTPS workers.dev URL, without a path.');
  }
  return { url: url.origin, ...(input?.domain ? { domain: normalizeDomain(input.domain) } : {}) };
}

function createMailInbox({ directory, safeStorage, network, now = Date.now }) {
  const store = createInboxStore(directory, now), inflight = new Map(), backendClaims = new Map();
  let connections, disposed = false;
  const filename = () => path.join(directory(), 'mail-inbox.json');
  function secure() {
    try { return Boolean(safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'); }
    catch { return false; }
  }
  function writeSettings(saved) {
    fs.mkdirSync(directory(), { recursive: true });
    const target = filename(), temporary = target + '.' + randomUUID() + '.tmp';
    let fd, created = false;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, JSON.stringify(saved));
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) { try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ } }
    }
  }
  function decode(record) {
    let token = '', storage = null;
    if (record.encryptedToken && secure()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(record.encryptedToken, 'base64'));
        if (TOKEN_PATTERN.test(decrypted)) { token = decrypted; storage = 'encrypted'; }
      } catch { /* An available local credential can still be used. */ }
    }
    if (!token && typeof record.token === 'string' && TOKEN_PATTERN.test(record.token)) { token = record.token; storage = 'local'; }
    return { ...record, credential: { ...(record.encryptedToken ? { encryptedToken: record.encryptedToken } : {}),
      ...(record.token ? { token: record.token } : {}) }, token, storage, tokenUnavailable: Boolean(record.encryptedToken && !token) };
  }
  function load() {
    if (connections) return connections;
    let saved, raw;
    try { raw = fs.readFileSync(filename(), 'utf8'); saved = JSON.parse(raw); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Inbox settings could not be read. The existing file was left unchanged.');
      return (connections = []);
    }
    let records;
    if (saved.version === 2 && Array.isArray(saved.connections)) records = saved.connections;
    else if (saved.url) {
      const normalized = normalizeConnection(saved);
      records = [{ id: 'legacy-connection', label: normalized.domain || 'Mail connection', url: normalized.url,
        legacyDomain: normalized.domain, ...(saved.encryptedToken ? { encryptedToken: saved.encryptedToken } : {}),
        ...(saved.token ? { token: saved.token } : {}) }];
      try { fs.writeFileSync(path.join(directory(), 'mail-inbox.v1-backup.json'), raw, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      writeSettings({ version: 2, connections: records });
    } else throw new Error('Inbox settings format is not supported.');
    const seen = new Set();
    connections = records.map(record => {
      const normalized = normalizeConnection(record);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(record.id) || seen.has(record.id)) throw new Error('Invalid mail connection ID.');
      seen.add(record.id);
      return decode({ ...record, url: normalized.url });
    });
    return connections;
  }
  function serialize(items) {
    return { version: 2, connections: items.map(item => ({ id: item.id, label: item.label, url: item.url,
      ...(item.legacyDomain ? { legacyDomain: item.legacyDomain } : {}), ...item.credential })) };
  }
  function current(config) { return !disposed && load().includes(config); }
  function guard(config) { if (!current(config)) throw new Error('Mail connection changed; refresh to continue.'); }
  function configFor(id) {
    const config = id ? load().find(item => item.id === id) : load()[0];
    if (!config) throw new Error('Choose or add a mail connection first.');
    return config;
  }
  function state() {
    const items = load().map(config => {
      const sync = store.sync(config.id);
      return { id: config.id, label: config.label, url: config.url, legacyDomain: config.legacyDomain || '',
        hasToken: Boolean(config.token), persisted: Boolean(config.token), storage: config.storage,
        tokenUnavailable: config.tokenUnavailable, version: sync.version, domainCount: store.domainCount(config.id),
        pending: Boolean(sync.pending), lastSync: sync.last_sync, error: sync.error || '', nextRetry: sync.next_retry };
    });
    return { version: 2, connections: items, secureStorage: secure() };
  }
  function save(input) {
    const normalized = normalizeConnection(input), items = load();
    const previous = input?.id ? configFor(input.id) : items.find(item => item.url === normalized.url);
    if (items.some(item => item !== previous && item.url === normalized.url)) throw new Error('This Worker URL is already connected.');
    const token = String(input?.token || '').trim() || (previous?.url === normalized.url ? previous.token : '');
    if (!TOKEN_PATTERN.test(token)) throw new Error('Enter the Worker access token (32–256 letters, digits, underscores or hyphens).');
    const credential = {};
    if (secure()) {
      try { credential.encryptedToken = safeStorage.encryptString(token).toString('base64'); }
      catch { /* Use persistent local storage if encryption fails. */ }
    }
    if (!credential.encryptedToken) credential.token = token;
    const next = { id: previous?.id || randomUUID(), label: String(input?.label || previous?.label || new URL(normalized.url).hostname).trim().slice(0, 80),
      url: normalized.url, legacyDomain: normalized.domain || previous?.legacyDomain || '', credential, token,
      storage: credential.encryptedToken ? 'encrypted' : 'local', tokenUnavailable: false };
    const updated = previous ? items.map(item => item === previous ? next : item) : [...items, next];
    writeSettings(serialize(updated)); connections = updated;
    if (previous?.url !== next.url) store.remove(next.id);
    else store.patch(next.id, { error: null, next_retry: 0, failures: 0 });
    return { ...state(), savedId: next.id };
  }
  function disconnect(id) {
    const config = configFor(id), updated = load().filter(item => item !== config);
    writeSettings(serialize(updated)); connections = updated; store.remove(id);
    return state();
  }
  async function request(config, route, { params = {}, method = 'GET', body } = {}) {
    if (!config.token) throw new Error('Enter the access token for ' + config.label + '.');
    guard(config);
    return network.run('mail-inbox', async () => {
      const url = new URL(route, config.url);
      for (const [key, value] of Object.entries(params)) if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value));
      let response;
      try {
        response = await network.fetchNetwork(url.href, { method, headers: { Authorization: 'Bearer ' + config.token,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(15000) });
      } catch (error) {
        network.interruption(error);
        throw new Error('Could not reach the mail Worker. Check the connection and try again.');
      }
      guard(config);
      if (!response.ok) {
        const error = new Error(response.status === 401 ? 'Mail Worker rejected the access token.' :
          'Mail Worker request failed (HTTP ' + response.status + '). Check setup, migrations and quota.');
        error.status = response.status; throw error;
      }
      const data = await response.json(); guard(config);
      if (![1, 2].includes(data?.version)) throw new Error('Unsupported mail Worker API version.');
      return data;
    });
  }
  async function health(config) {
    let data;
    try { data = await request(config, '/v2/health'); }
    catch (error) { if (![404, 405].includes(error.status)) throw error; data = await request(config, '/v1/health'); }
    if (data.version === 1) {
      const domain = normalizeDomain(data.domain);
      if (config.legacyDomain && domain !== config.legacyDomain) throw new Error('The legacy Worker does not match its configured domain.');
      return { ...data, domain };
    }
    if (typeof data.backendId !== 'string' || !data.backendId || data.backendId.length > 128 ||
      !['changeHead', 'messageHead', 'changeFloor'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)) throw new Error('Invalid mail Worker sync metadata.');
    const owner = backendClaims.get(data.backendId);
    if ((owner && owner !== config && current(owner)) || load().some(other => other !== config && store.sync(other.id).backend_id === data.backendId)) throw new Error('This mail database is already connected through another Worker.');
    for (const [key, owner] of backendClaims) if (owner === config && key !== data.backendId) backendClaims.delete(key);
    backendClaims.set(data.backendId, config);
    return data;
  }
  async function syncV2(config, info) {
    let sync = store.sync(config.id);
    if (sync.backend_id !== info.backendId || sync.version !== 2 || (!sync.phase && sync.cursor < info.changeFloor)) {
      store.beginSnapshot(config.id, info);
    }
    for (let pages = 0; pages < 8; pages++) {
      guard(config); sync = store.sync(config.id);
      if (sync.phase === 'domains') {
        const data = await request(config, '/v2/domains', { params: { after: sync.domain_after } });
        store.apply(config.id, { domains: data.domains }, { phase: data.nextCursor ? 'domains' : 'messages',
          domain_after: data.nextCursor || '', pending: 1 });
      } else if (sync.phase === 'messages') {
        const data = await request(config, '/v2/snapshot', { params: { after: sync.message_after, through: sync.message_head } });
        store.apply(config.id, { messages: data.messages }, { message_after: Number(data.nextCursor || sync.message_head) });
        if (!data.nextCursor) store.finishSnapshot(config.id);
      } else {
        const data = await request(config, '/v2/changes', { params: { after: sync.cursor, through: info.changeHead } });
        if (data.resetRequired) { store.beginSnapshot(config.id, info); continue; }
        if (!Number.isSafeInteger(data.cursor) || data.cursor < sync.cursor || (data.hasMore && data.cursor === sync.cursor)) throw new Error('Worker returned an invalid sync checkpoint.');
        store.apply(config.id, data, { cursor: data.cursor, pending: data.hasMore ? 1 : 0 });
        if (!data.hasMore) break;
      }
    }
  }
  async function syncV1(config, info) {
    store.apply(config.id, { domains: [{ name: info.domain, enabled: 1 }] }, { version: 1 });
    let queue;
    const saved = store.sync(config.id).legacy_before;
    try { queue = saved ? JSON.parse(saved) : []; } catch { queue = saved ? [saved] : []; }
    if (!Array.isArray(queue)) queue = [String(queue)];
    const newest = await request(config, '/v1/messages');
    const known = newest.messages.some(item => store.knownMessage(config.id, item.id));
    store.apply(config.id, { messages: newest.messages });
    if (!known && newest.nextCursor && !queue.includes(newest.nextCursor)) queue.unshift(newest.nextCursor);
    for (let pages = 0; queue.length && pages < 3; pages++) {
      const before = queue.shift();
      const data = await request(config, '/v1/messages', { params: { before } });
      const seen = data.messages.some(item => store.knownMessage(config.id, item.id));
      store.apply(config.id, { messages: data.messages });
      if (!seen && data.nextCursor && !queue.includes(data.nextCursor)) queue.unshift(data.nextCursor);
    }
    store.patch(config.id, { legacy_before: JSON.stringify(queue), pending: queue.length ? 1 : 0 });
  }

  async function syncOne(config, force) {
    if (inflight.has(config.id)) return inflight.get(config.id);
    const pending = (async () => {
      const prior = store.sync(config.id);
      if (!force && prior.next_retry > now()) return;
      try {
        const info = await health(config);
        if (info.version === 2) await syncV2(config, info); else await syncV1(config, info);
        guard(config); store.patch(config.id, { last_sync: now(), error: null, failures: 0, next_retry: 0 });
      } catch (error) {
        if (current(config)) {
          const failures = store.sync(config.id).failures + 1;
          store.patch(config.id, { error: error.message, failures, next_retry: now() + Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) });
        }
      }
    })().finally(() => inflight.delete(config.id));
    inflight.set(config.id, pending); return pending;
  }
  async function sync(input = {}) {
    const configs = input.connectionId ? [configFor(input.connectionId)] : [...load()];
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, configs.length) }, async () => {
      while (index < configs.length) { const config = configs[index++]; await syncOne(config, Boolean(input.force)); }
    }));
    return { state: state() };
  }
  async function test(input = {}) {
    const config = configFor(typeof input === 'string' ? input : input.connectionId), info = await health(config);
    store.patch(config.id, { version: info.version, error: null, next_retry: 0 });
    return { ...info, state: state() };
  }
  async function syncAfterMutation(config) {
    if (inflight.has(config.id)) await inflight.get(config.id);
    guard(config);
    return syncOne(config, true);
  }
  async function addDomains(input) {
    const config = configFor(input?.connectionId), info = await health(config);
    if (info.version !== 2) throw new Error('Upgrade this single-domain Worker using the exported setup files before adding domains.');
    const names = Array.isArray(input.names) ? input.names : String(input.names || '').split(/[\s,;]+/).filter(Boolean);
    const results = [];
    for (let i = 0; i < names.length; i += 10) {
      try { results.push(...(await request(config, '/v2/domains', { method: 'POST', body: { names: names.slice(i, i + 10) } })).results); }
      catch (error) { results.push(...names.slice(i).map(name => ({ input: String(name), status: 'failed', error: error.message }))); break; }
    }
    await syncAfterMutation(config);
    return { results, state: state() };
  }
  async function domainAction(input) {
    const config = configFor(input?.connectionId), domain = normalizeDomain(input?.domain);
    if (!['test', 'enabled'].includes(input?.action)) throw new Error('Invalid domain action.');
    if ((await health(config)).version !== 2) throw new Error('Upgrade the Worker to manage domains.');
    const result = await request(config, '/v2/domains/' + encodeURIComponent(domain) + '/' + input.action, {
      method: 'POST', body: input.action === 'enabled' ? { enabled: input.enabled } : {},
    });
    await syncAfterMutation(config); return { ...result, state: state() };
  }
  function domains(input = {}) { return store.domainList(input); }
  function list(input = {}) {
    if (input.before && (!Number.isFinite(input.before.receivedAt) || !Number.isSafeInteger(input.before.id) ||
      typeof input.before.connectionId !== 'string')) throw new Error('Invalid inbox page cursor.');
    const data = store.list(input);
    return { ...data, state: state() };
  }
  async function read(input) {
    const config = configFor(input?.connectionId), id = input?.id;
    if (!/^\d{1,16}$/.test(String(id))) throw new Error('Invalid message.');
    let version = store.sync(config.id).version;
    if (!version) version = (await health(config)).version;
    const result = await request(config, '/v' + version + '/messages/' + id);
    return { ...result, message: { ...result.message, connection_id: config.id } };
  }
  // Signup runs inside the account workflow's network lease. Query the Worker
  // directly instead of waiting on a UI sync that may be queued behind it.
  async function signupDomains({ check }) {
    const domains = [], errors = [];
    for (const config of [...load()]) {
      check();
      if (!config.token) { errors.push(config.label + ': access token unavailable'); continue; }
      try {
        const info = await health(config); check();
        store.patch(config.id, { version: info.version });
        if (info.version === 1) {
          throw new Error('Upgrade this legacy mail Worker to use enabled domains for automated signup.');
        }
        let after = '';
        do {
          const data = await request(config, '/v2/domains', { params: { after } }); check();
          if (!Array.isArray(data.domains) || (data.nextCursor && data.nextCursor <= after)) throw new Error('Invalid domain page from mail Worker.');
          for (const item of data.domains) if (item.enabled) domains.push({ connectionId: config.id,
            domain: normalizeDomain(item.name), messageHead: info.messageHead });
          after = data.nextCursor || '';
        } while (after);
      } catch (error) {
        network.interruption(error); check();
        errors.push(config.label + ': ' + error.message);
      }
    }
    if (!domains.length && errors.length) throw new Error('Cloudflare signup mail is unavailable. ' + errors.join('; '));
    return domains;
  }
  async function signupMessages({ connectionId, recipient, afterId, check }) {
    const config = configFor(connectionId);
    const version = store.sync(config.id).version || (await health(config)).version;
    const messages = []; let before = '';
    do {
      check();
      const data = await request(config, '/v' + version + '/messages', { params: { recipient, before } }); check();
      if (!Array.isArray(data.messages) || (data.nextCursor && before && Number(data.nextCursor) >= Number(before))) throw new Error('Invalid message page from mail Worker.');
      const matching = data.messages.filter(item => item.recipient.toLowerCase() === recipient.toLowerCase() && item.id > afterId);
      store.apply(config.id, { messages: matching });
      for (const item of matching) {
        const result = await request(config, '/v' + version + '/messages/' + item.id); check();
        // Recheck the recipient on the full message, not just the list entry.
        if (result.message?.recipient?.toLowerCase() === recipient.toLowerCase() && result.message.id > afterId) messages.push(result.message);
      }
      before = data.nextCursor || '';
    } while (before);
    return messages;
  }
  return { state, save, disconnect, test, sync, addDomains, domainAction, domains, list, read, signupDomains, signupMessages,
    async dispose() { disposed = true; await Promise.allSettled(inflight.values()); store.dispose(); } };
}
module.exports = { createMailInbox, normalizeConnection, normalizeDomain };
