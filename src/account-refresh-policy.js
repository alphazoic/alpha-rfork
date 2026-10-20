'use strict';

const { parseCSVLine } = require('./utils');

function refreshThresholdDays(config) {
  return Math.max(1, parseInt(config.inactiveDays, 10) || 90);
}

// Keep the CSV status unchanged. Dormant is a display state derived from login age.
function parseAccountRecords(raw) {
  return raw.split('\n').slice(1).filter(line => line.trim()).map(line => {
    const cols = parseCSVLine(line);
    return {
      email: (cols[0] || '').trim(),
      password: (cols[1] || '').trim(),
      bandwidth: (cols[2] || '').trim(),
      created: (cols[3] || '').trim(),
      lastLogin: (cols[4] || '').trim(),
      status: (cols[5] || '').trim(),
      securityUpgrade: (cols[6] || '').trim(),
    };
  }).filter(account => account.email);
}

// Count only actionable checks. Known suspended, terminated and over-quota
// accounts remain visible in Accounts, but need no routine refresh reminder.
function needsAccountRefresh(account, days, now = Date.now()) {
  if (!account.email || !account.password) return false;
  const status = (account.status || '').trim();
  if (!status || status === 'Unknown') return true;
  if (status !== 'Active') return false;
  const ts = account.lastLogin ? new Date(account.lastLogin).getTime() : NaN;
  return isNaN(ts) || now - ts >= days * 86400000;
}

function accountForDisplay(account, days, now = Date.now()) {
  const needsRefresh = needsAccountRefresh(account, days, now);
  return { ...account, needsRefresh,
    status: account.status === 'Active' && needsRefresh ? 'Dormant' : account.status || 'Unknown' };
}

module.exports = { refreshThresholdDays, parseAccountRecords, needsAccountRefresh, accountForDisplay };
