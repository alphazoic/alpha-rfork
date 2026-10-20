'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const manifest = require('../bin/rfork-bundle/manifest.json');
const root = path.resolve(__dirname, '..');
const rollback = manifest.rollback;
const reference = rollback.stockResourcesCommit || rollback.m3Commit;
const destination = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'm3-stock-verifier'));
fs.mkdirSync(destination, { recursive: true });
const reports = [];
for (const [platform, subdir, file] of [['linux', 'linux', 'rclone'], ['win32', 'win', 'rclone.exe'], ['darwin', 'mac', 'rclone']]) {
  const name = 'bin/' + subdir + '/' + file;
  const bytes = execFileSync('git', ['show', reference + ':' + name], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== rollback.stockBinaries.find(b => b.path === name)?.sha256) throw new Error('Rollback checksum mismatch for ' + subdir);
  const source = execFileSync('git', ['show', reference + ':binPath.js'], { cwd: root, encoding: 'utf8' });
  if (crypto.createHash('sha256').update(source).digest('hex') !== rollback.resolverSHA256) throw new Error('Rollback resolver source checksum mismatch');
  for (const packaged of [false, true]) {
    const mod = { exports: {} }, resourcesPath = path.join(destination, 'resources');
    vm.runInNewContext(source, { require: id => id === 'electron' ? { app: { isPackaged: packaged } } : require(id), module: mod, __dirname: root, process: { platform, resourcesPath } });
    const expected = packaged ? path.join(resourcesPath, 'bin', file) : path.join(root, 'bin', subdir, file);
    if (mod.exports.getBinPath('rclone') !== expected) throw new Error('Rollback resolver mismatch');
  }
  if (platform === process.platform) {
    const target = path.join(destination, file); fs.writeFileSync(target, bytes, { mode: 0o755 }); fs.chmodSync(target, 0o755);
    const version = execFileSync(target, ['version'], { encoding: 'utf8', env: { ...process.env, RCLONE_CONFIG: 'notfound' } }).split(/\r?\n/)[0];
    if (!version.startsWith('rclone ') || version.includes('rfork')) throw new Error('Rollback is not stock rclone');
  }
  reports.push({ platform, sha256: hash, resolver: 'passed', savedProviderId: 'rclone' });
}
console.log(JSON.stringify({ rollback: rollback.m3Commit, checks: reports, stockVerifier: destination }));
