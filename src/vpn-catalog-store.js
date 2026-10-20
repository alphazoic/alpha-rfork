'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseCatalog, serializeCatalog, VpnCatalogError, MAX_BYTES } = require('./vpn-catalog');

const BUNDLED_CATALOG = path.join(__dirname, '..', 'assets', 'proton-vpn-servers.csv');

// The imported file lives beside app preferences in userData. Never write to
// the application bundle or the user's original source list.
function createCatalogStore({ directory, bundledPath = BUNDLED_CATALOG } = {}) {
  const location = () => {
    const value = typeof directory === 'function' ? directory() : directory;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new VpnCatalogError('CATALOG_STORAGE_FAILED', 'A local app-data folder is required for the VPN catalog.');
    return path.join(value, 'vpn-servers.csv');
  };
  function read(file) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'r');
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > MAX_BYTES) throw new VpnCatalogError('INVALID_CATALOG', 'Choose a catalog file no larger than 16 MiB.');
      // Bound the read even if another process grows the file after fstat.
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0, count;
      while (length < bytes.length && (count = fs.readSync(descriptor, bytes, length, bytes.length - length, length)) > 0) length += count;
      if (length > info.size) throw new VpnCatalogError('INVALID_CATALOG', 'The catalog changed while being read. Try importing it again.');
      return parseCatalog(bytes.subarray(0, length).toString('utf8'));
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  function storageError(error) {
    if (error instanceof VpnCatalogError) return error;
    return new VpnCatalogError('CATALOG_STORAGE_FAILED', 'The local VPN server catalog could not be read or saved. Check access to the app-data folder.');
  }
  function load() {
    try {
      let catalog;
      try { catalog = read(location()); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { catalog: read(bundledPath), source: 'bundled' };
      }
      return { catalog, source: 'imported' };
    } catch (error) { throw storageError(error); }
  }
  function importText(text) {
    const catalog = parseCatalog(text);
    let temporary;
    try {
      const target = location(); fs.mkdirSync(path.dirname(target), { recursive: true });
      temporary = `${target}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, serializeCatalog(catalog), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target); temporary = null;
      return { catalog, source: 'imported' };
    } catch (error) { throw storageError(error); }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* preserve original write error */ } } }
  }
  function importFile(file) {
    try {
      const catalog = read(file);
      importText(serializeCatalog(catalog));
      return { catalog, source: 'imported' };
    }
    catch (error) { throw storageError(error); }
  }
  function reset() {
    try {
      // Validate the replacement first; never delete a working import if the
      // bundled copy is missing or corrupt.
      const catalog = read(bundledPath);
      try { fs.unlinkSync(location()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { catalog, source: 'bundled' };
    } catch (error) { throw storageError(error); }
  }
  return { load, importText, importFile, reset };
}

module.exports = { createCatalogStore, BUNDLED_CATALOG };
