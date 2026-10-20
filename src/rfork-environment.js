'use strict';

function rforkEnvironment(email, obscuredPass) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RCLONE_')));
  return { ...env, RCLONE_CONFIG: 'notfound', ...(email === undefined ? {} : { RCLONE_MEGA_USER: email }),
    ...(obscuredPass === undefined ? {} : { RCLONE_MEGA_PASS: obscuredPass }) };
}

module.exports = { rforkEnvironment };
