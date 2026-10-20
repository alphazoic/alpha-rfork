'use strict';

const { createUploadJournal } = require('./upload-journal');

async function reviewUploadRecovery({ directory, busy, confirm }) {
  const folder = directory();
  if (!folder) return { ok: true };
  if (busy()) return { ok: false, error: 'Wait for the active upload to stop before reviewing recovery.' };
  const journal = createUploadJournal(folder), entries = journal.read();
  if (!entries.length) return { ok: true };
  if (entries.some(entry => entry.checkpoint)) return { ok: false, error: 'Retained rfork checkpoints need recovery. Open Upload recovery to resume or inspect them individually.' };
  const detail = entries.map(item => `Account: ${item.account}\nDestination: /${item.destination}\nLocal file: ${item.source}\nState: ${item.state}`).join('\n\n');
  const approved = await confirm(detail);
  if (!approved) return { ok: false, error: 'Upload remains paused for remote-file inspection.' };
  if (busy() || folder !== directory()) return { ok: false, error: 'Upload state changed during review; inspect again.' };
  const current = journal.read();
  if (JSON.stringify(current) !== JSON.stringify(entries)) return { ok: false, error: 'Upload state changed during review; inspect again.' };
  journal.acknowledge(entries.map(item => item.id));
  return { ok: true };
}

module.exports = { reviewUploadRecovery };
