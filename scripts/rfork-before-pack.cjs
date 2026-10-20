'use strict';

const { verifyRforkBundle, BUNDLE_OS } = require('../src/rfork-bundle');

exports.default = async context => {
  // electron-builder Arch.x64 = 1. Refuse direct CLI ARM builds as well as npm builds.
  if (context.arch !== 1) throw new Error('M3 currently validates x64 packages only; rfork ARM binaries are not bundled.');
  verifyRforkBundle({ root: context.packager.projectDir, platform: BUNDLE_OS[context.electronPlatformName] });
};
