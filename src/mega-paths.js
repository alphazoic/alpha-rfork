'use strict';

// Only megatools adds a virtual /Root component. A real directory called Root
// returned by rfork/MEGAcmd must survive translation to another provider.
function megaRelativePath(value, sourceTool) {
  let relative = String(value).replace(/^\/+/, '');
  if (sourceTool === 'megatools') relative = relative.replace(/^Root(?:\/|$)/, '');
  return relative;
}

function megaToolPath(value, sourceTool, targetTool) {
  const relative = megaRelativePath(value, sourceTool);
  if (targetTool === 'megatools') return '/Root' + (relative ? '/' + relative : '');
  if (targetTool === 'megacmd') return '/' + relative;
  return relative;
}

module.exports = { megaRelativePath, megaToolPath };
