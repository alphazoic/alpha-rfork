'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRforkSettings: normalize, rforkArgs, fields, effectiveRforkSettings, summarizeRforkSettings } = require('./rfork-settings');
test('old configuration gets compatibility defaults and meaningful zero/false/inherit round-trip', () => {
  const defaults = normalize();
  assert.equal(defaults.workers, 8); assert.equal(defaults.https, true); assert.equal(defaults.bundling, false);
  const value = normalize({ pacingMs: 0, readBufferMiB: 0, stallSeconds: 0, checkpointIntervalSeconds: 0, dataRetries: -1, https: false });
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(value))), value);
  assert.ok(Object.isFrozen(value));
});
test('invalid IPC drafts are rejected without partial parsing or silent clamping', () => {
  for (const draft of [null, [], '8', { workers: '8x' }, { workers: '8' }, { workers: 21 }, { workers: 1.5 },
    { pacingMs: NaN }, { statsSeconds: 0 }, { https: 'false' }, { cutoffMode: 'other' }, { unknown: 1 },
    { schemaVersion: 2 }, { resume: true, https: false }, { bundleSizeMiB: 65 }, { readBufferMiB: -1 }]) {
    assert.throws(() => normalize(draft), /rfork/i);
  }
});
test('argv preserves explicit units and controlled retry behavior; inverse transport flags work', () => {
  const value = normalize({ workers: 12, bundling: true, bundleSizeMiB: 3.5, https: false, pacingMs: 0,
    dataRetries: 0, retryBodyErrors: true, diagnostics: true, http2: false, keepAlive: false,
    bandwidthMiB: 2, maxTransferMiB: 4, cutoffMode: 'cautious', readBufferMiB: 0 });
  const args = rforkArgs(value);
  const get = flag => args[args.indexOf(flag) + 1];
  assert.equal(get('--mega-upload-concurrency'), '12'); assert.equal(get('--mega-upload-request-size'), '3670016B');
  assert.ok(args.includes('--mega-use-https=false')); assert.equal(get('--mega-upload-pacing'), '0ms');
  assert.equal(get('--mega-upload-retries'), '0'); assert.equal(get('--retries'), '1'); assert.equal(get('--low-level-retries'), '1');
  assert.ok(args.includes('--disable-http2=true')); assert.ok(args.includes('--disable-http-keep-alives=true'));
  assert.equal(get('--bwlimit'), '2097152B'); assert.equal(get('--buffer-size'), '0B');
  assert.equal(get('--max-transfer'), '4194304B'); assert.equal(get('--cutoff-mode'), 'cautious');
});
test('resume args omit ineffective source buffering, require HTTPS, and summary excludes storage paths', () => {
  const value = normalize({ resume: true, checkpointRoot: '/private/checkpoints', readBufferMiB: 64 });
  assert.ok(!rforkArgs(value, { resume: true }).includes('--buffer-size'));
  assert.ok(!summarizeRforkSettings(value).includes('/private'));
  const effective = effectiveRforkSettings(value);
  assert.equal(effective.readBufferMiB, null); assert.equal(effective.requestSizeBytes, 0);
  assert.ok(!JSON.stringify(effective).includes('/private'));
  assert.ok(fields.length >= 24);
});
