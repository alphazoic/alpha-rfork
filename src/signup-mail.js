'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');

const WORDS = ['amber', 'aspen', 'birch', 'brook', 'cedar', 'clover', 'coral', 'dawn',
  'elm', 'fern', 'finch', 'forest', 'grove', 'hazel', 'ivy', 'jade', 'lake', 'lark',
  'laurel', 'linden', 'maple', 'meadow', 'olive', 'pearl', 'pine', 'reed', 'river',
  'robin', 'rowan', 'sage', 'silver', 'willow'];

function signupEmailSource(value) {
  if (value === undefined || value === 'temp-mail') return 'temp-mail';
  if (value === 'cloudflare') return value;
  throw new Error('Choose Temp mail or Cloudflare domains for signup email.');
}

function checkCancelled(shouldAbort) {
  if (shouldAbort()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
}

function confirmationLink(message) {
  const candidates = [...(Array.isArray(message.links) ? message.links : []),
    ...(String(message.body || '').match(/https:\/\/[^\s<>"']+/g) || [])];
  for (const raw of candidates) {
    try {
      const url = new URL(String(raw).replace(/&amp;/g, '&'));
      if (url.protocol !== 'https:' || !['mega.nz', 'www.mega.nz'].includes(url.hostname) ||
          url.username || url.password || url.port || url.search) continue;
      if ((url.pathname === '/' && /^#confirm[A-Za-z0-9_+=/-]+$/.test(url.hash)) ||
          (!url.hash && /^\/confirm[A-Za-z0-9_+=/-]+$/.test(url.pathname))) return url.href;
    } catch { /* Ignore malformed and unrelated links. */ }
  }
  return null;
}

// This state is separate from settings: saving a stale Settings draft must not
// rewind a deck that a background signup has already consumed.
function createCloudflareSignupMail({ inbox, directory, now = Date.now, pick = randomInt,
  timeoutMs = 120000, pollMs = 5000 }) {
  function shuffled(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = pick(i + 1); [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function draw(domains) {
    const filename = path.join(directory(), 'mail-signup-rotation.json');
    let saved;
    try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cloudflare domain rotation could not be read. Its saved state was left unchanged.');
      saved = { version: 1, pool: [], remaining: [], serial: pick(9000) + 1000 };
    }
    if (saved.version !== 1 || !Array.isArray(saved.pool) || !Array.isArray(saved.remaining) ||
        ![...saved.pool, ...saved.remaining].every(key => typeof key === 'string') ||
        !Number.isSafeInteger(saved.serial) || saved.serial < 0 || saved.serial >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Cloudflare domain rotation is invalid. Its saved state was left unchanged.');
    }
    const key = item => JSON.stringify([item.connectionId, item.domain]);
    const pool = [...new Set(domains.map(key))], eligible = new Set(pool), old = new Set(saved.pool);
    let remaining = [...new Set(saved.remaining)].filter(item => eligible.has(item));
    // Insert newly enabled domains into this cycle without repeating used cards.
    remaining.push(...shuffled(pool.filter(item => !old.has(item))));
    if (!remaining.length) remaining = shuffled(pool);
    const chosen = remaining.shift();
    if (!chosen) throw new Error('No enabled Cloudflare domains are available. Add and enable domains in Inbox first.');
    const serial = saved.serial + 1;
    const alias = WORDS[pick(WORDS.length)] + '.' + WORDS[pick(WORDS.length)] + String(serial);
    const next = { version: 1, pool, remaining, serial };
    fs.mkdirSync(directory(), { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, filename);
    } finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ } }
    return { ...domains.find(item => key(item) === chosen), alias };
  }
  async function providers({ shouldAbort, cancellableDelay }) {
    const check = () => checkCancelled(shouldAbort);
    check();
    const initial = await inbox.signupDomains({ check });
    check();
    if (!initial.length) throw new Error('No enabled Cloudflare domains are available. Connect a mail Worker and enable domains in Inbox first.');
    // Match the existing finite provider/tool fallback loop. Each attempt draws
    // a fresh card, including failed registrations, and never selects temp mail.
    return Array.from({ length: initial.length }, () => ({ name: 'Cloudflare domains', async fn() {
      check();
      const available = await inbox.signupDomains({ check });
      check();
      const selected = draw(available), email = selected.alias + '@' + selected.domain;
      return { email, async pollForConfirmLink() {
        const deadline = now() + timeoutMs;
        do {
          check();
          const messages = await inbox.signupMessages({ connectionId: selected.connectionId, recipient: email,
            afterId: selected.messageHead, check });
          check();
          for (const message of messages) {
            if (String(message.recipient).toLowerCase() !== email || message.id <= selected.messageHead) continue;
            const link = confirmationLink(message);
            if (link) return link;
          }
          const until = Math.min(deadline, now() + pollMs);
          // Respect the engine's cancel flag even during a confirmation wait.
          while (now() < until) { check(); await cancellableDelay(Math.min(1000, until - now())); }
        } while (now() < deadline);
        check(); return null;
      } };
    } }));
  }
  return { providers };
}

module.exports = { createCloudflareSignupMail, signupEmailSource, confirmationLink };
