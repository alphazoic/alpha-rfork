'use strict';

// MEGA SDK errors refer to resources as well as accounts. Only specific account
// evidence from authentication may change an account badge; ENOENT, "blocked",
// and arbitrary tool failures alone do not prove account termination.
function classifyRefreshFailure(errors) {
  const entries = Object.values(errors);
  const messages = entries.map(error => String(error.message || '').toLowerCase());
  const authentication = entries.filter(error => error.refreshStage !== 'storage')
    .map(error => String(error.message || '').toLowerCase());
  if (authentication.some(message => /\blogin\b[^\n]*\b(?:api_)?eblocked\b|\baccount\s+(?:(?:has been|is|was)\s+)?(?:suspended|blocked)\b/.test(message))) {
    return { kind: 'suspended', status: 'Suspended', message: 'Suspended — confirmed account response' };
  }
  if (authentication.some(message => /\b(?:account|user)\s+(?:(?:has been|is|was)\s+)?(?:terminated|deleted|removed)\b/.test(message))) {
    return { kind: 'terminated', status: 'Terminated', message: 'Terminated — confirmed account response' };
  }
  if (messages.some(message => /\b(?:api_)?e(?:ratelimit|toomany|toomanyconnections)\b|\b429\b|too many (?:requests|attempts)|rate.?limit|throttl/.test(message))) {
    return { kind: 'rateLimited', message: 'Rate limited — status and last login unchanged' };
  }
  if (messages.some(message => /storage.*quota.*(?:limit|exceeded)|over disk quota|ex[c]?eeded your available storage/.test(message))) {
    return { kind: 'overStorage', status: 'Over Quota', message: 'Over Quota — confirmed storage response; last login unchanged' };
  }
  if (messages.some(message => /timed?\s*out|timeout|\b(?:econnreset|econnrefused|enotfound|enetunreach|ehostunreach|eai_again)\b|network|dns|tls|connection|socket|temporar(?:y|ily)|\b(?:api_)?e(?:tempunavail|again|ssl)\b/.test(message))) {
    return { kind: 'transport', message: 'Network check failed — status and last login unchanged' };
  }
  if (authentication.some(message => /invalid (?:email(?: address)?(?: or password)?|password|credentials)|authentication (?:failed|failure)|login failed|\b(?:api_)?e(?:access|mfarequired|sid)\b|two.factor|multifactor/.test(message))) {
    return { kind: 'authentication', message: 'Authentication failed — check credentials or MFA; status and last login unchanged' };
  }
  return { kind: 'unverified', message: 'Refresh could not be verified — status and last login unchanged' };
}

module.exports = { classifyRefreshFailure };
