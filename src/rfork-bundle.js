'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BUNDLE_OS = { linux: 'linux', win32: 'win', darwin: 'mac' };

function readRforkManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'bin', 'rfork-bundle', 'manifest.json'), 'utf8'));
}

function binaryTarget(data) {
  if (data.length < 64) throw new Error('Executable header is incomplete');
  if (data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 62) return 'linux/amd64';
  if (data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === 0x01000007) return 'darwin/amd64';
  if (data.toString('ascii', 0, 2) === 'MZ') {
    const pe = data.readUInt32LE(0x3c);
    if (pe + 26 <= data.length && data.toString('ascii', pe, pe + 4) === 'PE\0\0' &&
        data.readUInt16LE(pe + 4) === 0x8664 && data.readUInt16LE(pe + 24) === 0x20b) return 'windows/amd64';
  }
  throw new Error('Unsupported executable format or architecture (expected amd64)');
}

function verifyRforkBundle({ root, platform = 'all', packaged = false }) {
  const manifest = readRforkManifest(root);
  if (manifest.schemaVersion !== 1 || manifest.providerId !== 'rclone' ||
      !/^v\d+\.\d+\.\d+-rfork\./.test(manifest.version)) throw new Error('Invalid rfork bundle manifest');
  if (!Array.isArray(manifest.licenses) ||
      !['LICENSE-rclone.txt', 'LICENSE-go-mega.txt'].every(file => manifest.licenses.some(license => license.file === file))) {
    throw new Error('Required rfork licenses are not declared');
  }
  const common = path.join(root, 'bin', 'rfork-bundle');
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  for (const license of manifest.licenses) {
    if (path.basename(license.file) !== license.file || hash(fs.readFileSync(path.join(common, license.file))) !== license.sha256) {
      throw new Error('rfork license missing or changed: ' + license.file);
    }
  }
  const expected = { linux: 'linux/amd64', win: 'windows/amd64', mac: 'darwin/amd64' };
  if (platform !== 'all' && !Object.hasOwn(expected, platform)) throw new Error('Unknown bundle platform: ' + platform);
  const selected = platform === 'all' ? Object.keys(expected) : [platform];
  if (packaged && selected.length !== 1) throw new Error('A packaged bundle requires one platform');
  return selected.map(os => {
    const entries = manifest.targets.filter(entry => entry.os === os);
    if (entries.length !== 1) throw new Error('Expected one rfork target for ' + os);
    const entry = entries[0], filename = os === 'win' ? 'rfork.exe' : 'rfork';
    if (entry.file !== filename || entry.target !== expected[os] || entry.arch !== 'x64' ||
        entry.nativeRuntime !== 'passed' || entry.liveMegaIntegrity !== 'passed') {
      throw new Error('Invalid or unvalidated rfork target: ' + os);
    }
    const executable = packaged ? path.join(root, 'bin', filename) : path.join(root, 'bin', os, filename);
    const data = fs.readFileSync(executable);
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) throw new Error('rfork checksum/size mismatch: ' + executable);
    if (binaryTarget(data) !== entry.target) throw new Error('rfork executable target mismatch: ' + executable);
    if (!data.includes(Buffer.from(manifest.version))) throw new Error('rfork embedded version mismatch: ' + executable);
    if (process.platform !== 'win32' && os !== 'win' && !(fs.statSync(executable).mode & 0o111)) {
      throw new Error('rfork is not executable: ' + executable);
    }
    if (!/^validation\/[a-z-]+\.json$/.test(entry.validationReport)) throw new Error('Invalid validation report path');
    const report = JSON.parse(fs.readFileSync(path.join(common, entry.validationReport), 'utf8'));
    const validated = (report.status === 'success' && report.cleanup === true && report.binarySHA256 === entry.sha256) ||
      (os === 'linux' && report.success === true && report.cleanup?.remoteAbsenceVerified === true && report.forkSHA256 === entry.sha256);
    if (!validated) throw new Error('rfork validation evidence does not match: ' + os);
    return { platform: os, target: entry.target, version: manifest.version, executable, sha256: entry.sha256 };
  });
}

module.exports = { BUNDLE_OS, readRforkManifest, binaryTarget, verifyRforkBundle };
