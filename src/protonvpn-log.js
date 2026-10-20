'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Extract fixed diagnostic facts, never raw log text, IPs, URLs or account data.
function parseConnectionLog(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const server = line.match(/\| INFO \| CONN\.CONNECT:START \| Server: ([A-Z]{2}(?:-[A-Z0-9]+)?#\d+) \/ /);
    if (server) result.server = server[1];
    const timeout = line.match(/\| proton\.vpn\.cli\.core\.controller:\d+ \| ERROR \| Timed out after (\d+)s waiting for event\(s\): CONNECTED\s*$/);
    if (timeout && Number(timeout[1]) > 0 && Number(timeout[1]) <= 300) result.timeoutSeconds = Number(timeout[1]);
  }
  return result;
}

function createCliLogDiagnostics({ env = process.env,
  filePath = path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'Proton', 'VPN', 'logs', 'vpn-cli.log'),
  maxBytes = 65536 } = {}) {
  return {
    begin() {
      try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? { size: stat.size, ino: stat.ino, dev: stat.dev } : null;
      } catch { return null; }
    },
    finish(token) {
      if (!token) return {};
      let fd;
      try {
        fd = fs.openSync(filePath, 'r');
        const stat = fs.fstatSync(fd);
        // Rotation/truncation loses correlation; old records cannot explain a
        // new command. Read only bytes appended since this attempt began.
        if (!stat.isFile() || stat.ino !== token.ino || stat.dev !== token.dev || stat.size < token.size) return {};
        const length = Math.min(maxBytes, stat.size - token.size);
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, stat.size - length);
        return parseConnectionLog(buffer.toString('utf8', 0, read));
      } catch { return {}; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}
module.exports = { createCliLogDiagnostics, parseConnectionLog };
