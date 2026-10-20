'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { backend, TOKEN } = require('../scripts/fixtures/mail-inbox.cjs');
const { createMailInbox, normalizeConnection, normalizeDomain } = require('./mail-inbox');
const URL_A = 'https://first.fixture.workers.dev', URL_B = 'https://second.fixture.workers.dev';

function client(t, servers = {}, { secure = false, clock = Date.now } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-mail-'));
  const options = { directory: () => directory, now: clock,
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => secure ? 'gnome_libsecret' : 'basic_text',
      encryptString: text => Buffer.from(text).map(n => n ^ 123), decryptString: value => value.map(n => n ^ 123).toString() },
    network: { run: (_kind, fn) => fn(), interruption: () => {},
      fetchNetwork: (url, opts) => {
        assert.equal(opts.redirect, 'manual'); assert.equal(new URL(url).search.includes(TOKEN), false);
        const server = servers[new URL(url).origin]; if (!server) throw new Error('No fixture backend');
        return server.fetch(url, opts);
      } } };
  const clients = [];
  const create = () => { const inbox = createMailInbox(options); clients.push(inbox); return inbox; };
  const inbox = create();
  t.after(async () => { for (const item of clients) await item.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const save = (url = URL_A, extra = {}) => inbox.save({ url, token: TOKEN, ...extra }).savedId;
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, 'mail-inbox.json'), 'utf8'));
  return { inbox, create, options, directory, save, saved };
}
async function server(t, opts) { const item = await backend(opts); t.after(() => item.close()); return item; }

test('connection validation keeps credentials on a Worker origin and normalizes domains', () => {
  assert.deepEqual(normalizeConnection({ url: URL_A }), { url: URL_A });
  assert.equal(normalizeDomain('EXAMPLE.COM.'), 'example.com');
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de');
  for (const url of ['http://first.fixture.workers.dev', 'https://localhost', 'https://127.0.0.1',
    'https://workers.dev.evil.test', URL_A + '/path', 'https://user@first.fixture.workers.dev', URL_A + '?token=secret']) {
    assert.throws(() => normalizeConnection({ url }));
  }
  for (const domain of ['a@b.com', 'https://example.com', 'bad/domain', 'example.com/path', 'example.com:443']) assert.throws(() => normalizeDomain(domain));
});

test('local credentials persist across restarts, remain out of public state, and have restrictive permissions', async t => {
  const remote = await server(t), c = client(t, { [URL_A]: remote }), id = c.save();
  assert.equal(c.saved().connections[0].token, TOKEN);
  assert.equal(c.inbox.state().connections[0].storage, 'local');
  assert.equal(JSON.stringify(c.inbox.state()).includes(TOKEN), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(c.directory, 'mail-inbox.json')).mode & 0o777, 0o600);
  await c.inbox.dispose();
  const restored = c.create();
  assert.equal(restored.state().connections[0].hasToken, true);
  await restored.test({ connectionId: id });
  restored.save({ id, url: URL_A, token: '' });
  assert.equal(c.saved().connections[0].token, TOKEN);
});

test('secure storage, failure fallback, and explicit migration preserve the approved credential behavior', async t => {
  for (const mode of ['secure', 'unavailable', 'detection-error', 'backend-error', 'encryption-error', 'missing']) {
    const c = client(t, {}, { secure: true }), fail = () => { throw new Error('Keyring unavailable'); };
    if (mode === 'unavailable') c.options.safeStorage.isEncryptionAvailable = () => false;
    if (mode === 'detection-error') c.options.safeStorage.isEncryptionAvailable = fail;
    if (mode === 'backend-error') c.options.safeStorage.getSelectedStorageBackend = fail;
    if (mode === 'encryption-error') c.options.safeStorage.encryptString = fail;
    if (mode === 'missing') c.options.safeStorage = undefined;
    const inbox = c.create(), id = inbox.save({ url: URL_A, token: TOKEN }).savedId, record = c.saved().connections[0];
    assert.equal(inbox.state().connections[0].storage, mode === 'secure' ? 'encrypted' : 'local');
    assert.equal(record.token === TOKEN, mode !== 'secure');
    assert.equal(c.create().state().connections[0].hasToken, true);
    if (mode === 'secure') {
      assert.equal(JSON.stringify(record).includes(TOKEN), false);
      c.options.safeStorage.isEncryptionAvailable = () => false;
      assert.equal(c.create().state().connections[0].tokenUnavailable, true);
      inbox.save({ id, url: URL_A, token: '' });
      assert.equal(c.saved().connections[0].token, TOKEN);
    }
  }
  const c = client(t); const id = c.save(), before = JSON.stringify(c.saved());
  c.options.safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  assert.equal(c.create().state().connections[0].storage, 'local');
  assert.equal(JSON.stringify(c.saved()), before);
  c.inbox.save({ id, url: URL_A, token: '' });
  assert.equal(Object.hasOwn(c.saved().connections[0], 'token'), false);
});

test('legacy app settings and Worker messages migrate without losing credentials or history', async t => {
  const remote = await server(t, { domain: 'old.example', legacy: true, seedLegacy: true });
  const c = client(t, { [URL_A]: remote });
  const old = JSON.stringify({ url: URL_A, domain: 'old.example', token: TOKEN });
  fs.writeFileSync(path.join(c.directory, 'mail-inbox.json'), old);
  const state = c.inbox.state();
  assert.equal(state.connections[0].id, 'legacy-connection');
  assert.equal(fs.readFileSync(path.join(c.directory, 'mail-inbox.v1-backup.json'), 'utf8'), old);
  assert.equal(c.saved().version, 2);
  await c.inbox.sync({ force: true });
  assert.equal(c.inbox.list().messages[0].subject, 'Existing mail');
  assert.equal(c.inbox.domains().domains[0].name, 'old.example');
  assert.equal(c.inbox.state().connections[0].version, 1);
  await assert.rejects(c.inbox.addDomains({ connectionId: state.connections[0].id, names: ['new.example'] }), /Upgrade/);
  const detail = await c.inbox.read({ connectionId: state.connections[0].id, id: 1 });
  assert.equal(detail.message.body, 'Existing body');
});

test('a legacy encrypted token is preserved during migration, including when the keyring is locked', async t => {
  const c = client(t, {}, { secure: true });
  const encryptedToken = c.options.safeStorage.encryptString(TOKEN).toString('base64');
  fs.writeFileSync(path.join(c.directory, 'mail-inbox.json'), JSON.stringify({ url: URL_A, domain: 'old.example', encryptedToken }));
  assert.equal(c.inbox.state().connections[0].storage, 'encrypted');
  c.options.safeStorage.decryptString = () => { throw new Error('Locked'); };
  const restored = c.create();
  assert.equal(restored.state().connections[0].tokenUnavailable, true);
  assert.equal(c.saved().connections[0].encryptedToken, encryptedToken);
  c.options.safeStorage.isEncryptionAvailable = () => false;
  restored.save({ id: 'legacy-connection', url: URL_A, token: TOKEN });
  assert.equal(c.saved().connections[0].token, TOKEN);
});

test('failed atomic replacement preserves the previous saved credentials and cache identity', t => {
  const c = client(t), id = c.save(), before = JSON.stringify(c.saved());
  t.mock.method(fs, 'renameSync', (temporary, target) => {
    assert.match(temporary, /\.tmp$/); assert.equal(target, path.join(c.directory, 'mail-inbox.json'));
    throw new Error('Replacement failed');
  });
  assert.throws(() => c.inbox.save({ id, url: URL_A, token: 'replacement-token-'.repeat(3) }), /Replacement failed/);
  assert.equal(JSON.stringify(c.saved()), before);
  assert.equal(c.inbox.state().connections[0].id, id);
  assert.equal(fs.readdirSync(c.directory).some(name => name.endsWith('.tmp')), false);
});

test('five domains share one backend, bulk validation is per item, and delivery is confirmed independently', async t => {
  const remote = await server(t), c = client(t, { [URL_A]: remote }), id = c.save();
  const names = Array.from({ length: 5 }, (_, i) => 'domain' + i + '.example');
  const added = await c.inbox.addDomains({ connectionId: id, names: [...names, names[0].toUpperCase(), 'bad@address'] });
  assert.equal(added.results.filter(item => item.status === 'added').length, 5);
  assert.equal(added.results.filter(item => item.status === 'duplicate').length, 1);
  assert.equal(added.results.filter(item => item.status === 'invalid').length, 1);
  assert.equal(c.inbox.domains().domains.length, 5);
  assert.equal(await remote.deliver('unregistered.example'), 'Unknown or disabled email domain');
  for (const name of names) await remote.deliver(name, { subject: 'Welcome ' + name });
  const test = await c.inbox.domainAction({ connectionId: id, domain: names[0], action: 'test' });
  let row = c.inbox.domains({ name: names[0] }).domains[0];
  assert.equal(row.last_test_received_at, null);
  await remote.deliver(names[0], { to: test.recipient, subject: 'Delivery test' });
  remote.calls.length = 0;
  await c.inbox.sync({ force: true });
  assert.equal(c.inbox.list().messages.length, 6);
  row = c.inbox.domains({ name: names[0] }).domains[0];
  assert.ok(row.last_test_received_at >= row.test_requested_at);
  assert.equal(remote.calls.filter(call => call.path === '/v2/changes').length, 1);
  assert.equal(c.inbox.list({ connectionId: id, domain: names[1] }).messages.length, 1);
  assert.equal(c.inbox.list({ recipient: 'hello@' + names[2] }).messages.length, 1);
  assert.equal(c.inbox.list({ q: 'welcome' }).messages.length, 5);
  await c.inbox.domainAction({ connectionId: id, domain: names[0], action: 'enabled', enabled: false });
  assert.ok(await remote.deliver(names[0]));
  assert.equal(c.inbox.list({ domain: names[0] }).messages.length, 2);
  await c.inbox.domainAction({ connectionId: id, domain: names[0], action: 'enabled', enabled: true });
  assert.equal(await remote.deliver(names[0]), null);
});

test('multiple connections combine colliding IDs, isolate errors with backoff, and persist checkpoints', async t => {
  let timestamp = Date.now();
  const a = await server(t, { now: () => timestamp }), b = await server(t, { now: () => timestamp });
  const c = client(t, { [URL_A]: a, [URL_B]: b }, { clock: () => timestamp }), first = c.save(), second = c.save(URL_B);
  await c.inbox.addDomains({ connectionId: first, names: ['first.example'] });
  await c.inbox.addDomains({ connectionId: second, names: ['second.example'] });
  await a.deliver('first.example', { subject: 'First backend' }); await b.deliver('second.example', { subject: 'Second backend' });
  await c.inbox.sync({ force: true });
  const items = c.inbox.list().messages;
  assert.equal(items.length, 2); assert.equal(items[0].id, items[1].id);
  assert.notEqual(items[0].connection_id, items[1].connection_id);
  a.setFailure(true);
  await b.deliver('second.example', { subject: 'Still receiving' });
  await c.inbox.sync({ force: true });
  assert.equal(c.inbox.list().messages.length, 3);
  assert.match(c.inbox.state().connections.find(item => item.id === first).error, /503/);
  a.calls.length = 0; await c.inbox.sync();
  assert.equal(a.calls.length, 0);
  await c.inbox.dispose();
  const restarted = c.create();
  assert.equal(restarted.list().messages.length, 3);
  a.setFailure(false); timestamp += 10000;
  await restarted.sync({ force: true });
  assert.equal(restarted.list().messages.length, 3);
  assert.equal(restarted.state().connections[0].error, '');
  restarted.disconnect(first);
  assert.equal(restarted.list().messages.length, 2);
  assert.equal((await a.api('/v2/messages')).data.messages.length, 1);
});

test('paging and incremental updates keep order without duplicates and an expired checkpoint resynchronizes', async t => {
  let timestamp = Date.now();
  const remote = await server(t, { now: () => timestamp }), c = client(t, { [URL_A]: remote }, { clock: () => timestamp }), id = c.save();
  await c.inbox.addDomains({ connectionId: id, names: ['paging.example'] });
  for (let i = 0; i < 85; i++) await remote.deliver('paging.example', { subject: 'Message ' + i });
  await c.inbox.sync({ force: true });
  const first = c.inbox.list(), second = c.inbox.list({ before: first.nextCursor }), third = c.inbox.list({ before: second.nextCursor });
  assert.deepEqual([first.messages.length, second.messages.length, third.messages.length], [40, 40, 5]);
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map(item => item.id)).size, 85);
  const selected = third.messages[0];
  timestamp++;
  await remote.deliver('paging.example', { subject: 'New mail' });
  await c.inbox.sync({ force: true });
  assert.equal((await c.inbox.read({ connectionId: id, id: selected.id })).message.subject, selected.subject);
  assert.equal(c.inbox.list().messages[0].subject, 'New mail');
  timestamp += 7 * 86400000 + 10;
  await remote.worker.scheduled({}, remote.env);
  await remote.deliver('paging.example', { subject: 'After retention' });
  await c.inbox.sync({ force: true });
  assert.equal(c.inbox.list().messages.length, 1);
  assert.equal(c.inbox.list().messages[0].subject, 'After retention');
  assert.equal(c.inbox.domains().domains[0].name, 'paging.example');
});

test('large domain collections are paged and are not reloaded during ordinary sync', async t => {
  const remote = await server(t), c = client(t, { [URL_A]: remote }), id = c.save();
  const names = Array.from({ length: 1205 }, (_, i) => 'd' + String(i).padStart(5, '0') + '.example');
  await remote.add(names);
  for (let passes = 0; passes < 8; passes++) {
    await c.inbox.sync({ force: true });
    if (!c.inbox.state().connections[0].pending) break;
  }
  assert.equal(c.inbox.state().connections[0].domainCount, 1205);
  const first = c.inbox.domains(), second = c.inbox.domains({ after: first.nextCursor });
  assert.equal(first.domains.length, 60); assert.equal(second.domains.length, 60);
  assert.equal(first.domains.some(a => second.domains.some(b => a.name === b.name)), false);
  assert.equal(c.inbox.domains({ q: 'd01204' }).domains[0].name, 'd01204.example');
  remote.calls.length = 0;
  await c.inbox.sync({ force: true });
  assert.equal(remote.calls.filter(call => call.path === '/v2/domains').length, 0);
  assert.equal(remote.calls.length, 2); // One health request and one changes request for every domain.
  assert.equal(id, c.inbox.state().connections[0].id);
});

test('Worker auth, exact-domain checks, safe MIME rendering and legacy routes remain supported', async t => {
  const remote = await server(t, { domain: 'legacy.example', seedLegacy: true });
  assert.equal((await remote.api('/v2/domains', { token: 'wrong-token-'.repeat(4) })).status, 401);
  assert.equal((await remote.api('/v2/domains', { method: 'POST', body: { names: Array(11).fill('x.example') } })).status, 400);
  await remote.add(['new.example']);
  assert.ok(await remote.deliver('evil-new.example'));
  await remote.deliver('new.example', { subject: '100% real', html: '<p>Hello &amp; welcome</p><script>bad()</script><a href="https://mega.nz/#confirm123">Confirm</a><a href="javascript:bad()">bad</a>' });
  const detail = await remote.api('/v2/messages/2');
  assert.match(detail.data.message.body, /Hello & welcome/);
  assert.equal(detail.data.message.body.includes('bad()'), false);
  assert.deepEqual(detail.data.message.links, ['https://mega.nz/#confirm123']);
  const legacy = await remote.api('/v1/messages');
  assert.equal(legacy.data.messages.length, 1); assert.equal(legacy.data.messages[0].subject, 'Existing mail');
  assert.equal((await remote.api('/v1/messages/2')).status, 404);
  assert.equal((await remote.api('/v2/messages?q=100%25')).data.messages.length, 1);
  assert.equal((await remote.api('/v2/messages?recipient=' + encodeURIComponent("' OR 1=1 --"))).data.messages.length, 0);
});

test('bad credentials, wrong legacy domain and duplicate backend connections fail visibly', async t => {
  const remote = await server(t, { domain: 'actual.example', legacy: true });
  const c = client(t, { [URL_A]: remote }), id = c.save(URL_A, { domain: 'wrong.example' });
  await assert.rejects(c.inbox.test({ connectionId: id }), /does not match/);
  c.inbox.save({ id, url: URL_A, token: 'wrong-token-'.repeat(4) });
  await assert.rejects(c.inbox.test({ connectionId: id }), /rejected/);
  const shared = await server(t), other = client(t, { [URL_A]: shared, [URL_B]: shared });
  const a = other.save(), b = other.save(URL_B);
  await other.inbox.sync({ connectionId: a, force: true });
  await other.inbox.sync({ connectionId: b, force: true });
  assert.match(other.inbox.state().connections.find(item => item.id === b).error, /already connected/);
});


test('concurrent discovery rejects a duplicate database before importing duplicate mail', async t => {
  const shared = await server(t);
  await shared.add(['shared.example']); await shared.deliver('shared.example');
  const c = client(t, { [URL_A]: shared, [URL_B]: shared });
  c.save(); c.save(URL_B);
  await c.inbox.sync({ force: true });
  assert.equal(c.inbox.state().connections.filter(item => /already connected/.test(item.error)).length, 1);
  assert.equal(c.inbox.list().messages.length, 1);
});

test('metadata and checkpoints roll back together if a sync page is malformed', async t => {
  const { createInboxStore } = require('./mail-inbox-store');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-mail-store-'));
  const store = createInboxStore(() => directory);
  t.after(() => { store.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.patch('source', { cursor: 5 });
  const summary = { id: 1, domain: 'example.com', recipient: 'a@example.com', sender: 'sender@example.org', subject: 'Valid',
    received_at: Date.now(), expires_at: Date.now() + 10000 };
  assert.throws(() => store.apply('source', { messages: [summary, { ...summary, id: -1 }] }, { cursor: 7 }), /Invalid message/);
  assert.equal(store.list().messages.length, 0); assert.equal(store.sync('source').cursor, 5);
  store.apply('source', { messages: [summary] }, { cursor: 7 });
  assert.equal(store.list().messages.length, 1); assert.equal(store.sync('source').cursor, 7);
});
