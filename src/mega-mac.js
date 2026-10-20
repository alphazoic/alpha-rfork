'use strict';
const crypto = require('crypto');
const fs = require('fs');

// MEGA's plaintext chunk CBC-MAC, followed by the condensed MAC of chunk MACs.
// Chunk boundaries are protocol boundaries, independent of download chunk sizes.
class IncrementalMac {
  constructor(keyHex, ivHex, fileSize) {
    if (!/^[a-f0-9]{32}$/i.test(keyHex) || !/^[a-f0-9]{32}$/i.test(ivHex) || !Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error('Invalid MAC parameters.');
    this.key = Buffer.from(keyHex, 'hex');
    this.nonce = Buffer.from(ivHex.slice(0, 16).repeat(2), 'hex');
    this.fileSize = fileSize; this.received = 0; this.chunkSize = 131072;
    this.chunkReceived = 0; this.aggregate = Buffer.alloc(16); this.result = null;
    this.beginChunk();
  }
  beginChunk() {
    this.cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.nonce);
    this.cipher.setAutoPadding(false); this.last = this.nonce;
  }
  collect(buffer) { if (buffer.length) this.last = Buffer.from(buffer.subarray(-16)); }
  finishChunk() {
    const padding = (16 - this.chunkReceived % 16) % 16;
    if (padding) this.collect(this.cipher.update(Buffer.alloc(padding)));
    this.collect(this.cipher.final());
    const mixed = Buffer.from(this.aggregate);
    for (let i = 0; i < 16; i++) mixed[i] ^= this.last[i];
    const cipher = crypto.createCipheriv('aes-128-ecb', this.key, null); cipher.setAutoPadding(false);
    this.aggregate = Buffer.concat([cipher.update(mixed), cipher.final()]);
    this.chunkSize = Math.min(1048576, this.chunkSize + 131072); this.chunkReceived = 0;
    this.beginChunk();
  }
  update(buffer) {
    if (this.result || this.received + buffer.length > this.fileSize) throw Object.assign(new Error('MAC input length mismatch.'), { code: 'INTEGRITY_FAILED' });
    let offset = 0;
    while (offset < buffer.length) {
      const length = Math.min(buffer.length - offset, this.chunkSize - this.chunkReceived);
      this.collect(this.cipher.update(buffer.subarray(offset, offset + length)));
      offset += length; this.chunkReceived += length; this.received += length;
      if (this.chunkReceived === this.chunkSize) this.finishChunk();
    }
  }
  finalize() {
    if (this.received !== this.fileSize) throw Object.assign(new Error('MAC input length mismatch.'), { code: 'INTEGRITY_FAILED' });
    if (this.result) return this.result;
    if (this.chunkReceived) this.finishChunk();
    const condensed = Buffer.alloc(8);
    condensed.writeUInt32BE((this.aggregate.readUInt32BE(0) ^ this.aggregate.readUInt32BE(4)) >>> 0, 0);
    condensed.writeUInt32BE((this.aggregate.readUInt32BE(8) ^ this.aggregate.readUInt32BE(12)) >>> 0, 4);
    this.result = condensed.toString('hex').toUpperCase(); return this.result;
  }
  verify(expectedHex) {
    const actual = this.finalize();
    if (this.fileSize && (!/^[a-f0-9]{16}$/i.test(expectedHex) || !crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHex, 'hex')))) {
      throw Object.assign(new Error('File integrity verification failed.'), { code: 'INTEGRITY_FAILED' });
    }
  }
}
async function verifyFileMac(filePath, key, iv, expected, fileSize, onProgress, signal) {
  const mac = new IncrementalMac(key, iv, fileSize);
  const input = fs.createReadStream(filePath, { highWaterMark: 1048576 });
  const abort = () => input.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of input) { mac.update(chunk); onProgress?.(mac.received, fileSize); }
    mac.verify(expected);
  } finally { signal?.removeEventListener('abort', abort); input.destroy(); }
}
module.exports = { IncrementalMac, verifyFileMac };
