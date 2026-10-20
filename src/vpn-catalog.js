'use strict';

const { createHash } = require('node:crypto');

// Local catalog data and pure selection only. No CLI, HTTP, DNS or latency checks.
const SERVER_ID = /^[A-Z]{2}(?:-[A-Z0-9]+)?#\d+$/;
const TOR_ID = /^[A-Z]{2}(?:-[A-Z0-9]+)?#\d+-TOR$/;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SERVERS = 100000;
const DEFAULT_SELECTION_POLICY = {
  mode: 'all', countries: [], cities: [], servers: [],
  excludeCountries: [], excludeCities: [], excludeServers: [],
  order: 'country-balanced', recentLimit: 5, fallbackToAll: false,
};

class VpnCatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'VpnCatalogError'; this.code = code; }
}
function invalid(message) { throw new VpnCatalogError('INVALID_CATALOG', message); }
function serverId(value) {
  if (typeof value !== 'string' || !SERVER_ID.test(value.trim().toUpperCase())) invalid('Use a regular Proton server ID.');
  return value.trim().toUpperCase();
}
function label(value) {
  if (typeof value !== 'string') invalid('Catalog locations must be text.');
  const result = value.trim().normalize('NFC');
  // These are display/filter labels, never CLI arguments. Real catalog names
  // include &, parentheses and curly apostrophes.
  if (!result || result.length > 100 || /[\p{C}\p{Zl}\p{Zp}]/u.test(result)) invalid('Use a valid country or city label.');
  return result;
}
function key(value) { return value.normalize('NFC').toLowerCase(); }
function cityKey(value) { return JSON.stringify([key(value.country), key(value.city)]); }

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => {
    endField();
    if (row.some(value => value.trim())) rows.push({ values: row, line: start });
    row = []; start = line + 1;
    if (rows.length > MAX_SERVERS + 1000) invalid('The server catalog has too many rows.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else { field += c; if (c === '\n') line++; }
    } else if (c === ',' ) endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow(); line++;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') invalid(`Invalid CSV quoting at row ${start}.`);
    else field += c;
    if (field.length > 1024 || row.length > 10) invalid(`Invalid catalog row ${start}.`);
  }
  if (quoted) invalid(`Unclosed CSV quote at row ${start}.`);
  if (field || row.length || closed) endRow();
  return rows;
}

function parseCatalog(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) invalid('The server catalog must be text no larger than 16 MiB.');
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const records = [], byId = new Map(), excludedTor = [], duplicateRows = [];
  let header = false;
  if (rows[0]?.values.length === 3 && rows[0].values.map(value => value.trim().toLowerCase()).join(',') === 'country,city,server') {
    rows.shift(); header = true;
  }
  for (const { values, line } of rows) {
    const id = (values[2] || '').trim().toUpperCase();
    // The supplied list has seven Tor rows with an extra annotation column.
    if (TOR_ID.test(id) && (values.length === 3 || values.length === 4)) {
      label(values[0]); label(values[1]); excludedTor.push({ line, id }); continue;
    }
    if (values.length !== 3) invalid(`Expected country, city and server ID at row ${line}.`);
    let record;
    try { record = { country: label(values[0]), city: label(values[1]), id: serverId(id) }; }
    catch { invalid(`Invalid country, city or regular server ID at row ${line}.`); }
    const previous = byId.get(record.id);
    if (previous) {
      if (key(previous.country) !== key(record.country) || key(previous.city) !== key(record.city)) {
        invalid(`Conflicting locations for one server ID at row ${line}.`);
      }
      duplicateRows.push({ line, id: record.id }); continue;
    }
    if (records.length >= MAX_SERVERS) invalid('The catalog may contain at most 100,000 regular servers.');
    byId.set(record.id, record); records.push(Object.freeze(record));
  }
  if (!records.length) invalid('The catalog contains no regular Proton servers.');
  return Object.freeze({ records: Object.freeze(records), report: Object.freeze({
    rows: rows.length, servers: records.length,
    countries: new Set(records.map(record => key(record.country))).size,
    cities: new Set(records.map(cityKey)).size,
    header, excludedTor: Object.freeze(excludedTor), duplicateRows: Object.freeze(duplicateRows),
  }) });
}

function serializeCatalog(catalog) {
  const escape = value => /[,"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return catalog.records.map(record => [record.country, record.city, record.id].map(escape).join(',')).join('\n') + '\n';
}

function normalizeSelectionPolicy(input = {}, previous = DEFAULT_SELECTION_POLICY) {
  const fail = () => { throw new VpnCatalogError('INVALID_SELECTION_POLICY', 'Choose valid catalog filters and a supported server order.'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(name => !Object.hasOwn(DEFAULT_SELECTION_POLICY, name))) fail();
  const result = { ...structuredClone(DEFAULT_SELECTION_POLICY), ...structuredClone(previous), ...structuredClone(input) };
  if (!['all', 'countries', 'cities', 'servers', 'mixed'].includes(result.mode) ||
      !['shuffle', 'file-order', 'country-balanced'].includes(result.order) ||
      !Number.isSafeInteger(result.recentLimit) || result.recentLimit < 0 || result.recentLimit > 1000 ||
      typeof result.fallbackToAll !== 'boolean') fail();
  try {
    for (const name of ['countries', 'cities', 'servers', 'excludeCountries', 'excludeCities', 'excludeServers']) {
      if (!Array.isArray(result[name]) || result[name].length > MAX_SERVERS) fail();
      const seen = new Set();
      result[name] = result[name].map(value => {
        if (name.toLowerCase().endsWith('servers')) return serverId(value);
        if (!name.toLowerCase().endsWith('cities')) return label(value);
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'city,country') fail();
        return { country: label(value.country), city: label(value.city) };
      }).filter(value => {
        const id = typeof value === 'string' ? key(value) : cityKey(value);
        if (seen.has(id)) return false; seen.add(id); return true;
      });
    }
  } catch { fail(); }
  return result;
}

function poolRecords(catalog, policy, fallback = false) {
  const ids = new Set(policy.servers), excluded = new Set(policy.excludeServers);
  const countries = new Set(policy.countries.map(key)), excludedCountries = new Set(policy.excludeCountries.map(key));
  const cities = new Set(policy.cities.map(cityKey)), excludedCities = new Set(policy.excludeCities.map(cityKey));
  return catalog.records.filter(record => {
    const country = key(record.country), code = key(record.id.slice(0, 2));
    const city = cityKey(record), codeCity = cityKey({ country: code, city: record.city });
    if (excluded.has(record.id) || excludedCountries.has(country) || excludedCountries.has(code) ||
        excludedCities.has(city) || excludedCities.has(codeCity)) return false;
    if (fallback || policy.mode === 'all') return true;
    if (policy.mode === 'servers') return ids.has(record.id);
    if (policy.mode === 'mixed') return ids.has(record.id) || countries.has(country) || countries.has(code);
    if (policy.mode === 'countries') return countries.has(country) || countries.has(code);
    return cities.has(city) || cities.has(codeCity);
  });
}

function describePool(catalog, input = {}) {
  const policy = normalizeSelectionPolicy(input), records = poolRecords(catalog, policy);
  const byCountry = new Map(), byId = new Set(catalog.records.map(record => record.id));
  for (const record of records) {
    if (!byCountry.has(record.country)) byCountry.set(record.country, new Map());
    const cities = byCountry.get(record.country); cities.set(record.city, (cities.get(record.city) || 0) + 1);
  }
  return { servers: records.length, countries: [...byCountry].map(([country, cities]) => ({
    country, servers: [...cities.values()].reduce((sum, count) => sum + count, 0),
    cities: [...cities].map(([city, servers]) => ({ city, servers })),
  })), missingServers: policy.servers.filter(id => !byId.has(id)), policy };
}

function shuffle(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new TypeError('Random source must return a number from 0 up to 1.');
    const j = Math.floor(value * (i + 1)); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function orderRecords(records, order, random) {
  if (order === 'file-order') return [...records];
  if (order === 'shuffle') return shuffle(records, random);
  const buckets = new Map();
  for (const record of records) {
    const country = key(record.country);
    if (!buckets.has(country)) buckets.set(country, []);
    buckets.get(country).push(record);
  }
  const groups = shuffle([...buckets.values()], random).map(group => shuffle(group, random));
  const result = [];
  for (let i = 0, active = true; active; i++) {
    active = false;
    for (const group of groups) if (i < group.length) { result.push(group[i]); active = true; }
  }
  return result;
}

// One selector is one candidate pass. Exhaustion never silently starts over or
// broadens filters. The retry coordinator decides when to begin another pass.
function createCatalogSelector(catalog, input = {}, { random = Math.random } = {}) {
  const policy = normalizeSelectionPolicy(input), primary = poolRecords(catalog, policy);
  const primaryIds = new Set(primary.map(record => record.id));
  const fallback = policy.fallbackToAll && policy.mode !== 'all'
    ? poolRecords(catalog, policy, true).filter(record => !primaryIds.has(record.id)) : [];
  const queue = [...orderRecords(primary, policy.order, random).map(server => ({ server, fallback: false })),
    ...orderRecords(fallback, policy.order, random).map(server => ({ server, fallback: true }))];
  // Remove emitted nodes so a full catalog pass stays linear rather than
  // scanning thousands of already-used entries on every call. Skipped nodes
  // stay available if a later call changes its transient exclusions.
  let head = null, used = 0;
  for (let i = queue.length - 1; i >= 0; i--) head = { candidate: queue[i], next: head };
  return {
    policy: structuredClone(policy),
    next({ currentServer = null, recentServers = [], unavailableServers = [] } = {}) {
      const excluded = new Set(unavailableServers.map(serverId));
      if (currentServer) excluded.add(serverId(currentServer));
      if (policy.recentLimit) for (const id of recentServers.slice(-policy.recentLimit)) excluded.add(serverId(id));
      let node = head, previous = null;
      while (node && excluded.has(node.candidate.server.id)) { previous = node; node = node.next; }
      if (!node) return null;
      if (previous) previous.next = node.next; else head = node.next;
      used++;
      const candidate = node.candidate;
      return { target: { server: candidate.server.id }, server: { ...candidate.server }, fallback: candidate.fallback };
    },
    summary: () => ({ primary: primary.length, fallback: fallback.length, used }),
  };
}

// A traversal survives rounds and successful rotations. Peeking never consumes
// a server: cancellation during backoff must not skip a connection never tried.
function createCatalogTraversal(catalog, input = {}, { random = Math.random } = {}) {
  const policy = normalizeSelectionPolicy(input), primary = poolRecords(catalog, policy);
  const primaryIds = new Set(primary.map(record => record.id));
  const fallback = policy.fallbackToAll && policy.mode !== 'all'
    ? poolRecords(catalog, policy, true).filter(record => !primaryIds.has(record.id)) : [];
  const scopeKey = createHash('sha256').update(JSON.stringify([policy.order,
    primary.map(record => record.id), fallback.map(record => record.id)])).digest('hex');
  const members = new Set([...primaryIds, ...fallback.map(record => record.id)]);
  let pass = 0, used = 0, groups = [], nodes = new Map();
  function startPass() {
    pass++; used = 0; nodes = new Map();
    groups = [primary, fallback].map((records, index) => {
      const group = { cursor: null, size: records.length };
      let last = null;
      for (const server of orderRecords(records, policy.order, random)) {
        const node = { server, fallback: index === 1, group, next: null, previous: last };
        if (last) last.next = node; else group.cursor = node;
        last = node; nodes.set(server.id, node);
      }
      if (last) { last.next = group.cursor; group.cursor.previous = last; }
      return group;
    });
  }
  function consume(id, advance = true) {
    id = serverId(id);
    if (!pass) startPass();
    const node = nodes.get(id);
    if (!node) return false;
    const { group } = node;
    if (group.size === 1) group.cursor = null;
    else {
      node.previous.next = node.next; node.next.previous = node.previous;
      if (advance || group.cursor === node) group.cursor = node.next;
    }
    group.size--; nodes.delete(id); used++;
    node.next = node.previous = null;
    return true;
  }
  function bestCandidate(hard, avoided, recency) {
    let best = null;
    for (const group of groups) {
      let node = group.cursor;
      for (let i = 0; i < group.size; i++, node = node.next) {
        if (hard.has(node.server.id) || avoided.has(node.server.id)) continue;
        const score = recency.get(node.server.id) || 0;
        if (score === 0) return { node, score };
        if (!best || score < best.score) best = { node, score };
      }
    }
    return best;
  }
  return {
    scopeKey,
    contains: id => members.has(serverId(id)),
    consume: id => consume(id),
    observe: id => consume(id, false),
    peek({ currentServer = null, recentServers = [], unavailableServers = [], avoidServers = [], recentLimit = policy.recentLimit } = {}) {
      if (!members.size) return null;
      if (!pass || !nodes.size) startPass();
      const hard = new Set(unavailableServers.map(serverId));
      if (currentServer) hard.add(serverId(currentServer));
      const avoided = new Set(avoidServers.map(serverId));
      const history = recentLimit ? [...new Set(recentServers.map(serverId).reverse())].reverse().slice(-recentLimit) : [];
      const recency = new Map(history.map((id, index) => [id, index + 1]));
      // Prefer a new route, relaxing the oldest recent entries first. The
      // original route is a final recovery option if it is no longer current.
      let best = bestCandidate(hard, avoided, recency), originalAvoidanceRelaxed = false;
      if (!best) { best = bestCandidate(hard, new Set(), recency); originalAvoidanceRelaxed = Boolean(best); }
      if (!best) return null;
      return { target: { server: best.node.server.id }, server: { ...best.node.server }, fallback: best.node.fallback,
        recentAvoidanceRelaxed: best.score > 0, originalAvoidanceRelaxed };
    },
    nextCooldownAt(cooldowns, currentServer = null) {
      let earliest = Infinity;
      for (const id of nodes.keys()) if (id !== currentServer && cooldowns.has(id)) earliest = Math.min(earliest, cooldowns.get(id));
      return Number.isFinite(earliest) ? earliest : null;
    },
    summary: () => ({ primary: primary.length, fallback: fallback.length, total: members.size,
      pass, used, remaining: members.size - used }),
  };
}

module.exports = { parseCatalog, serializeCatalog, normalizeSelectionPolicy, describePool, createCatalogSelector,
  createCatalogTraversal, poolRecords, DEFAULT_SELECTION_POLICY, VpnCatalogError, MAX_BYTES };
