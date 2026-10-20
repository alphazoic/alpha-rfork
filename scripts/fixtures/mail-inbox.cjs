'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../..');
const TOKEN = 'mail-fixture-secret-'.repeat(3);
function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql); let args = [];
      const command = { bind(...values) { args = values; return command; },
        _run() { return statement.run(...args); },
        async run() { return command._run(); }, async all() { return { results: statement.all(...args) }; },
        async first() { return statement.get(...args) || null; } };
      return command;
    },
    async batch(commands) {
      sqlite.exec('BEGIN');
      try { const values = commands.map(command => command._run()); sqlite.exec('COMMIT'); return values; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
async function backend({ domain = '', legacy = false, now = Date.now, seedLegacy = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = path.join(root, 'cloudflare/mail-worker/migrations');
  sqlite.exec(fs.readFileSync(path.join(migrations, '0001_inbox.sql'), 'utf8'));
  if (seedLegacy) sqlite.prepare('INSERT INTO messages (recipient,sender,subject,received_at,expires_at,body,links,attachments) VALUES (?,?,?,?,?,?,?,?)')
    .run('old@' + domain, 'legacy@example.org', 'Existing mail', now(), now() + 7 * 86400000, 'Existing body', '[]', '[]');
  sqlite.exec(fs.readFileSync(path.join(migrations, '0002_multiple_domains.sql'), 'utf8'));
  const { createWorker } = await import(path.join(root, 'cloudflare/mail-worker/worker.mjs'));
  const worker = createWorker({ now }), env = { MAIL_DB: d1(sqlite), MAIL_DOMAIN: domain, INBOX_TOKEN: TOKEN };
  let failure = false; const calls = [];
  async function fetch(raw, options = {}) {
    const request = raw instanceof Request ? raw : new Request(raw, options);
    const url = new URL(request.url); calls.push({ path: url.pathname, query: url.search, method: request.method });
    if (failure) return new Response('', { status: 503 });
    if (legacy && url.pathname.startsWith('/v2/')) return new Response('', { status: 404 });
    return worker.fetch(request, env);
  }
  async function api(route, { method = 'GET', body, token = TOKEN } = {}) {
    const response = await fetch('https://fixture.example.workers.dev' + route, { method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function add(names) {
    const results = [];
    for (let i = 0; i < names.length; i += 10) results.push(...(await api('/v2/domains', { method: 'POST', body: { names: names.slice(i, i + 10) } })).data.results);
    return results;
  }
  async function deliver(name, { subject = 'Hello', text = 'Message body', to = 'hello@' + name, html } = {}) {
    const raw = 'From: sender@example.org\r\nTo: ' + to + '\r\nSubject: ' + subject +
      '\r\nMIME-Version: 1.0\r\nContent-Type: text/' + (html ? 'html' : 'plain') + '; charset=utf-8\r\n\r\n' + (html || text);
    let rejected = null;
    await worker.email({ to, from: 'sender@example.org', rawSize: Buffer.byteLength(raw), raw: new Blob([raw]).stream(),
      headers: new Headers({ subject }), setReject(reason) { rejected = reason; } }, env);
    return rejected;
  }
  return { sqlite, worker, env, api, add, deliver, fetch, calls, setFailure(value) { failure = value; }, close() { sqlite.close(); } };
}
module.exports = { backend, TOKEN, d1 };
