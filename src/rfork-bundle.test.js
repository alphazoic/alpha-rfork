'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { binaryTarget, verifyRforkBundle } = require('./rfork-bundle');
const { toolDisplayName } = require('./tool-names');
const root = path.resolve(__dirname, '..');

function resolver(platform, packaged) {
  const module = { exports: {} };
  const resourcesPath = path.join(os.tmpdir(), 'M3 resources');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'binPath.js'), 'utf8'), {
    require: id => id === 'electron' ? { app: { isPackaged: packaged } } : require(id),
    module, __dirname: root, process: { platform, resourcesPath },
  });
  return { get: module.exports.getBinPath, resourcesPath };
}

test('saved provider IDs resolve to rfork in development and packaged apps on all supported OSes', () => {
  for (const [platform, subdir, file] of [['linux', 'linux', 'rfork'], ['win32', 'win', 'rfork.exe'], ['darwin', 'mac', 'rfork']]) {
    for (const packaged of [false, true]) {
      const { get, resourcesPath } = resolver(platform, packaged);
      const base = packaged ? path.join(resourcesPath, 'bin') : path.join(root, 'bin', subdir);
      assert.equal(get('rclone'), path.join(base, file));
      assert.equal(get('rfork'), get('rclone'));
      assert.equal(get('megatools'), path.join(base, platform === 'win32' ? 'megatools.exe' : 'megatools'));
      assert.equal(get('mega-exec'), platform === 'win32' ? path.join(base, 'megacmd', 'MEGAclient.exe') :
        platform === 'darwin' ? path.join(base, 'megacmd', 'mega-exec') : path.join(base, 'mega-exec'));
      assert.equal(get('7za'), path.join(base, platform === 'darwin' ? '7zz' : platform === 'win32' ? '7za.exe' : '7za'));
    }
  }
});

test('all promoted binaries match their pinned native-validation fingerprints', () => {
  assert.equal(verifyRforkBundle({ root }).length, 3);
});

test('bundle checker rejects damaged bytes, wrong architecture/version, missing artifacts and evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rfork-bundle-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const common = path.join(directory, 'bin', 'rfork-bundle');
  fs.mkdirSync(path.join(common, 'validation'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'bin', 'linux'));
  const version = 'v1.75.2-rfork.fixture', executable = path.join(directory, 'bin', 'linux', 'rfork');
  const data = Buffer.alloc(256);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data);
  data.writeUInt16LE(62, 18); data.write(version, 64);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const licenses = JSON.parse(fs.readFileSync(path.join(root, 'bin/rfork-bundle/manifest.json'), 'utf8')).licenses;
  for (const license of licenses) fs.copyFileSync(path.join(root, 'bin/rfork-bundle', license.file), path.join(common, license.file));
  const manifest = { schemaVersion: 1, providerId: 'rclone', version, licenses, targets: [{ os: 'linux',
    target: 'linux/amd64', arch: 'x64', file: 'rfork', bytes: data.length, sha256: hash(data),
    nativeRuntime: 'passed', liveMegaIntegrity: 'passed', validationReport: 'validation/large.json' }] };
  const restore = () => {
    fs.writeFileSync(executable, data, { mode: 0o755 }); fs.chmodSync(executable, 0o755);
    fs.writeFileSync(path.join(common, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(common, 'validation', 'large.json'), JSON.stringify({ success: true, cleanup: { remoteAbsenceVerified: true }, forkSHA256: hash(data) }));
  };
  const check = () => verifyRforkBundle({ root: directory, platform: 'linux' });
  restore(); assert.equal(check().length, 1);
  fs.appendFileSync(executable, 'damage'); assert.throws(check, /checksum\/size/);
  restore(); fs.unlinkSync(executable); assert.throws(check, /ENOENT/);
  restore(); fs.unlinkSync(path.join(common, 'validation', 'large.json')); assert.throws(check, /ENOENT/);
  restore(); const altered = Buffer.from(data); altered.writeUInt16LE(183, 18);
  fs.writeFileSync(executable, altered); manifest.targets[0].sha256 = hash(altered);
  fs.writeFileSync(path.join(common, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(check, /architecture/);
  manifest.targets[0].sha256 = hash(data); restore();
  manifest.version = 'v1.75.2-rfork.wrong';
  fs.writeFileSync(path.join(common, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(check, /embedded version/);
  manifest.version = version; manifest.licenses = [];
  fs.writeFileSync(path.join(common, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(check, /licenses are not declared/);
  assert.throws(() => binaryTarget(Buffer.alloc(10)), /incomplete/);
});

test('packaged verification requires both the flat helper and its bundled notices/evidence', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rfork-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.cpSync(path.join(root, 'bin', 'rfork-bundle'), path.join(directory, 'bin', 'rfork-bundle'), { recursive: true });
  const executable = path.join(directory, 'bin', 'rfork');
  fs.copyFileSync(path.join(root, 'bin', 'linux', 'rfork'), executable);
  fs.chmodSync(executable, 0o755);
  const check = () => verifyRforkBundle({ root: directory, platform: 'linux', packaged: true });
  assert.equal(check()[0].executable, executable);
  assert.throws(() => verifyRforkBundle({ root: directory, packaged: true }), /requires one platform/);
  fs.unlinkSync(path.join(directory, 'bin', 'rfork-bundle', 'LICENSE-go-mega.txt'));
  assert.throws(check, /ENOENT/);
});

test('visible names do not mutate persisted order/forced provider IDs', () => {
  const saved = ['rclone', 'megacmd', 'megatools'];
  assert.deepEqual(saved.map(toolDisplayName), ['rfork', 'megacmd', 'megatools']);
  assert.deepEqual(saved, ['rclone', 'megacmd', 'megatools']);
  const markup = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal((markup.match(/data-tool="rclone"/g) || []).length, 3);
  assert.equal((markup.match(/class="tool-order-name">rfork</g) || []).length, 3);
});
