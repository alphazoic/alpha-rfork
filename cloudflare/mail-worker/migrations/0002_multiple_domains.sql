CREATE TABLE domains (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_received_at INTEGER,
  last_test_received_at INTEGER,
  test_recipient TEXT,
  test_requested_at INTEGER
);
ALTER TABLE messages ADD COLUMN domain_id TEXT;
ALTER TABLE messages ADD COLUMN delivery_key TEXT;
UPDATE messages SET domain_id = lower(substr(recipient, instr(recipient, '@') + 1));
INSERT OR IGNORE INTO domains (name, created_at, last_received_at)
  SELECT domain_id, min(received_at), max(received_at) FROM messages GROUP BY domain_id;
CREATE INDEX messages_domain_id ON messages(domain_id, id DESC);
CREATE UNIQUE INDEX messages_delivery_key ON messages(delivery_key);
CREATE TABLE mail_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE mail_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX mail_changes_expiry ON mail_changes(changed_at);
