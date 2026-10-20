'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_EVENTS = 5000, MAX_BYTES = 2 * 1024 * 1024;

function formatTranscript(events, { dropped = 0 } = {}) {
  let text = 'M3 Proton VPN terminal — retained session output\n';
  if (dropped) text += `[M3] ${dropped} earlier events expired from the session buffer.\n`;
  // Source labels are framing; output text itself is never trimmed or rewritten.
  for (const event of events) {
    text += `\n[${new Date(event.time).toISOString()}] [${event.kind.toUpperCase()}]${event.commandId ? ' #' + event.commandId : ''}${event.phase === 'start' ? ' [deadline ' + event.deadlineMs + 'ms]' : ''}\n`;
    text += event.text;
  }
  return text;
}

function createVpnTerminalLog({ directory = null, maxEvents = MAX_EVENTS, maxBytes = MAX_BYTES,
  fileBytes = 5 * 1024 * 1024, now = Date.now } = {}) {
  const events = [], listeners = new Set(), active = new Map();
  let sequence = 0, bytes = 0, dropped = 0, diskDropped = 0, diskError = false;
  let queue = [], queueBytes = 0, writing = null, timer = null, disposed = false, stateKey = null;
  const session = new Date(now()).toISOString();
  const folder = () => typeof directory === 'function' ? directory() : directory;
  function notify() { for (const listener of listeners) { try { listener(); } catch { /* diagnostic observer only */ } } }
  async function drain() {
    if (writing) return writing;
    const batch = queue; queue = []; queueBytes = 0;
    if (!batch.length) return;
    writing = (async () => {
      try {
        const dir = folder();
        if (!dir) return;
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, 'vpn-terminal.jsonl');
        let size = await fs.stat(file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
        for (const line of batch) {
          const length = Buffer.byteLength(line);
          if (size && size + length > fileBytes) {
            await fs.rm(file + '.2', { force: true });
            await fs.rename(file + '.1', file + '.2').catch(e => { if (e.code !== 'ENOENT') throw e; });
            await fs.rename(file, file + '.1'); size = 0;
          }
          await fs.appendFile(file, line, { mode: 0o600 }); size += length;
        }
      } catch { if (!diskError) { diskError = true; notify(); } }
    })();
    try { await writing; } finally { writing = null; }
  }
  function schedule() {
    if (timer || disposed || !directory) return;
    timer = setTimeout(async () => { timer = null; await drain(); if (queue.length) schedule(); }, 100);
    timer.unref?.();
  }
  function record(input) {
    if (disposed || !input || typeof input.text !== 'string') return;
    // Small independent records bound snapshot IPC and disk-queue memory.
    const text = input.text;
    for (let offset = 0; offset < text.length || offset === 0;) {
      let end = Math.min(text.length, offset + 8192);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const event = { ...input, text: text.slice(offset, end), time: input.time ?? now(), seq: ++sequence };
      offset = end || 1;
      const size = Buffer.byteLength(JSON.stringify(event));
      events.push({ event, size }); bytes += size;
      while (events.length > maxEvents || bytes > maxBytes) { bytes -= events.shift().size; dropped++; }
      if (event.phase === 'start') active.set(event.commandId, { id: event.commandId, startedAt: event.time,
        command: event.text, deadlineMs: event.deadlineMs, outputBytes: 0 });
      if (event.kind === 'stdout' || event.kind === 'stderr') {
        const command = active.get(event.commandId); if (command) command.outputBytes += Buffer.byteLength(event.text);
      }
      if (event.phase === 'deadline' && active.has(event.commandId)) active.get(event.commandId).deadlineMs = event.deadlineMs;
      if (event.phase === 'close' || event.phase === 'spawn-failed') active.delete(event.commandId);
      if (directory) {
        const line = JSON.stringify({ session, ...event }) + '\n';
        const length = Buffer.byteLength(line);
        if (queueBytes + length <= 1024 * 1024) { queue.push(line); queueBytes += length; schedule(); }
        else diskDropped++;
      }
      notify();
      if (!text.length) break;
    }
  }
  function read(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0 || after > sequence) after = 0;
    const page = []; let pageBytes = 0;
    for (const { event, size } of events) {
      if (event.seq <= after) continue;
      if (page.length && (page.length >= 256 || pageBytes + size > 256 * 1024)) break;
      page.push({ ...event }); pageBytes += size;
    }
    const cursor = page.at(-1)?.seq ?? Math.max(after, sequence);
    return { events: page, cursor, latest: sequence, first: events[0]?.event.seq ?? sequence + 1,
      hasMore: cursor < sequence, bytes, dropped, diskDropped, diskError, session,
      active: [...active.values()].map(value => ({ ...value })) };
  }
  function recordState(controller) {
    const p = controller.connectionProgress, error = controller.lastError;
    const parts = [`VPN state: ${controller.state}`, p?.message, error?.message,
      p?.nextRetryAt ? 'Automatic retry: ' + new Date(p.nextRetryAt).toISOString() : null,
      controller.statusUncertainty?.interrupted ? 'VPN work paused; job retained while Proton status recovers.' : null].filter(Boolean);
    const key = parts.join('\n');
    if (key !== stateKey) { stateKey = key; record({ kind: 'm3', text: key }); }
  }
  return { record, read, recordState,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    text() { return formatTranscript(events.map(item => item.event), { dropped }); },
    async flush() { clearTimeout(timer); timer = null; await drain(); while (queue.length) await drain(); },
    async dispose() { disposed = true; listeners.clear(); clearTimeout(timer); timer = null; await drain(); while (queue.length) await drain(); },
  };
}

module.exports = { createVpnTerminalLog, formatTranscript };
