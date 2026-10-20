'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseCatalog, serializeCatalog, normalizeSelectionPolicy, describePool, createCatalogSelector, createCatalogTraversal, MAX_BYTES } = require('./vpn-catalog');
const { createCatalogStore, BUNDLED_CATALOG } = require('./vpn-catalog-store');

const SAMPLE = 'United States,Atlanta,US-GA#1\nUnited States,Denver,US-CO#2\nUnited States,Denver,US-CO#3\n' +
  'Canada,London,CA#1\nUnited Kingdom,London,UK#1\nGermany,Frankfurt,DE#1\nGermany,Berlin,DE#2\n';
const catalog = () => parseCatalog(SAMPLE);
const ids = (selector, options) => {
  const result = []; let candidate;
  while ((candidate = selector.next(options))) result.push(candidate.target.server);
  return result;
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-vpn-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createCatalogStore({ directory });
  return { directory, store };
}
function take(traversal, options) {
  const candidate = traversal.peek(options);
  if (candidate) traversal.consume(candidate.target.server);
  return candidate;
}
function seededRandom() {
  let seed = 12345;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

test('a persistent pass advances beyond deferred servers and peeking does not consume an unattempted candidate', () => {
  const traversal = createCatalogTraversal(catalog(), { order: 'file-order', recentLimit: 0 });
  assert.equal(traversal.peek().target.server, 'US-GA#1'); assert.equal(traversal.peek().target.server, 'US-GA#1');
  assert.equal(traversal.summary().used, 0);
  assert.equal(take(traversal, { unavailableServers: ['US-GA#1'] }).target.server, 'US-CO#2');
  assert.equal(take(traversal).target.server, 'US-CO#3');
  const rest = Array.from({ length: 5 }, () => take(traversal).target.server);
  assert.deepEqual(rest, ['CA#1', 'UK#1', 'DE#1', 'DE#2', 'US-GA#1']);
  assert.equal(traversal.summary().used, 7); assert.equal(traversal.summary().pass, 1);
  assert.equal(take(traversal).target.server, 'US-GA#1'); assert.equal(traversal.summary().pass, 2);
});
test('observing an existing connection consumes that server without jumping over earlier file entries', () => {
  const traversal = createCatalogTraversal(catalog(), { order: 'file-order' });
  assert.equal(traversal.observe('DE#1'), true); assert.equal(traversal.observe('DE#1'), false);
  assert.equal(take(traversal).target.server, 'US-GA#1'); assert.equal(traversal.summary().used, 2);
});
test('full-catalog shuffle consumes every regular server before reshuffling for the next pass', () => {
  const full = parseCatalog(fs.readFileSync(BUNDLED_CATALOG, 'utf8'));
  const traversal = createCatalogTraversal(full, { order: 'shuffle' }, { random: seededRandom() });
  const passes = []; let currentServer = null, recentServers = [];
  for (let pass = 1; pass <= 2; pass++) {
    const selected = [];
    for (let i = 0; i < full.records.length; i++) {
      const candidate = take(traversal, { currentServer, recentServers });
      assert.ok(candidate); assert.notEqual(candidate.target.server, currentServer);
      currentServer = candidate.target.server; selected.push(currentServer);
      recentServers = [...recentServers, currentServer].slice(-5);
    }
    assert.equal(new Set(selected).size, 16821); assert.equal(traversal.summary().pass, pass);
    assert.equal(traversal.summary().remaining, 0); passes.push(selected);
  }
  assert.notDeepEqual(passes[0], passes[1]);
});
test('country-balanced traversal preserves its country turns across individual connections', () => {
  const traversal = createCatalogTraversal(catalog(), { order: 'country-balanced' }, { random: () => 0.999 });
  assert.deepEqual(Array.from({ length: 7 }, () => take(traversal).target.server),
    ['US-GA#1', 'CA#1', 'UK#1', 'DE#1', 'US-CO#2', 'DE#2', 'US-CO#3']);
});
test('small pools relax the oldest recent entry while explicit exclusions, current route and cooldowns remain strict', () => {
  const traversal = createCatalogTraversal(catalog(), { mode: 'servers', servers: ['CA#1', 'DE#1', 'DE#2'],
    excludeServers: ['DE#2'], order: 'file-order', recentLimit: 1000 });
  const options = { currentServer: 'CA#1', recentServers: ['DE#1', 'CA#1'], unavailableServers: ['DE#1'] };
  assert.equal(traversal.peek(options), null);
  const candidate = traversal.peek({ ...options, unavailableServers: [] });
  assert.equal(candidate.target.server, 'DE#1'); assert.equal(candidate.recentAvoidanceRelaxed, true);
  assert.equal(traversal.contains('DE#2'), false);
  assert.equal(traversal.peek({ currentServer: 'DE#1', recentServers: ['CA#1'], avoidServers: ['CA#1'] }).originalAvoidanceRelaxed, true);
});
test('only remaining candidates in the active pass contribute to cooldown wake-up times', () => {
  const traversal = createCatalogTraversal(catalog(), { mode: 'servers', servers: ['CA#1', 'DE#1'], order: 'file-order' });
  take(traversal);
  assert.equal(traversal.nextCooldownAt(new Map([['CA#1', 10], ['DE#1', 50], ['DE#2', 1]])), 50);
  assert.equal(traversal.nextCooldownAt(new Map([['DE#1', 50]]), 'DE#1'), null);
});
test('equivalent effective pools share an identity despite recent preferences, spelling or inclusion-list order', () => {
  const a = createCatalogTraversal(catalog(), { mode: 'countries', countries: ['DE'], order: 'file-order' });
  const b = createCatalogTraversal(catalog(), { mode: 'servers', servers: ['DE#2', 'DE#1'], order: 'file-order', recentLimit: 0 });
  assert.equal(a.scopeKey, b.scopeKey);
  assert.notEqual(a.scopeKey, createCatalogTraversal(catalog(), { mode: 'countries', countries: ['DE'], order: 'shuffle' }).scopeKey);
});
test('fallback traversal stays inside explicit exclusions and repeats its primary-first order only after a complete pass', () => {
  const traversal = createCatalogTraversal(catalog(), { mode: 'servers', servers: ['DE#2'], fallbackToAll: true,
    excludeCountries: ['US'], excludeServers: ['DE#1'], order: 'file-order', recentLimit: 0 });
  const first = take(traversal); assert.equal(first.target.server, 'DE#2'); assert.equal(first.fallback, false);
  const rest = Array.from({ length: 2 }, () => take(traversal));
  assert.deepEqual(rest.map(candidate => candidate.target.server), ['CA#1', 'UK#1']); assert.ok(rest.every(candidate => candidate.fallback));
  assert.equal(traversal.summary().remaining, 0); assert.equal(take(traversal).target.server, 'DE#2');
});

test('bundled user catalog includes all regular servers and reports the seven excluded Tor rows', () => {
  const source = fs.readFileSync(BUNDLED_CATALOG, 'utf8'), result = parseCatalog(source);
  assert.equal(result.records.length, 16821);
  assert.equal(result.report.rows, 16828); assert.equal(result.report.countries, 144); assert.equal(result.report.cities, 189);
  assert.equal(result.report.excludedTor.length, 7); assert.equal(result.report.duplicateRows.length, 0);
  assert.deepEqual(result.records[0], { country: 'Afghanistan', city: 'Kabul', id: 'AF#1' });
  assert.equal(result.records.at(-1).id, 'YE#8');
  assert.ok(result.records.some(record => record.country === 'Côte d’Ivoire'));
  assert.ok(result.records.some(record => record.country === 'Bosnia & Herzegovina'));
  assert.ok(result.records.some(record => record.country === 'Myanmar (Burma)'));
  assert.deepEqual(parseCatalog(serializeCatalog(result)).records, result.records);
  const packaging = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(packaging.build.files.includes('assets/**/*'));
});
test('CSV parsing supports BOM, CRLF, header, quoted commas/quotes and exact duplicate reporting', () => {
  const result = parseCatalog('\uFEFFcountry,city,server\r\n"Test, Land","City ""Centre""",zz#1\r\nTest,Other,ZZ#2\r\nTest,Other,ZZ#2\r\n');
  assert.deepEqual(result.records[0], { country: 'Test, Land', city: 'City "Centre"', id: 'ZZ#1' });
  assert.equal(result.report.header, true); assert.equal(result.report.duplicateRows[0].line, 4);
  assert.deepEqual(parseCatalog(serializeCatalog(result)).records, result.records);
});
test('invalid imports cannot smuggle selectors, malformed CSV or contradictory server locations', () => {
  for (const text of ['', '\n', 'Country,City,--help', 'Country,City,DE#1;echo', 'Country,City,DE#1,extra',
    'Country,City,DE#1\nOther,City,DE#1', '"Country,City,DE#1', '"Country"x,City,DE#1',
    'Country,Ci"ty,DE#1', 'Country,"Ci\nty",DE#1', 'Country,City,DE#1\u0000',
    'Country,City,DE#1-SC', 'Country,City,DE#1-TOR', 'x'.repeat(MAX_BYTES + 1)]) {
    assert.throws(() => parseCatalog(text), error => error.code === 'INVALID_CATALOG');
  }
});
test('normalization validates full pools independently from the legacy 100-server limit', () => {
  const result = normalizeSelectionPolicy({ mode: 'servers', servers: Array.from({ length: 200 }, (_, i) => `de#${i + 1}`) });
  assert.equal(result.servers.length, 200); assert.equal(result.servers[0], 'DE#1');
  const deduplicated = normalizeSelectionPolicy({ countries: ['Canada', 'canada'], servers: ['de#1', 'DE#1'],
    cities: [{ country: 'Germany', city: 'Berlin' }, { country: 'germany', city: 'berlin' }] });
  assert.equal(deduplicated.countries.length, 1); assert.equal(deduplicated.cities.length, 1); assert.equal(deduplicated.servers.length, 1);
  result.servers.pop(); assert.deepEqual(normalizeSelectionPolicy().servers, []);
  for (const input of [null, [], { mode: 'fastest' }, { order: 'latency' }, { random: true }, { servers: ['--help'] },
    { cities: ['London'] }, { cities: [{ city: 'London' }] }, { cities: [{ country: 'CA', city: 'London', extra: 1 }] },
    { countries: ['\n'] }, { recentLimit: -1 }, { recentLimit: 1.1 }, { fallbackToAll: 'yes' }]) {
    assert.throws(() => normalizeSelectionPolicy(input), error => error.code === 'INVALID_SELECTION_POLICY');
  }
});
test('country and country/city filters accept case-insensitive names or server country prefixes', () => {
  assert.deepEqual(ids(createCatalogSelector(catalog(), { mode: 'countries', countries: ['germany', 'ca'], order: 'file-order' })), ['CA#1', 'DE#1', 'DE#2']);
  assert.deepEqual(ids(createCatalogSelector(catalog(), { mode: 'cities', cities: [{ country: 'ca', city: 'london' }], order: 'file-order' })), ['CA#1']);
  assert.equal(describePool(catalog(), { mode: 'cities', cities: [{ country: 'CA', city: 'London' }] }).servers, 1);
});
test('server selections keep source order and report stale IDs without substituting another location', () => {
  const policy = { mode: 'servers', servers: ['DE#2', 'US-CO#3', 'DE#999999'], order: 'file-order' };
  assert.deepEqual(ids(createCatalogSelector(catalog(), policy)), ['US-CO#3', 'DE#2']);
  assert.deepEqual(describePool(catalog(), policy).missingServers, ['DE#999999']);
  assert.equal(createCatalogSelector(catalog(), { ...policy, servers: ['DE#999999'] }).next(), null);
});
test('exclusions always override inclusions and apply to country, city and server', () => {
  const policy = { excludeCountries: ['uk'], excludeCities: [{ country: 'US', city: 'Denver' }], excludeServers: ['DE#1'], order: 'file-order' };
  assert.deepEqual(ids(createCatalogSelector(catalog(), policy)), ['US-GA#1', 'CA#1', 'DE#2']);
  assert.equal(describePool(catalog(), policy).servers, 3);
});
test('an empty selected pool remains empty; all-country fallback requires an explicit choice', () => {
  for (const mode of ['countries', 'cities', 'servers']) assert.equal(createCatalogSelector(catalog(), { mode }).next(), null);
  const selector = createCatalogSelector(catalog(), { mode: 'countries', countries: ['CA'], order: 'file-order', fallbackToAll: true, excludeCountries: ['DE'] });
  assert.deepEqual(selector.next(), { target: { server: 'CA#1' }, server: { country: 'Canada', city: 'London', id: 'CA#1' }, fallback: false });
  assert.equal(selector.next().fallback, true);
  assert.deepEqual(ids(selector), ['US-CO#2', 'US-CO#3', 'UK#1']);
});
test('current server, recent history and temporarily unavailable candidates are excluded independently', () => {
  const selector = createCatalogSelector(catalog(), { order: 'file-order', recentLimit: 2 });
  const options = { currentServer: 'us-ga#1', recentServers: ['US-CO#2', 'CA#1', 'UK#1'], unavailableServers: ['DE#1'] };
  assert.deepEqual(ids(selector, options), ['US-CO#2', 'US-CO#3', 'DE#2']);
  // Skipped candidates were not consumed: another round can use them once the
  // coordinator's current/recent/cooldown exclusions change.
  assert.deepEqual(ids(selector), ['US-GA#1', 'CA#1', 'UK#1', 'DE#1']);
  assert.equal(selector.next(), null);
});
test('recent avoidance can be disabled, but current server avoidance cannot be relaxed', () => {
  assert.deepEqual(ids(createCatalogSelector(catalog(), { order: 'file-order', recentLimit: 0 }),
    { currentServer: 'CA#1', recentServers: ['DE#1', 'DE#2'] }), ['US-GA#1', 'US-CO#2', 'US-CO#3', 'UK#1', 'DE#1', 'DE#2']);
});
test('each ordering strategy exhausts without repeats, and shuffle changes source order', () => {
  for (const order of ['shuffle', 'file-order', 'country-balanced']) {
    const selector = createCatalogSelector(catalog(), { order }, { random: () => 0 });
    const result = ids(selector);
    assert.equal(result.length, 7); assert.equal(new Set(result).size, 7); assert.equal(selector.next(), null);
    assert.deepEqual(selector.summary(), { primary: 7, fallback: 0, used: 7 });
    if (order === 'shuffle') assert.notEqual(result[0], 'US-GA#1');
  }
});
test('country-balanced order gives every country one turn before taking a second from a larger country', () => {
  const result = ids(createCatalogSelector(catalog(), { order: 'country-balanced' }, { random: () => 0.999 }));
  assert.deepEqual(result.slice(0, 4), ['US-GA#1', 'CA#1', 'UK#1', 'DE#1']);
  assert.deepEqual(result.slice(4), ['US-CO#2', 'DE#2', 'US-CO#3']);
});
test('a complete catalog pass is finite and emits validated explicit CLI targets', () => {
  const full = parseCatalog(fs.readFileSync(BUNDLED_CATALOG, 'utf8'));
  const selector = createCatalogSelector(full);
  let candidate, count = 0;
  const { normalizeTarget } = require('./protonvpn');
  while ((candidate = selector.next())) { assert.deepEqual(normalizeTarget(candidate.target), candidate.target); count++; }
  assert.equal(count, 16821);
});
test('catalog store loads bundled data without creating files, then persists a local import across instances', t => {
  const { store, directory } = fixture(t);
  assert.equal(store.load().source, 'bundled'); assert.deepEqual(fs.readdirSync(directory), []);
  const saved = store.importText(SAMPLE);
  assert.equal(saved.catalog.records.length, 7); assert.equal(saved.source, 'imported');
  const restored = createCatalogStore({ directory }).load();
  assert.deepEqual(restored.catalog.records, saved.catalog.records);
  assert.equal(restored.source, 'imported');
  assert.deepEqual(fs.readdirSync(directory), ['vpn-servers.csv']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'vpn-servers.csv')).mode & 0o777, 0o600);
  assert.equal(store.reset().catalog.records.length, 16821); assert.equal(store.load().source, 'bundled');
});
test('file imports preserve source contents and report skipped Tor records', t => {
  const { store, directory } = fixture(t), source = path.join(directory, 'original.txt');
  const text = SAMPLE + 'France,Paris,FR#13-TOR,[cite: 34]\n'; fs.writeFileSync(source, text);
  const result = store.importFile(source);
  assert.equal(result.catalog.report.excludedTor.length, 1);
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  assert.equal(store.load().catalog.records.length, 7);
});
test('invalid or missing imports preserve the working catalog and return bounded errors', t => {
  const { store, directory } = fixture(t); store.importText(SAMPLE);
  const before = fs.readFileSync(path.join(directory, 'vpn-servers.csv'), 'utf8');
  assert.throws(() => store.importText('secret invalid contents'), error => error.code === 'INVALID_CATALOG' && !error.message.includes('secret'));
  assert.throws(() => store.importFile(path.join(directory, 'secret-missing')), error => error.code === 'CATALOG_STORAGE_FAILED' && !error.message.includes('secret'));
  assert.equal(fs.readFileSync(path.join(directory, 'vpn-servers.csv'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['vpn-servers.csv']);
});
test('corrupt imported data never silently broadens the pool by reverting to bundled servers', t => {
  const { store, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'vpn-servers.csv'), 'broken');
  assert.throws(() => store.load(), error => error.code === 'INVALID_CATALOG');
});
test('failed storage writes and failed resets retain the saved import', t => {
  const { store, directory } = fixture(t); store.importText(SAMPLE);
  const badBundle = createCatalogStore({ directory, bundledPath: path.join(directory, 'missing') });
  assert.throws(() => badBundle.reset(), error => error.code === 'CATALOG_STORAGE_FAILED');
  assert.equal(store.load().catalog.records.length, 7);
  const blocked = path.join(directory, 'not-a-directory'); fs.writeFileSync(blocked, 'x');
  assert.throws(() => createCatalogStore({ directory: blocked }).importText(SAMPLE), error => error.code === 'CATALOG_STORAGE_FAILED');
  assert.throws(() => createCatalogStore({ directory: '.' }).load(), error => error.code === 'CATALOG_STORAGE_FAILED');
});
test('catalog loading, importing and selection never invoke a CLI or contact any network', t => {
  const deny = () => { throw new Error('Unexpected CLI or external request'); };
  for (const [mod, methods] of [[require('node:http'), ['get', 'request']], [require('node:https'), ['get', 'request']],
    [require('node:dns'), ['lookup', 'resolve']], [require('node:child_process'), ['spawn', 'exec', 'execFile', 'spawnSync']]]) {
    for (const method of methods) { const original = mod[method]; mod[method] = deny; t.after(() => { mod[method] = original; }); }
  }
  const original = globalThis.fetch; globalThis.fetch = deny; t.after(() => { globalThis.fetch = original; });
  const { store } = fixture(t); store.load(); store.importText(SAMPLE);
  assert.equal(ids(createCatalogSelector(store.load().catalog)).length, 7); store.reset();
});
