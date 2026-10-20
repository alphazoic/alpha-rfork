'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function uploadUncertain(record) {
  const detail = record ? ` Account: ${record.account}; destination: /${record.destination}; local file: ${record.source}.` : '';
  const error = new Error('Upload completion is uncertain. Queue stopped; check the current file on the same MEGA account before retrying.' + detail);
  error.code = 'UPLOAD_UNCERTAIN';
  error.uploadUncertain = true;
  error.vpnInterrupted = true; // Existing catch boundaries must propagate this hold.
  return error;
}

function createUploadJournal(directory) {
  if (!directory) throw new Error('No upload data folder configured');
  const filename = path.join(directory, 'upload-recovery.json');
  function read() {
    let data;
    try { data = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; const held = uploadUncertain(); held.message = 'Upload recovery record cannot be read. Restore it before retrying uploads.'; throw held; }
    if (![1, 2].includes(data.schemaVersion) || !Array.isArray(data.entries) || data.entries.some(entry =>
      !entry.id || typeof entry.account !== 'string' || typeof entry.destination !== 'string' || typeof entry.source !== 'string' ||
      !['in-flight', 'committed', 'uncertain'].includes(entry.state) ||
      (entry.checkpoint !== undefined && (typeof entry.checkpoint !== 'string' || !path.isAbsolute(entry.checkpoint) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)))) throw uploadUncertain();
    return data.entries;
  }
  function write(entries) {
    const temporary = filename + '.tmp';
    try {
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 2, entries }, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
      if (process.platform !== 'win32') { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    } catch { throw uploadUncertain(entries[0]); }
  }
  function update(id, state, metadata = {}) {
    const entries = read(), entry = entries.find(item => item.id === id);
    if (!entry) throw uploadUncertain();
    for (const key of ['node', 'completionRow', 'completionOffset']) if (metadata[key] !== undefined) entry[key] = metadata[key];
    entry.state = state; write(entries);
  }
  return {
    read,
    assertClear() { const held = read()[0]; if (held) throw uploadUncertain(held); },
    begin({ account, destination, source, bytes, checkpoint, folderLink }) {
      const entries = read();
      const held = entries.find(item => item.account === account && item.destination === destination);
      if (held) throw uploadUncertain(held);
      const entry = { id: randomUUID(), account, destination, source, bytes, state: 'in-flight', ...(checkpoint ? { checkpoint, folderLink: folderLink || '' } : {}), startedAt: new Date().toISOString() };
      write([...entries, entry]); return entry;
    },
    update,
    clear(id) { const entries = read(); write(entries.filter(item => item.id !== id)); },
    acknowledge(ids) {
      const entries = read();
      if (entries.length !== ids.length || entries.some(item => !ids.includes(item.id))) throw uploadUncertain();
      if (entries.some(item => item.checkpoint)) throw new Error('Resume checkpoints must be resolved individually; use Resume or inspect and discard.');
      write([]);
    },
  };
}

function recordUploadCompletion(journal, record, filename, row) {
  const current = journal.read().find(item => item.id === record.id);
  if (!current || current.state !== 'committed') throw uploadUncertain(record);
  const exact = current.completionRow || row;
  const offset = current.completionOffset ?? fs.statSync(filename).size;
  if (typeof exact !== 'string' || !Number.isSafeInteger(offset) || offset < 0) throw uploadUncertain(record);
  const payload = Buffer.from(exact + '\n');
  journal.update(record.id, 'committed', { completionRow: exact, completionOffset: offset });
  const fd = fs.openSync(filename, 'r+');
  try {
    const length = fs.fstatSync(fd).size - offset;
    if (length < 0 || length > payload.length) throw uploadUncertain(record);
    const present = Buffer.alloc(length);
    fs.readSync(fd, present, 0, length, offset);
    if (!present.equals(payload.subarray(0, length))) throw uploadUncertain(record);
    if (length !== payload.length) {
      fs.ftruncateSync(fd, offset);
      let written = 0;
      while (written < payload.length) written += fs.writeSync(fd, payload, written, payload.length - written, offset + written);
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  journal.clear(record.id);
}
module.exports = { createUploadJournal, uploadUncertain, recordUploadCompletion };
