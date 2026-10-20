// Inbox storage is independent of MEGA registration. All catch-all recipients
// are accepted; original attachments and active HTML are never served to M3.
const RETENTION_MS = 7 * 86400000;
const MAX_RAW = 1024 * 1024;
const MAX_BODY = 128 * 1024;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[code.toLowerCase()] || match;
  });
}
export function readableContent(parsed) {
  const html = String(parsed.html || '').slice(0, MAX_BODY * 2);
  const fallback = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
  let body = parsed.text || decodeEntities(fallback);
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY) + '\n[Message text truncated]';
  const candidates = [...html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map(m => decodeEntities(m[1] || m[2] || m[3] || ''));
  candidates.push(...(body.match(/https?:\/\/[^\s<>"']+/g) || []));
  const links = [];
  for (const candidate of candidates.slice(0, 200)) {
    try {
      const u = new URL(candidate);
      if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && u.href.length <= 8192 && !links.includes(u.href)) links.push(u.href);
    } catch { /* Non-web links are displayed only as plain text. */ }
    if (links.length === 30) break;
  }
  return { body: String(body), links };
}

async function authorized(request, token) {
  if (!tokenPattern.test(token || '')) return false;
  const incoming = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!tokenPattern.test(incoming)) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([token, incoming].map(t => crypto.subtle.digest('SHA-256', encoder.encode(t))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}


export function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!raw || /[\s/@:#?\\]/.test(raw)) throw new Error('Enter a domain name without an address or URL.');
  let domain;
  try { domain = new URL('https://' + raw).hostname; } catch { throw new Error('Invalid domain name.'); }
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Invalid domain name.');
  return domain;
}
const summaryColumns = 'id, domain_id AS domain, recipient, sender, subject, received_at, expires_at';
const domainColumns = 'name, enabled, created_at, last_received_at, last_test_received_at, test_recipient, test_requested_at';

export function createWorker({ parse = async raw => (await import('postal-mime')).default.parse(raw), now = Date.now } = {}) {
  const initialized = new WeakMap();
  async function initialize(env) {
    if (!initialized.has(env.MAIL_DB)) {
      const pending = (async () => {
        await env.MAIL_DB.prepare('INSERT OR IGNORE INTO mail_meta (key, value) VALUES (?, ?)')
          .bind('backend_id', crypto.randomUUID()).run();
        if (env.MAIL_DOMAIN) {
          const domain = normalizeDomain(env.MAIL_DOMAIN);
          await env.MAIL_DB.prepare('INSERT OR IGNORE INTO domains (name, created_at) VALUES (?, ?)').bind(domain, now()).run();
        }
        return (await env.MAIL_DB.prepare("SELECT value FROM mail_meta WHERE key = 'backend_id'").first()).value;
      })();
      initialized.set(env.MAIL_DB, pending);
      pending.catch(() => initialized.delete(env.MAIL_DB));
    }
    return initialized.get(env.MAIL_DB);
  }
  async function inputJson(request) {
    const reader = request.body?.getReader(); let size = 0, chunks = [];
    if (!reader) throw new Error('Missing request body.');
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('Request is too large; use batches of 10 domains.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return {
    async email(message, env) {
      await initialize(env);
      const original = String(message.to || '');
      let name;
      try { name = normalizeDomain(original.slice(original.lastIndexOf('@') + 1)); }
      catch { message.setReject('Unknown email domain'); return; }
      const domain = await env.MAIL_DB.prepare('SELECT * FROM domains WHERE name = ? AND enabled = 1').bind(name).first();
      if (!domain) { message.setReject('Unknown or disabled email domain'); return; }
      const recipient = original.slice(0, original.lastIndexOf('@') + 1) + name;
      let parsed;
      if (message.rawSize > MAX_RAW) {
        parsed = { subject: message.headers.get('subject') || '',
          text: '[Message exceeds the 1 MiB preview limit. Body and attachments were not stored.]' };
      } else {
        try { parsed = await parse(message.raw); }
        catch { parsed = { subject: message.headers.get('subject') || '', text: '[The message could not be parsed. Body and attachments were not stored.]' }; }
      }
      const { body, links } = readableContent(parsed);
      const attachments = (parsed.attachments || []).slice(0, 50).map(a => String(a.filename || 'Unnamed attachment').slice(0, 255));
      const timestamp = now(), delivery = crypto.randomUUID();
      await env.MAIL_DB.batch([
        env.MAIL_DB.prepare('INSERT INTO messages (domain_id, delivery_key, recipient, sender, subject, received_at, expires_at, body, links, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(name, delivery, recipient, String(message.from || '').slice(0, 320), String(parsed.subject || '(No subject)').slice(0, 1000),
            timestamp, timestamp + RETENTION_MS, body, JSON.stringify(links), JSON.stringify(attachments)),
        env.MAIL_DB.prepare("INSERT INTO mail_changes (kind, entity_id, changed_at) SELECT 'message', cast(id AS TEXT), ? FROM messages WHERE delivery_key = ?").bind(timestamp, delivery),
        env.MAIL_DB.prepare('UPDATE domains SET last_received_at = max(coalesce(last_received_at, 0), ?), last_test_received_at = CASE WHEN test_recipient = ? THEN max(coalesce(last_test_received_at, 0), ?) ELSE last_test_received_at END WHERE name = ?').bind(timestamp, recipient, timestamp, name),
        env.MAIL_DB.prepare("INSERT INTO mail_changes (kind, entity_id, changed_at) VALUES ('domain', ?, ?)").bind(name, timestamp),
      ]);
    },
    async fetch(request, env) {
      const url = new URL(request.url), legacy = url.pathname.startsWith('/v1/');
      const base = legacy ? { version: 1, domain: String(env.MAIL_DOMAIN || '').toLowerCase() } : { version: 2 };
      const json = (data, status = 200) => Response.json({ ...base, ...data }, {
        status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
      if (!await authorized(request, env.INBOX_TOKEN)) return json({ error: 'Unauthorized' }, 401);
      try {
        const backendId = await initialize(env), timestamp = now();
        if (request.method === 'GET' && ['/v2/health', '/v1/health'].includes(url.pathname)) {
          const head = await env.MAIL_DB.prepare('SELECT coalesce(max(seq), 0) AS head FROM mail_changes').first();
          const message = await env.MAIL_DB.prepare('SELECT coalesce(max(id), 0) AS head FROM messages').first();
          const floor = await env.MAIL_DB.prepare("SELECT value FROM mail_meta WHERE key = 'change_floor'").first();
          return json({ backendId, retentionDays: 7, changeHead: Math.max(head.head, Number(floor?.value || 0)), messageHead: message.head,
            changeFloor: Number(floor?.value || 0), snapshotAt: timestamp });
        }
        if (url.pathname === '/v2/domains' && request.method === 'POST') {
          const input = await inputJson(request);
          if (!Array.isArray(input.names) || input.names.length > 10) return json({ error: 'Submit at most 10 domain names per batch.' }, 400);
          const results = [];
          for (const raw of input.names) {
            let name;
            try { name = normalizeDomain(raw); } catch (error) { results.push({ input: String(raw).slice(0, 254), status: 'invalid', error: error.message }); continue; }
            const existing = await env.MAIL_DB.prepare('SELECT name FROM domains WHERE name = ?').bind(name).first();
            if (existing) { results.push({ name, status: 'duplicate' }); continue; }
            await env.MAIL_DB.batch([
              env.MAIL_DB.prepare('INSERT OR IGNORE INTO domains (name, created_at) VALUES (?, ?)').bind(name, timestamp),
              env.MAIL_DB.prepare("INSERT INTO mail_changes (kind, entity_id, changed_at) VALUES ('domain', ?, ?)").bind(name, timestamp),
            ]);
            results.push({ name, status: 'added' });
          }
          return json({ results });
        }
        if (url.pathname === '/v2/domains' && request.method === 'GET') {
          const after = (url.searchParams.get('after') || '').slice(0, 253), q = (url.searchParams.get('q') || '').slice(0, 253).toLowerCase();
          const { results } = await env.MAIL_DB.prepare('SELECT ' + domainColumns + ' FROM domains WHERE name > ? AND instr(name, ?) > 0 ORDER BY name LIMIT 101')
            .bind(after, q).all();
          return json({ domains: results.slice(0, 100), nextCursor: results.length > 100 ? results[99].name : null });
        }
        const domainAction = url.pathname.match(/^\/v2\/domains\/([^/]+)\/(test|enabled)$/);
        if (domainAction && request.method === 'POST') {
          const name = normalizeDomain(decodeURIComponent(domainAction[1]));
          const domain = await env.MAIL_DB.prepare('SELECT * FROM domains WHERE name = ?').bind(name).first();
          if (!domain) return json({ error: 'Domain not found.' }, 404);
          let statement, recipient;
          if (domainAction[2] === 'test') {
            if (!domain.enabled) return json({ error: 'Enable receiving for this domain first.' }, 409);
            recipient = 'm3-test-' + crypto.randomUUID().replaceAll('-', '') + '@' + name;
            statement = env.MAIL_DB.prepare('UPDATE domains SET test_recipient = ?, test_requested_at = ? WHERE name = ?').bind(recipient, timestamp, name);
          } else {
            const input = await inputJson(request);
            if (typeof input.enabled !== 'boolean') return json({ error: 'Specify whether receiving is enabled.' }, 400);
            statement = env.MAIL_DB.prepare('UPDATE domains SET enabled = ? WHERE name = ?').bind(input.enabled ? 1 : 0, name);
          }
          await env.MAIL_DB.batch([statement, env.MAIL_DB.prepare("INSERT INTO mail_changes (kind, entity_id, changed_at) VALUES ('domain', ?, ?)").bind(name, timestamp)]);
          return json({ recipient });
        }
        if (url.pathname === '/v2/changes' && request.method === 'GET') {
          const after = url.searchParams.get('after') || '0', through = url.searchParams.get('through');
          if (!/^\d{1,16}$/.test(after) || (through && !/^\d{1,16}$/.test(through))) return json({ error: 'Invalid sync cursor.' }, 400);
          const floor = Number((await env.MAIL_DB.prepare("SELECT value FROM mail_meta WHERE key = 'change_floor'").first())?.value || 0);
          if (Number(after) < floor) return json({ resetRequired: true });
          const { results } = await env.MAIL_DB.prepare('SELECT seq, kind, entity_id FROM mail_changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 201')
            .bind(after, through || Number.MAX_SAFE_INTEGER).all();
          const events = results.slice(0, 200), messages = [], domains = [], removed = [];
          const ids = [...new Set(events.filter(e => e.kind === 'message').map(e => e.entity_id))];
          const names = [...new Set(events.filter(e => e.kind === 'domain').map(e => e.entity_id))];
          // Chunk below D1's 100-bound-parameter limit; number of queries remains bounded.
          for (let i = 0; i < ids.length; i += 80) {
            const part = ids.slice(i, i + 80);
            const rows = await env.MAIL_DB.prepare('SELECT ' + summaryColumns + ' FROM messages WHERE expires_at > ? AND id IN (' + part.map(() => '?').join(',') + ')').bind(timestamp, ...part).all();
            messages.push(...rows.results);
          }
          for (let i = 0; i < names.length; i += 80) {
            const part = names.slice(i, i + 80);
            const rows = await env.MAIL_DB.prepare('SELECT ' + domainColumns + ' FROM domains WHERE name IN (' + part.map(() => '?').join(',') + ')').bind(...part).all();
            domains.push(...rows.results);
          }
          const found = new Set(messages.map(m => String(m.id)));
          for (const id of ids) if (!found.has(id)) removed.push(id);
          return json({ messages, domains, removed, cursor: events.at(-1)?.seq ?? Number(after), hasMore: results.length > 200 });
        }
        if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
        if (url.pathname === '/v2/snapshot') {
          const after = url.searchParams.get('after') || '0', through = url.searchParams.get('through') || '0';
          if (![after, through].every(v => /^\d{1,16}$/.test(v))) return json({ error: 'Invalid snapshot cursor.' }, 400);
          const { results } = await env.MAIL_DB.prepare('SELECT ' + summaryColumns + ' FROM messages WHERE expires_at > ? AND id > ? AND id <= ? ORDER BY id LIMIT 201')
            .bind(timestamp, after, through).all();
          return json({ messages: results.slice(0, 200), nextCursor: results.length > 200 ? String(results[199].id) : null });
        }
        if (['/v2/messages', '/v1/messages'].includes(url.pathname)) {
          const where = ['expires_at > ?'], values = [timestamp];
          if (legacy) { where.push('domain_id = ?'); values.push(base.domain); }
          const before = url.searchParams.get('before');
          if (before && !/^\d{1,16}$/.test(before)) return json({ error: 'Invalid cursor.' }, 400);
          if (before) { where.push('id < ?'); values.push(before); }
          const domain = url.searchParams.get('domain');
          if (domain) { where.push('domain_id = ?'); values.push(normalizeDomain(domain)); }
          const recipient = (url.searchParams.get('recipient') || '').trim().slice(0, 254);
          if (recipient) { where.push('lower(recipient) = ?'); values.push(recipient.toLowerCase()); }
          const q = (url.searchParams.get('q') || '').trim().slice(0, 100).toLowerCase();
          if (q) { where.push('(instr(lower(subject), ?) > 0 OR instr(lower(sender), ?) > 0 OR instr(lower(recipient), ?) > 0)'); values.push(q, q, q); }
          const { results } = await env.MAIL_DB.prepare('SELECT ' + summaryColumns + ' FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT 41').bind(...values).all();
          return json({ messages: results.slice(0, 40), nextCursor: results.length > 40 ? String(results[39].id) : null, retentionDays: 7 });
        }
        const match = url.pathname.match(/^\/v[12]\/messages\/(\d{1,16})$/);
        if (match) {
          const item = await env.MAIL_DB.prepare('SELECT *, domain_id AS domain FROM messages WHERE id = ? AND expires_at > ?' + (legacy ? ' AND domain_id = ?' : ''))
            .bind(match[1], timestamp, ...(legacy ? [base.domain] : [])).first();
          if (!item) return json({ error: 'Message expired or not found.' }, 404);
          return json({ message: { ...item, links: JSON.parse(item.links), attachments: JSON.parse(item.attachments) } });
        }
        return json({ error: 'Not found.' }, 404);
      } catch (error) {
        if (error instanceof SyntaxError || /Invalid domain|Enter a domain|too large|Missing request/.test(error.message)) return json({ error: error.message }, 400);
        // D1 details and message content must not leak through HTTP errors.
        return json({ error: 'Mail database unavailable. Check the Worker migrations and Cloudflare quota.' }, 503);
      }
    },
    async scheduled(_event, env) {
      await initialize(env);
      const cutoff = now() - RETENTION_MS;
      await env.MAIL_DB.batch([
        env.MAIL_DB.prepare('DELETE FROM messages WHERE expires_at <= ?').bind(now()),
        env.MAIL_DB.prepare("INSERT OR REPLACE INTO mail_meta (key, value) SELECT 'change_floor', cast(max(seq) AS TEXT) FROM mail_changes WHERE changed_at <= ? HAVING max(seq) IS NOT NULL").bind(cutoff),
        env.MAIL_DB.prepare('DELETE FROM mail_changes WHERE changed_at <= ?').bind(cutoff),
      ]);
    },
  };
}
export default createWorker();
