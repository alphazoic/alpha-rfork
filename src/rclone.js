'use strict';

const { getBinPath } = require('../binPath');
const { runCommand } = require('./proc-utils');
const { rforkEnvironment } = require('./rfork-environment');

// rclone requires passwords to be "obscured" before they appear in connection
// strings. We cache the result per plaintext password.
const _obscureCache = new Map();

async function obscurePass(password) {
  if (_obscureCache.has(password)) return _obscureCache.get(password);
  if (typeof password !== 'string' || /[\r\n]/.test(password)) throw new Error('MEGA password must be a single line');
  const out      = await runCommand(getBinPath('rclone'), ['obscure', '-'], { input: password + '\n', env: rforkEnvironment() });
  const obscured = out.trim();
  _obscureCache.set(password, obscured);
  return obscured;
}

// Build an rclone on-the-fly MEGA remote connection string.
function rcloneRemote(email, obscuredPass) {
  const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
  return `:mega,user=${quote(email)},pass=${quote(obscuredPass)}`;
}

module.exports = { obscurePass, rcloneRemote };
