'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const { backend, TOKEN } = require('../scripts/fixtures/mail-inbox.cjs');
const { createMailInbox } = require('./mail-inbox');
const { createCloudflareSignupMail, signupEmailSource, confirmationLink } = require('./signup-mail');
const URL_A = 'https://signup.fixture.workers.dev';

async function setup(t, names = ['one.example', 'two.example', 'three.example', 'four.example', 'five.example']) {
  let clock = 1800000000000;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-signup-'));
  const remote = await backend({ now: () => clock }); await remote.add(names);
  const servers = { [URL_A]: remote };
  const inbox = createMailInbox({ directory: () => directory, now: () => clock,
    network: { run: (_kind, fn) => fn(), interruption: error => { if (error.vpnInterrupted) throw error; },
      fetchNetwork: (url, opts) => servers[new URL(url).origin].fetch(url, opts) } });
  const id = inbox.save({ url: URL_A, token: TOKEN }).savedId;
  const service = (options = {}) => createCloudflareSignupMail({ inbox, directory: () => directory,
    now: () => clock, pick: n => n - 1, ...options });
  const opts = { shouldAbort: () => false, cancellableDelay: async ms => { clock += ms; } };
  t.after(async () => { await inbox.dispose(); remote.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { remote, servers, inbox, id, directory, service, opts, now: () => clock };
}

test('signup source defaults to temp mail and rejects unknown values', () => {
  assert.equal(signupEmailSource(), 'temp-mail');
  assert.equal(signupEmailSource('cloudflare'), 'cloudflare');
  for (const value of [null, '', 'other']) assert.throws(() => signupEmailSource(value));
});

test('Cloudflare discovers domains without an Inbox UI sync, and resumes a consumed deck after restart', async t => {
  const c = await setup(t);
  assert.equal(c.inbox.domains().domains.length, 0);
  const providers = await c.service().providers(c.opts), used = [];
  assert.equal(providers.length, 5);
  for (let i = 0; i < 2; i++) used.push((await providers[i].fn()).email);
  const saved = JSON.parse(fs.readFileSync(path.join(c.directory, 'mail-signup-rotation.json')));
  assert.equal(saved.remaining.length, 3);
  const restarted = await c.service().providers(c.opts);
  for (let i = 0; i < 3; i++) used.push((await restarted[i].fn()).email);
  assert.equal(new Set(used.map(email => email.split('@')[1])).size, 5);
  const secondCycle = [];
  for (let i = 0; i < 5; i++) secondCycle.push((await restarted[i].fn()).email);
  assert.equal(new Set(secondCycle.map(email => email.split('@')[1])).size, 5);
  assert.equal(new Set([...used, ...secondCycle]).size, 10);
  for (const email of used) assert.match(email, /^[a-z]+\.[a-z]+\d{4,}@/);
});

test('each exhausted cycle is shuffled, not sorted or a repeated fixed order', async t => {
  const c = await setup(t), orders = [];
  let shuffleCalls = 0;
  const providers = await c.service({ pick: n => { if (n <= 5) { shuffleCalls++; return shuffleCalls % n; } return 0; } }).providers(c.opts);
  for (let cycle = 0; cycle < 2; cycle++) {
    const order = [];
    for (let i = 0; i < 5; i++) order.push((await providers[i].fn()).email.split('@')[1]);
    orders.push(order);
  }
  assert.notDeepEqual(orders[0], orders[1]);
  assert.deepEqual([...orders[0]].sort(), [...orders[1]].sort());
});

test('domain discovery includes every enabled domain past API page boundaries and skips disabled domains', async t => {
  const names = Array.from({ length: 107 }, (_, i) => 'domain' + i + '.example'), c = await setup(t, names);
  await c.remote.api('/v2/domains/domain0.example/enabled', { method: 'POST', body: { enabled: false } });
  const providers = await c.service().providers(c.opts);
  assert.equal(providers.length, 106);
  assert.ok(c.remote.calls.some(call => call.path === '/v2/domains' && call.query.includes('after=')));
});

test('new and disabled domains reconcile with the saved deck without resetting used turns', async t => {
  const c = await setup(t), providers = await c.service().providers(c.opts);
  const first = (await providers[0].fn()).email.split('@')[1];
  await c.remote.api('/v2/domains/two.example/enabled', { method: 'POST', body: { enabled: false } });
  await c.remote.add(['new.example']);
  const remaining = [];
  for (let i = 0; i < 4; i++) remaining.push((await providers[i].fn()).email.split('@')[1]);
  assert.equal(new Set(remaining).size, 4);
  assert.ok(remaining.includes('new.example'));
  assert.ok(!remaining.includes(first));
  assert.ok(!remaining.includes('two.example'));
});

test('all saved connections participate and an unavailable Worker does not prevent working domains', async t => {
  const c = await setup(t, ['first.example']), other = await backend({ now: c.now });
  t.after(() => other.close()); await other.add(['second.example', 'disabled.example']);
  await other.api('/v2/domains/disabled.example/enabled', { method: 'POST', body: { enabled: false } });
  c.servers['https://other.fixture.workers.dev'] = other;
  c.inbox.save({ url: 'https://other.fixture.workers.dev', token: TOKEN });
  const providers = await c.service().providers(c.opts), emails = [];
  assert.equal(providers.length, 2);
  for (const provider of providers) emails.push((await provider.fn()).email.split('@')[1]);
  assert.deepEqual(emails.sort(), ['first.example', 'second.example']);
  c.remote.setFailure(true);
  const available = await c.service().providers(c.opts);
  assert.equal(available.length, 1);
  assert.ok((await available[0].fn()).email.endsWith('@second.example'));
});

test('concurrent address reservations do not duplicate a turn or alias', async t => {
  const c = await setup(t), providers = await c.service().providers(c.opts);
  const mailboxes = await Promise.all(providers.map(provider => provider.fn()));
  assert.equal(new Set(mailboxes.map(item => item.email.split('@')[1])).size, 5);
  assert.equal(new Set(mailboxes.map(item => item.email)).size, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.directory, 'mail-signup-rotation.json'))).remaining.length, 0);
});

test('background confirmation finds the exact recipient and caches mail without needing a UI refresh', async t => {
  const c = await setup(t), providers = await c.service().providers(c.opts);
  const mailbox = await providers[0].fn(), domain = mailbox.email.split('@')[1];
  const link = 'https://mega.nz/#confirmvalid_token';
  await c.remote.deliver(domain, { to: 'someone-else@' + domain, text: link });
  await c.remote.deliver(domain, { to: mailbox.email, subject: 'MEGA confirmation', html: '<a href="' + link + '">Confirm</a>' });
  // Cloud and computer clocks need not agree; a new message ID is authoritative.
  c.remote.sqlite.prepare('UPDATE messages SET received_at = ?').run(c.now() - 300000);
  assert.equal(await mailbox.pollForConfirmLink(), link);
  assert.equal(c.inbox.list({ recipient: mailbox.email }).messages.length, 1);
  assert.ok(c.remote.calls.some(call => call.path === '/v2/messages' && decodeURIComponent(call.query).includes(mailbox.email)));
});

test('confirmation waits for delivery in the background, times out, and cancels promptly', async t => {
  const c = await setup(t), link = 'https://mega.nz/confirmreal_token';
  let mailbox, waits = 0, cancel = false;
  const options = { shouldAbort: () => cancel, cancellableDelay: async ms => {
    await c.opts.cancellableDelay(ms);
    if (++waits === 2) await c.remote.deliver(mailbox.email.split('@')[1], { to: mailbox.email, text: link });
  } };
  const providers = await c.service().providers(options); mailbox = await providers[0].fn();
  assert.equal(await mailbox.pollForConfirmLink(), link);
  const timeout = await (await c.service({ timeoutMs: 3000 }).providers(c.opts))[0].fn();
  assert.equal(await timeout.pollForConfirmLink(), null);
  const cancelled = await providers[1].fn(); cancel = true;
  await assert.rejects(cancelled.pollForConfirmLink(), error => error.cancelled === true);
  await assert.rejects(providers[2].fn(), error => error.cancelled === true);
});

test('confirmation links reject unrelated hosts, credentials, redirects and empty tokens', () => {
  const invalid = ['https://mega.nz.evil.example/#confirmabc', 'https://evil.example/#confirmabc',
    'http://mega.nz/#confirmabc', 'https://user@mega.nz/#confirmabc', 'https://mega.nz:8443/#confirmabc',
    'https://mega.nz/#confirm', 'https://mega.nz/?redirect=evil#confirmabc', 'https://mega.nz/file/abc'];
  for (const link of invalid) assert.equal(confirmationLink({ links: [link] }), null, link);
  assert.equal(confirmationLink({ body: 'Confirm at https://mega.nz/#confirmabc_123' }), 'https://mega.nz/#confirmabc_123');
});

test('no enabled domains, unavailable credentials and corrupt rotation state fail clearly without resetting it', async t => {
  const c = await setup(t, []);
  await assert.rejects(c.service().providers(c.opts), /No enabled Cloudflare domains/);
  await c.remote.add(['one.example']);
  const providers = await c.service().providers(c.opts), filename = path.join(c.directory, 'mail-signup-rotation.json');
  fs.writeFileSync(filename, '{invalid');
  await assert.rejects(providers[0].fn(), /rotation could not be read/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{invalid');
  c.remote.setFailure(true);
  await assert.rejects(c.service().providers(c.opts), /Cloudflare signup mail is unavailable/);
});

function registrar({ source, service, tempProviders = [] }) {
  const recorded = [], tempCalls = [], calls = [];
  const filename = path.join(__dirname, 'account-creator.js'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths;
  const mocks = {
    './network-operations': { wrap: (_kind, fn) => fn, interruption: error => { if (error.vpnInterrupted) throw error; } },
    './config': { loadConfig: () => ({ signupEmailSource: source }) },
    '../binPath': { getBinPath: tool => tool },
    './megacmd': { ensureMegaCmdServer: async () => {}, megaSwitch: async () => {}, megaCmdBin: () => 'megacmd', megaSpawnOpts: () => ({}) },
    './account-manager': { appendAccountRow: (...args) => recorded.push(args) },
    './temp-mail': { shuffleProviders: () => { tempCalls.push(true); return tempProviders; } },
  };
  mod.require = id => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  if (service) mod.exports.installCloudflareSignupMail(service);
  const args = { createToolOrder: ['megatools', 'megacmd'], send: () => {}, shouldAbort: () => false,
    trackProc: () => {}, cancellableDelay: async () => {},
    execT: async (tool, argv) => { calls.push([tool, argv]); return argv[0] === 'reg' ? 'QUJD:REVG:R0hJ' : ''; },
    rwtT: async (_tool, argv) => { if (argv[0] === 'whoami') throw new Error('Not logged in'); return ''; } };
  return { register: () => mod.exports.registerMegaAccount(args), args, calls, recorded, tempCalls };
}

test('existing temp-mail registration retains passwords, display names, verification and logging', async () => {
  const c = registrar({ service: { providers: () => { throw new Error('Temp mail must not read Cloudflare state'); } },
    tempProviders: [{ name: 'Existing provider', fn: async () => ({ email: 'existing@example.org',
    pollForConfirmLink: async () => 'https://mega.nz/#confirmold' }) }] });
  const result = await c.register();
  assert.equal(result.email, 'existing@example.org'); assert.equal(result.registeredWith, 'megatools');
  assert.match(result.password, /^[a-f0-9]{16}A1$/);
  assert.deepEqual(c.calls[0][1], ['reg', '--register', '--email', result.email, '--name', 'User', '--password', result.password]);
  assert.deepEqual(c.calls[1][1], ['reg', '--verify', 'QUJD:REVG:R0hJ', 'https://mega.nz/#confirmold']);
  assert.deepEqual(c.recorded, [[result.email, result.password, 'No']]); assert.equal(c.tempCalls.length, 1);
});

test('Cloudflare signup rotates after failure, confirms via inbox and never calls temp providers', async t => {
  const c = await setup(t), registration = registrar({ source: 'cloudflare', service: c.service() });
  const attempts = [];
  registration.args.execT = async (_tool, argv) => {
    if (argv.includes('--register')) {
      const email = argv[argv.indexOf('--email') + 1]; attempts.push(email);
      if (attempts.length === 1) throw new Error('Registration rejected');
      await c.remote.deliver(email.split('@')[1], { to: email, subject: 'MEGA', text: 'https://mega.nz/#confirmnew_token' });
      return 'QUJD:REVG:R0hJ';
    }
    assert.equal(argv.at(-1), 'https://mega.nz/#confirmnew_token'); return '';
  };
  const result = await registration.register();
  assert.notEqual(attempts[0].split('@')[1], attempts[1].split('@')[1]);
  assert.equal(result.email, attempts[1]); assert.equal(registration.tempCalls.length, 0);
  assert.equal(registration.recorded.length, 1);
});

test('Cloudflare exhausts its finite tool fallbacks without temp mail or successful account logs', async t => {
  const c = await setup(t, ['only.example']), registration = registrar({ source: 'cloudflare', service: c.service() });
  const tools = [];
  registration.args.execT = async tool => { tools.push(tool); throw new Error('Registration rejected'); };
  await assert.rejects(registration.register(), /Account creation failed with all tools and providers/);
  assert.deepEqual(tools, ['megatools', 'megacmd']);
  assert.equal(registration.tempCalls.length, 0); assert.equal(registration.recorded.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.directory, 'mail-signup-rotation.json'))).serial, 10001);
});

test('MEGAcmd registration keeps its display name, password and security-upgrade log', async () => {
  const c = registrar({ source: 'cloudflare', service: { providers: async () => [{ name: 'Cloudflare domains', fn: async () => ({
    email: 'maple.river4821@example.com', pollForConfirmLink: async () => 'https://mega.nz/#confirmcmd',
  }) }] } });
  c.args.createToolOrder = ['megacmd'];
  const result = await c.register();
  assert.deepEqual(c.calls[0][1], ['signup', result.email, result.password, '--name=User Name']);
  assert.deepEqual(c.calls[1][1], ['confirm', 'https://mega.nz/#confirmcmd', result.email, result.password]);
  assert.deepEqual(c.recorded, [[result.email, result.password, 'Yes']]);
});
