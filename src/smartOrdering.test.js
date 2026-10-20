'use strict';

const assert = require('assert');
const { computeSmartUploadOrder } = require('./smartOrdering');

const GB = 1024 * 1024 * 1024; // 1 GiB in bytes, matching accountThresholdKb * 1024 units
const CAP = 20 * GB;

// Helper to build a file descriptor from a GB value and original index
function f(gb, originalIndex) {
  return { id: `file_${gb}gb_${originalIndex}`, originalIndex, size: gb * GB };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// ── Test 1: Worked verification example from spec §2.2 ───────────────────────
test('worked example: [16,12,9,7,5,4,3,2] → bins [20,19,19], order [16,4,12,7,9,5,3,2]', () => {
  const sizes = [16, 12, 9, 7, 5, 4, 3, 2];
  const files = sizes.map((gb, i) => f(gb, i));
  const { orderedFiles, bins } = computeSmartUploadOrder(files, CAP, 0);

  // Bin totals
  assert.strictEqual(bins.length, 3, `expected 3 bins, got ${bins.length}`);
  assert.strictEqual(bins[0].total, 20 * GB, `bin[0] total should be 20 GB`);
  assert.strictEqual(bins[1].total, 19 * GB, `bin[1] total should be 19 GB`);
  assert.strictEqual(bins[2].total, 19 * GB, `bin[2] total should be 19 GB`);

  // Ordered output in GB
  const outGb = orderedFiles.map(f => f.size / GB);
  assert.deepStrictEqual(outGb, [16, 4, 12, 7, 9, 5, 3, 2], `order mismatch: ${outGb}`);
});

// ── Test 2: Oversized file ────────────────────────────────────────────────────
test('oversized file lands in oversizedFiles and at end of orderedFiles', () => {
  const files = [f(25, 0), f(10, 1), f(8, 2)];
  const { orderedFiles, bins, oversizedFiles } = computeSmartUploadOrder(files, CAP, 0);

  assert.strictEqual(oversizedFiles.length, 1, 'should have 1 oversized file');
  assert.strictEqual(oversizedFiles[0].size, 25 * GB);
  // Oversized file must be last in orderedFiles
  assert.strictEqual(orderedFiles[orderedFiles.length - 1].size, 25 * GB, 'oversized must be last');
  // Oversized file must NOT appear in any bin
  for (const bin of bins) {
    const inBin = bin.items.some(f => f.size === 25 * GB);
    assert.ok(!inBin, 'oversized file must not be in any bin');
  }
});

// ── Test 3: preloadedBinTotal > 0 ────────────────────────────────────────────
test('preloadedBinTotal: bin[0] starts pre-filled, files pack around it', () => {
  // Active account already has 15 GB used → only 5 GB left
  const preloaded = 15 * GB;
  const files = [f(10, 0), f(5, 1), f(3, 2)];
  const { orderedFiles, bins } = computeSmartUploadOrder(files, CAP, preloaded);

  // bin[0] started at 15 GB. The 5 GB file fits (15+5=20). 10 GB and 3 GB go to new bins.
  assert.ok(bins.length >= 2, `expected at least 2 bins, got ${bins.length}`);
  assert.strictEqual(bins[0].total, 20 * GB, `bin[0] total should be 20 GB (15 pre + 5 new)`);
  // The 5 GB file should have been placed in bin[0] (the preloaded account)
  const bin0File = bins[0].items.find(f => f.size === 5 * GB);
  assert.ok(bin0File, '5 GB file should be in the preloaded bin');
  // The 5 GB file should appear first in orderedFiles (bin[0]'s items come first)
  assert.strictEqual(orderedFiles[0].size, 5 * GB, '5 GB file (fits preloaded bin) should come first');
});

test('preloadedBinTotal: bin[0] too full for any pending file → nothing placed there', () => {
  const preloaded = 19 * GB; // only 1 GB left
  const files = [f(10, 0), f(8, 1)];
  const { bins } = computeSmartUploadOrder(files, CAP, preloaded);

  // Neither 10 nor 8 GB fits in bin[0] (1 GB remaining). Both go to new bins.
  assert.strictEqual(bins[0].items.length, 0, 'nothing should fit in the nearly-full preloaded bin');
  assert.ok(bins.length >= 3, `expected 3 bins (preloaded + 2 new), got ${bins.length}`);
});

// ── Test 4: Tie-break by original queue index ─────────────────────────────────
test('equal-size files maintain original queue order as tie-break', () => {
  // All files are 5 GB. They should come out in original index order.
  const files = [f(5, 3), f(5, 1), f(5, 0), f(5, 2)];
  const { orderedFiles } = computeSmartUploadOrder(files, CAP, 0);

  const outIndices = orderedFiles.map(f => f.originalIndex);
  // After stable sort, order among equal sizes should be ascending by originalIndex
  // (0, 1, 2, 3) distributed across bins in creation order
  for (let i = 1; i < outIndices.length; i++) {
    // Within each bin items are sorted by originalIndex ascending.
    // Across bins, the bin created first comes first.
    // Since all are 5 GB: bin[0]={5GB idx0}, bin[1]={5GB idx1}, bin[2]={5GB idx2}, bin[3]={5GB idx3}
    // So flattened: 0,1,2,3 — but 4×5=20 fits in 4 bins of 1 each. Let's just check no
    // index appears before a lower index that had the same size and was in the same bin.
    // Simplest check: the sorted order by originalIndex should be 0,1,2,3.
  }
  // More direct: sorted descending by size (all equal), then ascending by originalIndex:
  // result is [idx0, idx1, idx2, idx3]
  // Each goes into its own bin (5 GB each, 4 bins of 5 GB each ≤ 20 GB threshold).
  // But BFD: idx0→bin[0]{5}, idx1→fits bin[0]? 5+5=10≤20 yes → bin[0]{10}
  //          idx2→bin[0]{10+5=15≤20} yes → bin[0]{15}
  //          idx3→bin[0]{15+5=20≤20} yes → bin[0]{20}
  // So all in one bin, order within bin is insertion order = [idx0,idx1,idx2,idx3]
  assert.deepStrictEqual(outIndices, [0, 1, 2, 3], `tie-break order wrong: ${outIndices}`);
});

// ── Test 5: Empty queue ───────────────────────────────────────────────────────
test('empty pendingFiles returns empty results without throwing', () => {
  const { orderedFiles, bins, oversizedFiles } = computeSmartUploadOrder([], CAP, 0);
  assert.deepStrictEqual(orderedFiles, []);
  assert.deepStrictEqual(bins, []);
  assert.deepStrictEqual(oversizedFiles, []);
});

// ── Test 6: All files fit in a single bin ────────────────────────────────────
test('small files that all fit in one bin produce exactly one bin', () => {
  const files = [f(2, 0), f(3, 1), f(4, 2), f(5, 3)]; // total = 14 GB ≤ 20 GB
  const { bins, orderedFiles } = computeSmartUploadOrder(files, CAP, 0);
  assert.strictEqual(bins.length, 1, `expected 1 bin, got ${bins.length}`);
  assert.strictEqual(bins[0].total, 14 * GB);
  assert.strictEqual(orderedFiles.length, 4);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\nsmartOrdering tests:');
// (tests already ran above via test() calls)
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
