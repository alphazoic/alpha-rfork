'use strict';

/**
 * computeSmartUploadOrder — pure Best-Fit-Decreasing planner.
 *
 * @param {Array<{id, originalIndex, size}>} pendingFiles
 *   File descriptors. `id` is a stable unique identifier (e.g. the file path).
 *   `originalIndex` is the file's position in the pre-sort queue (tie-break).
 *   `size` is the file's byte size — same value as fs.statSync(file).size.
 *
 * @param {number} capacityBytes
 *   Per-account capacity ceiling in bytes. Pass accountThresholdKb * 1024 to
 *   match the upload engine's threshold exactly (no unit mismatch possible).
 *
 * @param {number} [preloadedBinTotal=0]
 *   Bytes already committed to the currently-active real account.
 *   Pass 0 for a fresh queue with no account open yet.
 *   Pass currentUsageKb * 1024 when re-planning mid-session.
 *
 * @returns {{ orderedFiles: Array, bins: Array, oversizedFiles: Array }}
 */
function computeSmartUploadOrder(pendingFiles, capacityBytes, preloadedBinTotal = 0) {
  // Step A — separate files that can never fit in a single account on their own
  const oversizedFiles = [];
  const packableFiles  = [];
  for (const file of pendingFiles) {
    if (file.size > capacityBytes) {
      oversizedFiles.push(file);
    } else {
      packableFiles.push(file);
    }
  }

  // Step B — stable descending sort by size; tie-break by original queue index (ascending)
  // Stability prevents nondeterministic reordering of equal-size files.
  const sortedFiles = [...packableFiles].sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;      // descending by size
    return a.originalIndex - b.originalIndex;            // ascending by original position
  });

  // Step C — initialise bins. bin[0], when preloadedBinTotal > 0, represents the
  // currently-active real account (already partially filled).
  const bins = [];
  if (preloadedBinTotal > 0) {
    bins.push({ total: preloadedBinTotal, items: [] });
  }

  // Step D — best-fit-decreasing assignment
  for (const file of sortedFiles) {
    let bestIndex     = -1;
    let bestRemaining = Infinity;
    for (let i = 0; i < bins.length; i++) {
      const remainingIfAdded = capacityBytes - (bins[i].total + file.size);
      if (remainingIfAdded >= 0 && remainingIfAdded < bestRemaining) {
        bestRemaining = remainingIfAdded;
        bestIndex     = i;
      }
    }
    if (bestIndex === -1) {
      bins.push({ total: file.size, items: [file] });
    } else {
      bins[bestIndex].total += file.size;
      bins[bestIndex].items.push(file);
    }
  }

  // Step E — flatten bins into a single ordered list
  let orderedFiles = [];
  for (const bin of bins) {
    orderedFiles = orderedFiles.concat(bin.items);
  }

  // Step F — oversized files go at the end, explicitly short-circuited.
  // The real upload engine's own handling for files that exceed the cap is left
  // unchanged; these are just flagged here so the caller can surface a warning.
  orderedFiles = orderedFiles.concat(oversizedFiles);

  return { orderedFiles, bins, oversizedFiles };
}

module.exports = { computeSmartUploadOrder };
