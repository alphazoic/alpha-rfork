'use strict';

// Display names are separate from provider IDs stored in existing settings.
function toolDisplayName(tool) {
  return tool === 'rclone' ? 'rfork' : tool;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { toolDisplayName };
