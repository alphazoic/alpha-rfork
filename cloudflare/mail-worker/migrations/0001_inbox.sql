CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL,
  attachments TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_recipient_id ON messages(recipient, id DESC);
CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at);
