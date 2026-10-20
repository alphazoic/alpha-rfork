'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const script of ['test-vpn-ui.cjs', 'test-vpn-catalog-ui.cjs', 'test-vpn-shutdown-ui.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
