'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
function validateCheckpointRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) throw new Error('rfork: choose an absolute local checkpoint location');
  if (process.platform === 'win32') {
    const drive = path.parse(directory).root.slice(0, 2);
    if (!/^[A-Za-z]:$/.test(drive)) throw new Error('rfork: checkpoints require fixed local NTFS');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object DriveType,FileSystem | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const volume = JSON.parse(output);
    if (volume.DriveType !== 3 || volume.FileSystem !== 'NTFS') throw new Error('rfork: checkpoints require fixed local NTFS');
  }
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) throw new Error('rfork: checkpoint parent missing'); ancestor = parent; }
  for (let current = ancestor; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('rfork: checkpoint location must not contain symlinks');
    if (path.dirname(current) === current) break;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error('rfork: checkpoint parent is not a directory');
  if (process.platform !== 'win32' && fs.statfsSync) {
    const type = Number(fs.statfsSync(ancestor).type) >>> 0;
    if ([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546].includes(type)) throw new Error('rfork: choose a local checkpoint filesystem (not network/FUSE storage)');
  }
  return directory;
}
function checkpointRoot(settings, defaultRoot) {
  const root = settings.checkpointRoot || defaultRoot || path.join(require('electron').app.getPath('userData'), 'rfork-checkpoints');
  validateCheckpointRoot(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
function newCheckpoint(settings) {
  // rfork creates this missing leaf with its native protected permissions/ACL.
  return path.join(checkpointRoot(settings), randomUUID());
}
module.exports = { validateCheckpointRoot, checkpointRoot, newCheckpoint };
