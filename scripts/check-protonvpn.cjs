'use strict';

// Read-only smoke check. No connect/disconnect/settings/sign-in commands.
const { createProtonVpn } = require('../src/protonvpn');

createProtonVpn().diagnose().then(result => {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ready ? 0 : 1;
}).catch(error => {
  console.error(JSON.stringify({ code: error.code || 'COMMAND_FAILED', message: error.message }));
  process.exitCode = 1;
});
