'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BUNDLE_OS, verifyRforkBundle } = require('../src/rfork-bundle');

try {
  const args = process.argv.slice(2);
  let root = path.resolve(__dirname, '..'), platform = 'all', packaged = false;
  while (args.length) {
    const option = args.shift(), value = args.shift();
    if (!value) throw new Error('Missing value for ' + option);
    if (option === '--resources') { root = path.resolve(value); packaged = true; }
    else if (option === '--platform') platform = value;
    else throw new Error('Unknown option: ' + option);
  }
  if (packaged && platform === 'all') platform = BUNDLE_OS[process.platform];
  const results = verifyRforkBundle({ root, platform, packaged });
  for (const result of results) {
    console.log(JSON.stringify(result));
    if (result.platform === BUNDLE_OS[process.platform] && process.arch === 'x64') {
      const version = execFileSync(result.executable, ['version'], {
        encoding: 'utf8', timeout: 15000, env: { ...process.env, RCLONE_CONFIG: 'notfound' },
      }).split(/\r?\n/)[0];
      if (version !== 'rfork ' + result.version) throw new Error('Unexpected native version: ' + version);
      console.log('Native CLI: ' + version);
    }
  }
} catch (error) {
  console.error('rfork bundle check failed: ' + error.message);
  process.exitCode = 1;
}
