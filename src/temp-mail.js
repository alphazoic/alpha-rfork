'use strict';

const network = require('./network-operations');

const crypto = require('crypto');

// Plain (non-kill-flag-aware) delay — temp-mail.js is shared across engines
// that each have their own kill flag, so it can't check any one of them here.
function cancellableDelay(ms) {
  return network.delay(ms);
}

async function fetchJson(url) {
  const response = await network.fetchNetwork(url);
  return response.json();
}

async function providerGuerrillaMail() {
  const mailData = await fetchJson('https://api.guerrillamail.com/ajax.php?f=get_email_address');
  const email    = mailData.email_addr;
  const sid      = mailData.sid_token;
  async function pollForConfirmLink() {
    for (let i = 0; i < 5; i++) {
      await cancellableDelay(10000);
      const inbox = await fetchJson(`https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${sid}`);
      const msg   = (inbox.list || []).find(m => m.mail_subject.includes('MEGA'));
      if (msg) {
        const body  = await fetchJson(`https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${msg.mail_id}&sid_token=${sid}`);
        const match = body.mail_body.match(/https:\/\/mega\.nz\/#confirm[^" <]*/);
        if (match) return match[0].replace(/&amp;/g, '&');
      }
    }
    return null;
  }
  return { email, pollForConfirmLink };
}

async function providerMailTm() {
  const domains = await fetchJson('https://api.mail.tm/domains?page=1');
  const domain  = (domains['hydra:member'] || [])[0]?.domain;
  if (!domain) throw new Error('mail.tm: no domains available');
  const alias  = crypto.randomBytes(8).toString('hex');
  const email  = `${alias}@${domain}`;
  const tmPass = crypto.randomBytes(12).toString('base64url');
  const createResp = await network.fetchNetwork('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: email, password: tmPass }),
  });
  if (!createResp.ok) throw new Error(`mail.tm: account creation failed (${createResp.status})`);
  const tokenResp = await network.fetchNetwork('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: email, password: tmPass }),
  });
  if (!tokenResp.ok) throw new Error(`mail.tm: token fetch failed (${tokenResp.status})`);
  const { token } = await tokenResp.json();
  async function pollForConfirmLink() {
    for (let i = 0; i < 5; i++) {
      await cancellableDelay(10000);
      const msgsResp = await network.fetchNetwork('https://api.mail.tm/messages', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!msgsResp.ok) continue;
      const msgs = await msgsResp.json();
      const msg  = (msgs['hydra:member'] || []).find(m => m.subject && m.subject.includes('MEGA'));
      if (msg) {
        const detailResp = await network.fetchNetwork(`https://api.mail.tm/messages/${msg.id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!detailResp.ok) continue;
        const detail = await detailResp.json();
        const src    = detail.html?.[0] || detail.text || '';
        const match  = src.match(/https:\/\/mega\.nz\/#confirm[^" <]*/);
        if (match) return match[0].replace(/&amp;/g, '&');
      }
    }
    return null;
  }
  return { email, pollForConfirmLink };
}

async function providerMaildrop() {
  const alias = crypto.randomBytes(8).toString('hex');
  const email = `${alias}@maildrop.cc`;
  async function gql(query) {
    const resp = await network.fetchNetwork('https://api.maildrop.cc/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) throw new Error(`Maildrop GraphQL error (${resp.status})`);
    return resp.json();
  }
  async function pollForConfirmLink() {
    for (let i = 0; i < 5; i++) {
      await cancellableDelay(10000);
      const inboxData = await gql(`{ inbox(mailbox: "${alias}") { id subject } }`);
      const msgs = inboxData?.data?.inbox || [];
      const msg  = msgs.find(m => m.subject && m.subject.includes('MEGA'));
      if (msg) {
        const msgData = await gql(`{ message(mailbox: "${alias}", id: "${msg.id}") { html data } }`);
        const detail  = msgData?.data?.message;
        const src     = detail?.html || detail?.data || '';
        const match   = src.match(/https:\/\/mega\.nz\/#confirm[^" <]*/);
        if (match) return match[0].replace(/&amp;/g, '&');
      }
    }
    return null;
  }
  return { email, pollForConfirmLink };
}

async function providerTempMailLol() {
  async function tmlFetch(url) {
    const resp = await network.fetchNetwork(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                             'Accept': 'application/json',
      },
    });
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`tempmail.lol returned non-JSON: ${text.slice(0, 120)}`); }
  }
  const genData = await tmlFetch('https://api.tempmail.lol/generate');
  const email   = genData.address;
  const token   = genData.token;
  async function pollForConfirmLink() {
    for (let i = 0; i < 5; i++) {
      await cancellableDelay(10000);
      const data = await tmlFetch(`https://api.tempmail.lol/auth/${token}`);
      const msgs = data.email || [];
      const msg  = msgs.find(m => m.subject && m.subject.includes('MEGA'));
      if (msg) {
        const src   = msg.body || '';
        const match = src.match(/https:\/\/mega\.nz\/#confirm[^" <]*/);
        if (match) return match[0].replace(/&amp;/g, '&');
      }
    }
    return null;
  }
  return { email, pollForConfirmLink };
}

// Shuffle providers randomly so no single service is overused
function shuffleProviders() {
  const providers = [
    { name: 'GuerrillaMail', fn: providerGuerrillaMail },
    { name: 'Mail.tm',       fn: providerMailTm        },
    { name: 'Maildrop',      fn: providerMaildrop      },
    { name: 'tempmail.lol',  fn: providerTempMailLol   },
  ];
  for (let i = providers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [providers[i], providers[j]] = [providers[j], providers[i]];
  }
  return providers;
}

module.exports = {
  providerGuerrillaMail,
  providerMailTm,
  providerMaildrop,
  providerTempMailLol,
  shuffleProviders,
};
