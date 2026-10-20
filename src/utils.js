'use strict';

const fs   = require('fs');
const path = require('path');

// ── Filesystem helpers ────────────────────────────────────────────────────────
// Recursively collect all files under `dir`, returning their full paths.
function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())  results.push(...walkDir(full));
    else if (entry.isFile())  results.push(full);
  }
  return results;
}

// ── Simple RFC-4180 CSV line parser ───────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      result.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { result.push(line.slice(i)); break; }
      result.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return result;
}

// ── File size formatter ────────────────────────────────────────────────────────
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

// ── Network speed formatter ────────────────────────────────────────────────────
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '...';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let i = 0, v = bytesPerSec;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

// Reads `csvPath`, drops any data row (header always kept) for which
// `matchFn(columns)` returns true, and rewrites the file. Returns
// { ok: true } or { ok: false, error }.
function deleteCsvRow(csvPath, matchFn) {
  try {
    if (!fs.existsSync(csvPath)) return { ok: false, error: 'File not found' };
    const lines   = fs.readFileSync(csvPath, 'utf8').split('\n');
    const rebuilt = lines.filter((line, idx) => {
      if (idx === 0 || !line.trim()) return true;
      return !matchFn(parseCSVLine(line.trim()));
    });
    fs.writeFileSync(csvPath, rebuilt.join('\n'), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── MEGA error classifiers ─────────────────────────────────────────────────────
// Returns true when text contains MEGA's storage-exceeded banner.
// Note: MEGA's own banner contains the typo "exeeded", so the regex accepts both.
// Shared between upload-engine.js and bulk-import-engine.js — do not redefine locally.
function isOverQuotaError(str) {
  return /ex[c]?eeded your available storage|storage.*quota.*limit|quota.*exceeded/i.test(str);
}

module.exports = { walkDir, parseCSVLine, formatFileSize, formatSpeed, deleteCsvRow, isOverQuotaError };
