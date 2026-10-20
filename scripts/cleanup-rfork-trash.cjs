'use strict';

// Clean only our earlier M3 CI fixtures which default purge moved to Trash.
// Never empty the account's Trash or remove unrelated filenames.
const names = new Set(['payload ünicode.bin', 'empty.bin', 'interrupted.bin']);
function ownedTrashFolder(folder, entries) {
  if (!/^\/Trash\/m3-ci-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(folder)) return false;
  return entries.every(entry => entry === folder || (entry.startsWith(folder + '/') && names.has(entry.slice(folder.length + 1))));
}

function cleanupTrash({ profile, email, password }) {
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const config = path.join(profile, 'cleanup-megarc');
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\t/g, '\\t');
  if (/[\r\n]/.test(email + password)) throw new Error('Testing credentials must be single lines');
  fs.writeFileSync(config, '[Login]\nUsername=' + escape(email) + '\nPassword=' + escape(password) + '\n', { mode: 0o600 });
  const binary = path.resolve(__dirname, '../bin/linux/megatools');
  const run = (command, args) => {
    try { return execFileSync(binary, [command, '--config', config, '--no-ask-password', '--reload', ...args], {
      encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'ignore'],
    }); } catch { throw new Error('Testing-account Trash cleanup metadata command failed'); }
  };
  const list = folder => run('ls', ['--print0', folder]).split('\0').filter(Boolean).map(p => p.replace(/\/$/, ''));
  let removed = 0;
  try {
    for (const folder of list('/Trash')) {
      if (!ownedTrashFolder(folder, [])) continue;
      if (!ownedTrashFolder(folder, list(folder))) continue;
      run('rm', [folder]); removed++;
    }
    if (list('/Trash').some(folder => ownedTrashFolder(folder, []))) throw new Error('A testing UUID folder remains in Trash; inspect it before deletion');
  } finally { fs.rmSync(config, { force: true }); }
  console.log(JSON.stringify({ testingTrashFoldersRemoved: removed }));
}
module.exports = { ownedTrashFolder, cleanupTrash };
