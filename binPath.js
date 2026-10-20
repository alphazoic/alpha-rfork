'use strict';

const { app } = require('electron');
const path    = require('path');

// Maps logical name → { subdir?, filename } for Windows binaries that are
// not a simple <name>.exe in the flat bin/win/ directory.
const WIN_OVERRIDES = {
  'mega-exec':       { subdir: 'megacmd', filename: 'MEGAclient.exe'   },
  'mega-cmd-server': { subdir: 'megacmd', filename: 'MEGAcmdServer.exe' },
};

// Same idea for macOS. mega-exec and mega-cmd-server live in bin/mac/megacmd/.
// The MEGAcmd background server is named 'mega-cmd' on macOS (not 'mega-cmd-server').
// 7-zip ships as '7zz' on macOS instead of '7za'.
const MAC_OVERRIDES = {
  'mega-exec':       { subdir: 'megacmd', filename: 'mega-exec' },
  'mega-cmd-server': { subdir: 'megacmd', filename: 'mega-cmd'  },
  '7za':             {                    filename: '7zz'        },
};

function getBinPath(name) {
  // Saved settings and adapters retain the legacy provider ID.
  if (name === 'rclone') name = 'rfork';
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  // Determine the base directory (flat bin root, not the megacmd subdir).
  let base;
  if (app.isPackaged) {
    // electron-builder extraResources → resources/bin/ (platform binaries
    // are selected at build time, so no platform subdir needed here).
    base = path.join(process.resourcesPath, 'bin');
  } else {
    if (isWin)      base = path.join(__dirname, 'bin', 'win');
    else if (isMac) base = path.join(__dirname, 'bin', 'mac');
    else            base = path.join(__dirname, 'bin', 'linux');
  }

  if (isWin && WIN_OVERRIDES[name]) {
    const { subdir, filename } = WIN_OVERRIDES[name];
    return path.join(base, subdir, filename);
  }

  if (isMac && MAC_OVERRIDES[name]) {
    const { subdir, filename } = MAC_OVERRIDES[name];
    return subdir ? path.join(base, subdir, filename) : path.join(base, filename);
  }

  // All other binaries: flat directory, append .exe on Windows.
  return path.join(base, isWin ? `${name}.exe` : name);
}

module.exports = { getBinPath };
