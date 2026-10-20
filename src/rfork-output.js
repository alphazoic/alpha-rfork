'use strict';

const { StringDecoder } = require('node:string_decoder');
const { isOverQuotaError } = require('./utils');

function createRforkOutput(onStats = () => {}, onDiagnostics = () => {}) {
  const numeric = new Set(('schemaVersion workers retryLimit pacingSeconds requestSizeBytes sourceBytes setupSeconds dataSeconds commitSeconds elapsedSeconds restoredAcknowledgedBytes pendingSourceBytes sourceBytesRead count seconds minSeconds maxSeconds attempts retries transportFailures httpFailures bodyFailures providerFailures invalidResponses payloadBytesRead acknowledgedBytes acknowledgedChunks activeRequests peakRequests minRequestBytes maxRequestBytes firstRequestSeconds lastAcknowledgementSeconds').split(' '));
  const nested = new Set(['chunks', 'sourceRead', 'encryption', 'pacing', 'request', 'response', 'backoff']);
  const boolean = new Set(['retryBodyErrors', 'https', 'committed', 'successful']);
  function sanitize(value, depth = 0) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return out;
    for (const [key, item] of Object.entries(value)) {
      if (numeric.has(key) && Number.isFinite(item) && item >= 0) out[key] = item;
      else if (boolean.has(key) && typeof item === 'boolean') out[key] = item;
      else if (nested.has(key) && depth < 2) out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  const decoder = new StringDecoder('utf8');
  let buffer = '', oversized = false, uncertain = false, preCommit = false, quota = false, network = false;
  function line(value) {
    let record;
    try { record = JSON.parse(value); } catch { /* Plain fatal diagnostics are classified too. */ }
    const message = String(record?.msg ?? value);
    if (/remote outcome may be uncertain|MEGA finalization failed|upload failed to remove old version/i.test(message)) uncertain = true;
    if (!record?.stats && message.trim() && (!record || ['error', 'fatal', 'critical'].includes(record.level) || /^Failed to /i.test(message))) {
      preCommit = /^(?:Failed to copy: )?(?:couldn't login:|login with previous auth keys failed:|upload file failed to create session:|update make parent dir failed:)/i.test(message) ||
        /^Failed to create file system for /i.test(message);
      quota = isOverQuotaError(message);
      network = /timeout|timed out|econnreset|enotfound|connection|tls|network|socket|http post failed/i.test(message);
    }
    if (record?.stats) onStats(record.stats);
    if (record?.megaUpload || record?.megaResume) onDiagnostics(sanitize(record.megaUpload || record.megaResume));
  }
  function text(value) {
    for (const part of value.split(/(\n)/)) {
      if (part === '\n') {
        if (!oversized) line(buffer.replace(/\r$/, ''));
        buffer = ''; oversized = false;
      } else if (!oversized) {
        buffer += part;
        if (buffer.length > 65536) { buffer = ''; oversized = true; }
      }
    }
  }
  return {
    feed(value) { text(Buffer.isBuffer(value) ? decoder.write(value) : value); },
    flush() { text(decoder.end()); if (buffer && !oversized) line(buffer); buffer = ''; },
    get uncertain() { return uncertain; }, get preCommit() { return preCommit; }, get quota() { return quota; }, get network() { return network; },
  };
}

module.exports = { createRforkOutput };
