'use strict';

// This cache holds headers and sync checkpoints, never access tokens or bodies.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createInboxStore(directory, now = Date.now) {
  let db;
  function database() {
    if (db) return db;
    fs.mkdirSync(directory(), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(directory(), 'mail-inbox-cache.sqlite'));
    db.exec([
      'PRAGMA journal_mode = WAL;',
      'CREATE TABLE IF NOT EXISTS inbox_domains (connection_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER, last_received_at INTEGER, last_test_received_at INTEGER, test_recipient TEXT, test_requested_at INTEGER, generation TEXT, PRIMARY KEY(connection_id, name));',
      'CREATE INDEX IF NOT EXISTS inbox_domains_name ON inbox_domains(name, connection_id);',
      'CREATE TABLE IF NOT EXISTS inbox_messages (connection_id TEXT NOT NULL, id INTEGER NOT NULL, domain TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL, subject TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, generation TEXT, PRIMARY KEY(connection_id, id));',
      'CREATE INDEX IF NOT EXISTS inbox_messages_order ON inbox_messages(received_at DESC, connection_id, id DESC);',
      'CREATE INDEX IF NOT EXISTS inbox_messages_domain ON inbox_messages(connection_id, domain, received_at DESC, id DESC);',
      'CREATE INDEX IF NOT EXISTS inbox_messages_expiry ON inbox_messages(expires_at);',
      "CREATE TABLE IF NOT EXISTS inbox_sync (connection_id TEXT PRIMARY KEY, backend_id TEXT, version INTEGER, cursor INTEGER DEFAULT 0, snapshot_head INTEGER, message_head INTEGER DEFAULT 0, phase TEXT, domain_after TEXT DEFAULT '', message_after INTEGER DEFAULT 0, generation TEXT, legacy_before TEXT, pending INTEGER DEFAULT 0, last_sync INTEGER, error TEXT, failures INTEGER DEFAULT 0, next_retry INTEGER DEFAULT 0);",
    ].join('\n'));
    return db;
  }
  function transaction(fn) {
    const d = database(); d.exec('BEGIN');
    try { const result = fn(); d.exec('COMMIT'); return result; }
    catch (error) { d.exec('ROLLBACK'); throw error; }
  }
  function sync(id) {
    const d = database();
    d.prepare('INSERT OR IGNORE INTO inbox_sync (connection_id) VALUES (?)').run(id);
    return d.prepare('SELECT * FROM inbox_sync WHERE connection_id = ?').get(id);
  }
  const syncFields = new Set(['backend_id', 'version', 'cursor', 'snapshot_head', 'message_head', 'phase', 'domain_after',
    'message_after', 'generation', 'legacy_before', 'pending', 'last_sync', 'error', 'failures', 'next_retry']);
  function patch(id, values) {
    sync(id);
    const keys = Object.keys(values);
    if (keys.some(key => !syncFields.has(key))) throw new Error('Invalid inbox sync field.');
    if (keys.length) database().prepare('UPDATE inbox_sync SET ' + keys.map(key => key + ' = ?').join(',') + ' WHERE connection_id = ?')
      .run(...keys.map(key => values[key] ?? null), id);
  }
  function apply(id, data, changes = {}) {
    return transaction(() => {
      const generation = changes.generation || sync(id).generation || 'live';
      for (const item of data.domains || []) {
        database().prepare('INSERT INTO inbox_domains (connection_id,name,enabled,created_at,last_received_at,last_test_received_at,test_recipient,test_requested_at,generation) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,name) DO UPDATE SET enabled=excluded.enabled, created_at=excluded.created_at,last_received_at=excluded.last_received_at,last_test_received_at=excluded.last_test_received_at, test_recipient=excluded.test_recipient,test_requested_at=excluded.test_requested_at,generation=excluded.generation')
          .run(id, item.name, item.enabled ? 1 : 0, item.created_at ?? null, item.last_received_at ?? null,
            item.last_test_received_at ?? null, item.test_recipient ?? null, item.test_requested_at ?? null, generation);
      }
      for (const item of data.messages || []) {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || !Number.isFinite(item.received_at)) throw new Error('Invalid message metadata from Worker.');
        database().prepare('INSERT INTO inbox_messages (connection_id,id,domain,recipient,sender,subject,received_at,expires_at,generation) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,id) DO UPDATE SET domain=excluded.domain, recipient=excluded.recipient,sender=excluded.sender,subject=excluded.subject,received_at=excluded.received_at, expires_at=excluded.expires_at,generation=excluded.generation')
          .run(id, item.id, item.domain || item.recipient.slice(item.recipient.lastIndexOf('@') + 1).toLowerCase(),
            item.recipient, item.sender, item.subject, item.received_at, item.expires_at ?? item.received_at + 7 * 86400000, generation);
      }
      for (const removed of data.removed || []) database().prepare('DELETE FROM inbox_messages WHERE connection_id = ? AND id = ?').run(id, removed);
      database().prepare('DELETE FROM inbox_messages WHERE expires_at <= ?').run(now());
      patch(id, changes);
    });
  }
  function beginSnapshot(id, health) {
    patch(id, { backend_id: health.backendId, version: 2, snapshot_head: health.changeHead, message_head: health.messageHead,
      phase: 'domains', domain_after: '', message_after: 0, generation: randomUUID(), pending: 1 });
  }
  function finishSnapshot(id) {
    const state = sync(id);
    transaction(() => {
      for (const table of ['inbox_messages', 'inbox_domains']) database().prepare('DELETE FROM ' + table + ' WHERE connection_id = ? AND generation != ?').run(id, state.generation);
      patch(id, { cursor: state.snapshot_head, snapshot_head: null, phase: null });
    });
  }
  function remove(id) {
    transaction(() => {
      for (const table of ['inbox_messages', 'inbox_domains', 'inbox_sync']) database().prepare('DELETE FROM ' + table + ' WHERE connection_id = ?').run(id);
    });
  }
  function domainList({ connectionId, name, q = '', after, limit = 60 } = {}) {
    const where = ['instr(name, ?) > 0'], values = [q.toLowerCase().slice(0, 253)];
    if (connectionId) { where.push('connection_id = ?'); values.push(connectionId); }
    if (name) { where.push('name = ?'); values.push(name); }
    if (after) { where.push('(name > ? OR (name = ? AND connection_id > ?))'); values.push(after.name, after.name, after.connectionId); }
    const items = database().prepare('SELECT * FROM inbox_domains WHERE ' + where.join(' AND ') + ' ORDER BY name, connection_id LIMIT ?').all(...values, limit + 1);
    const domains = items.slice(0, limit), last = domains.at(-1);
    return { domains, nextCursor: items.length > limit ? { name: last.name, connectionId: last.connection_id } : null };
  }
  function list({ connectionId, domain, recipient = '', q = '', before, limit = 40 } = {}) {
    const where = ['expires_at > ?'], values = [now()];
    if (connectionId) { where.push('connection_id = ?'); values.push(connectionId); }
    if (domain) { where.push('domain = ?'); values.push(domain); }
    if (recipient.trim()) { where.push('lower(recipient) = ?'); values.push(recipient.trim().toLowerCase().slice(0, 254)); }
    if (q.trim()) {
      where.push('(instr(lower(subject), ?) > 0 OR instr(lower(sender), ?) > 0 OR instr(lower(recipient), ?) > 0)');
      const term = q.trim().toLowerCase().slice(0, 100); values.push(term, term, term);
    }
    if (before) {
      where.push('(received_at < ? OR (received_at = ? AND connection_id > ?) OR (received_at = ? AND connection_id = ? AND id < ?))');
      values.push(before.receivedAt, before.receivedAt, before.connectionId, before.receivedAt, before.connectionId, before.id);
    }
    const items = database().prepare('SELECT * FROM inbox_messages WHERE ' + where.join(' AND ') +
      ' ORDER BY received_at DESC, connection_id, id DESC LIMIT ?').all(...values, limit + 1);
    const messages = items.slice(0, limit), last = messages.at(-1);
    return { messages, nextCursor: items.length > limit ? { receivedAt: last.received_at, connectionId: last.connection_id, id: last.id } : null };
  }
  function domainCount(id) { return database().prepare('SELECT count(*) AS n FROM inbox_domains WHERE connection_id = ?').get(id).n; }
  function knownMessage(id, messageId) { return Boolean(database().prepare('SELECT id FROM inbox_messages WHERE connection_id = ? AND id = ?').get(id, messageId)); }
  return { sync, patch, apply, beginSnapshot, finishSnapshot, remove, list, domainList, domainCount, knownMessage,
    dispose() { db?.close(); db = undefined; } };
}
module.exports = { createInboxStore };
