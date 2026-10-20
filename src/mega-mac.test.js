'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { IncrementalMac, verifyFileMac } = require('./mega-mac');
const { referenceMac, key, iv } = require('../scripts/mega-test-data.cjs');
test('streamed MAC matches independent block folding across partial blocks and protocol chunk boundaries', () => {
  for (const size of [0, 1, 15, 16, 17, 131071, 131072, 131089, 400003, 6 * 1048576 + 17]) {
    const data = Buffer.alloc(size, 0x63), expected = referenceMac(data);
    const mac = new IncrementalMac(key, iv, size);
    for (let offset = 0; offset < size; offset += 7777) mac.update(data.subarray(offset, offset + 7777));
    assert.equal(mac.finalize().toLowerCase(), expected); mac.verify(expected);
  }
});
test('MAC rejects corrupted bytes, wrong keys, truncation and overlong input', () => {
  const data = Buffer.alloc(1024, 0x73), expected = referenceMac(data);
  data[200] ^= 1; const corrupt = new IncrementalMac(key, iv, data.length); corrupt.update(data);
  assert.throws(() => corrupt.verify(expected), error => error.code === 'INTEGRITY_FAILED');
  const short = new IncrementalMac(key, iv, data.length); short.update(data.subarray(1));
  assert.throws(() => short.verify(expected), /length mismatch/);
  assert.throws(() => new IncrementalMac(key, iv, 1).update(data), /length mismatch/);
  const wrong = new IncrementalMac('11'.repeat(16), iv, data.length); wrong.update(Buffer.alloc(1024, 0x73));
  assert.throws(() => wrong.verify(expected), /integrity/);
});
test('file reread verifies retained plaintext and supports cancellation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-mac-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data'), data = Buffer.alloc(131091, 0x73); await fs.writeFile(filename, data);
  await verifyFileMac(filename, key, iv, referenceMac(data), data.length);
  const abort = new AbortController(); abort.abort(new Error('canceled'));
  await assert.rejects(verifyFileMac(filename, key, iv, referenceMac(data), data.length, null, abort.signal), /canceled/);
  await fs.writeFile(filename, Buffer.alloc(data.length));
  await assert.rejects(verifyFileMac(filename, key, iv, referenceMac(data), data.length), /integrity/);
});
