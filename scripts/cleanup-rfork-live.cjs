'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const { rforkEnvironment } = require('../src/rfork-environment');
const profile = process.env.M3_VALIDATION_PROFILE;
const remote = profile && path.join(profile, 'remote.json');
if (!remote || !fs.existsSync(remote)) process.exit(0);
const { folder } = JSON.parse(fs.readFileSync(remote, 'utf8'));
if (!/^m3-ci-[0-9a-f-]{36}$/.test(folder)) throw new Error('Refusing cleanup outside a CI UUID folder');
const binary = process.env.M3_STOCK_VERIFIER;
const obscured = execFileSync(binary, ['obscure', '-'], { input: process.env.RFORK_MEGA_PASSWORD + '\n', encoding: 'utf8', env: rforkEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const run = args => execFileSync(binary, [...args, '--mega-use-https=true', '--retries', '1'], {
  env: rforkEnvironment(process.env.RFORK_MEGA_EMAIL, obscured), encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'],
});
let folders = JSON.parse(run(['lsjson', ':mega:', '--dirs-only']));
if (folders.some(x => x.Name === folder)) run(['purge', ':mega:' + folder, '--mega-hard-delete=true']);
folders = JSON.parse(run(['lsjson', ':mega:', '--dirs-only']));
if (folders.some(x => x.Name === folder)) throw new Error('CI remote folder still exists');
if (process.platform === 'linux') require('./cleanup-rfork-trash.cjs').cleanupTrash({
  profile, email: process.env.RFORK_MEGA_EMAIL, password: process.env.RFORK_MEGA_PASSWORD,
});
fs.rmSync(profile, { recursive: true, force: true });
console.log('Independent cleanup verified; isolated credentials/profile removed.');
