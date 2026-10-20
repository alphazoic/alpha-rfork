'use strict';
// Offline IDs deliberately match the fake adapters, independent of stale/live
// IDs in the user's much larger production catalog.
const { parseCatalog } = require('../src/vpn-catalog');
const catalog = parseCatalog('Switzerland,Zurich,CH#1\nGermany,Berlin,DE#2\nUnited States,Atlanta,US#3\n');
module.exports = { load: () => ({ catalog, source: 'bundled' }) };
