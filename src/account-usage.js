'use strict';

// Shared live-storage-usage query, imported by both upload-engine.js and
// bulk-import-engine.js. Extracted from upload-engine.js (Task B4) so neither
// engine keeps a private copy.

const { getBinPath }                             = require('../binPath');
const { megaCmdBin, megaSpawnOpts, parseMegaDf } = require('./megacmd');
const { obscurePass, rcloneRemote }              = require('./rclone');
const { runCommandWithTimeout }                  = require('./proc-utils');

// Returns account usage in KB, or null if the query fails (non-fatal).
// For megatools and megacmd, parses `df` output. For rclone, uses `about --json`.
//
// trackProc is an optional process-registration callback (the caller's _trackProc
// equivalent) that allows a kill-flag to interrupt the df subprocess mid-wait.
// Pass null / omit when the caller has no kill-aware process tracking (e.g.
// bulk-import-engine.js, whose df query runs outside any kill-guarded loop).
async function queryActualUsageKb(email, pass, toolUsed, trackProc = null) {
  try {
    if (toolUsed === 'megatools') {
      const dfOut = await runCommandWithTimeout(
        getBinPath('megatools'), ['df', '-u', email, '-p', pass], { stdio: 'pipe' }, 20000, trackProc
      );
      const m = dfOut.match(/Used:\s*(\d+)/i);
      if (!m) return null;
      return parseInt(m[1], 10) / 1024;
    } else if (toolUsed === 'megacmd') {
      // Server is already running and logged in at this point (caller called megaSwitch).
      const dfOut = await runCommandWithTimeout(
        megaCmdBin(), ['df'], megaSpawnOpts(), 20000, trackProc
      );
      const parsed = parseMegaDf(dfOut);
      if (!parsed) return null;
      return parsed.used / 1024;
    } else if (toolUsed === 'rclone') {
      const obscured = await obscurePass(pass);
      const remote   = rcloneRemote(email, obscured);
      const aboutOut = await runCommandWithTimeout(
        getBinPath('rclone'), ['about', `${remote}:`, '--json'], { stdio: 'pipe' }, 20000, trackProc
      );
      const jsonMatch = aboutOut.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const obj = JSON.parse(jsonMatch[0]);
      return Number.isSafeInteger(obj.used) && obj.used >= 0 ? obj.used / 1024 : null;
    }
  } catch { /* non-fatal — caller falls back to CSV value or zero */ }
  return null;
}

module.exports = { queryActualUsageKb };
