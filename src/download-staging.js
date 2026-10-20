'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const OWNER = 'M3-download-staging', VERSION = 1;
const PREFIX = '.m3-download-';
const active = new Set();
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Use conservative comparison on macOS as its usual volumes ignore case too.
const comparable = value => ['win32', 'darwin'].includes(process.platform) ? value.toLowerCase() : value;
const downloadDestinationKey = value => comparable(path.resolve(value));
const conflict = message => Object.assign(new Error(message), { code: 'DOWNLOAD_STAGING_CONFLICT' });
async function stat(filename) {
  try { return await fs.lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
async function json(filename) {
  const info = await stat(filename);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null;
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') return null; throw error; }
}
function owned(record, root) {
  return record?.owner === OWNER && record.version === VERSION && record.directory === path.basename(root) &&
    typeof record.destination === 'string' && /^[a-f0-9]{64}$/.test(record.identity);
}
async function manifest(root) {
  const info = await stat(root);
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  const record = await json(path.join(root, 'manifest.json'));
  return owned(record, root) ? record : null;
}
async function safeTree(root) {
  const info = await stat(root);
  if (!info || info.isSymbolicLink()) throw conflict('Download staging contains a missing path or symbolic link.');
  if (info.isDirectory()) {
    for (const name of await fs.readdir(root)) await safeTree(path.join(root, name));
  } else if (!info.isFile()) throw conflict('Download staging contains an unsupported file type.');
}

// Check ancestors as well as the destination itself: a requested remote folder
// must never turn an existing staging tree into an output namespace.
async function assertDownloadDestination(destination) {
  let current = path.resolve(destination);
  while (true) {
    const info = await stat(current);
    if (info) {
      if (info.isSymbolicLink()) {
        const resolved = await fs.realpath(current);
        if (resolved !== current) await assertDownloadDestination(resolved);
      }
      if (path.basename(current).startsWith(PREFIX)) {
        if (await manifest(current)) throw conflict('The download destination conflicts with retained M3 staging data.');
        const record = info.isFile() ? await json(current) : null;
        if (record?.owner === OWNER && record.kind === 'destination-lock') throw conflict('The download destination conflicts with an active M3 download lock.');
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function downloadStagingIdentity({ outPath, fileSize, fileKey, fileIv, metaMacHex, postBody, apiUrl, chunkSize, mode = 'normal' }) {
  return { destination: path.resolve(outPath), fileSize, chunkSize, mode,
    identity: digest([apiUrl, postBody, fileKey, fileIv, metaMacHex, fileSize, chunkSize, mode]) };
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function destinationLease(destination) {
  const lockPath = path.join(path.dirname(destination), `${PREFIX}lock-${digest(comparable(destination))}.json`);
  const token = crypto.randomUUID();
  const record = { owner: OWNER, version: VERSION, kind: 'destination-lock', destination, pid: process.pid, token };
  const remove = async expected => {
    const before = await stat(lockPath), stored = await json(lockPath);
    if (!before || before.isSymbolicLink() || stored?.token !== expected) throw conflict('Download lock ownership changed.');
    const after = await stat(lockPath);
    if (!after || after.ino !== before.ino || after.dev !== before.dev) throw conflict('Download lock ownership changed.');
    await fs.unlink(lockPath);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stored = await json(lockPath);
      if (stored?.owner !== OWNER || stored.version !== VERSION || stored.kind !== 'destination-lock' ||
          typeof stored.destination !== 'string' || comparable(stored.destination) !== comparable(destination) ||
          typeof stored.token !== 'string' || alive(stored.pid)) {
        throw conflict('The destination is already in use, or its download lock is not owned by M3.');
      }
      await remove(stored.token); continue;
    }
    try { await handle.writeFile(JSON.stringify(record)); } finally { await handle.close(); }
    return () => remove(token);
  }
  throw conflict('The destination is already in use by another download.');
}

async function openDownloadStaging(spec) {
  await assertDownloadDestination(spec.destination);
  const parent = await fs.realpath(path.dirname(spec.destination));
  const destination = path.join(parent, path.basename(spec.destination));
  const target = comparable(destination);
  if (active.has(target)) throw conflict('Another download is writing this destination.');
  active.add(target);
  let release, root;
  try {
    release = await destinationLease(destination);
    // Only a matching, versioned ownership record permits reuse. A malformed
    // directory or unrelated partial-looking user file is never adopted.
    if (spec.mode === 'normal' || spec.mode === 'sparse') {
      for (const name of (await fs.readdir(parent)).sort()) {
        if (!name.startsWith(PREFIX)) continue;
        const candidate = path.join(parent, name), record = await manifest(candidate);
        if (record && comparable(record.destination) === target && record.identity === spec.identity &&
            (spec.mode === 'normal' || record.state === 'pending-publication')) {
          await safeTree(candidate); root = candidate; break;
        }
      }
    }
    if (!root) {
      root = await fs.mkdtemp(path.join(parent, PREFIX));
      await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ ...spec, destination,
        owner: OWNER, version: VERSION, directory: path.basename(root) }), { flag: 'wx', mode: 0o600 });
    }
    const extension = path.extname(destination);
    const stage = { root, plaintext: path.join(root, 'plaintext.part'), control: path.join(root, 'checkpoints.json'),
      preview: path.join(root, 'preview' + (/^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : '')),
      pendingPublication: (await manifest(root)).state === 'pending-publication' };
    const check = async () => {
      const record = await manifest(root);
      if (!record || record.identity !== spec.identity || comparable(record.destination) !== target) throw conflict('Download staging ownership changed.');
      await safeTree(root);
    };
    await check();
    stage.setPendingPublication = async pending => {
      await check();
      const record = await manifest(root), temp = path.join(root, `manifest-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify({ ...record, state: pending ? 'pending-publication' : 'downloading' }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, path.join(root, 'manifest.json')); stage.pendingPublication = pending;
    };
    await fs.mkdir(path.join(root, 'encrypted'), { recursive: true });
    stage.encrypted = offset => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid encrypted cache offset.');
      return path.join(root, 'encrypted', `${offset}.part`);
    };
    stage.readCheckpoints = async () => {
      const values = await json(stage.control);
      return Array.isArray(values) ? values.filter(n => Number.isSafeInteger(n) && n >= 0) : [];
    };
    stage.writeCheckpoints = async positions => {
      await check();
      const temp = path.join(root, `checkpoints-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(temp, JSON.stringify([...positions]), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, stage.control);
    };
    stage.reset = async () => {
      await check();
      for (const filename of [stage.plaintext, stage.preview, stage.control, path.join(root, 'encrypted')]) await fs.rm(filename, { recursive: true, force: true });
      await fs.mkdir(path.join(root, 'encrypted'));
      if (stage.pendingPublication) await stage.setPendingPublication(false);
    };
    let readers = 0, closed = false, complete = false;
    const cleanup = async () => {
      if (closed && complete && !readers) { await check(); await fs.rm(root, { recursive: true }); }
    };
    stage.playback = async () => {
      await check();
      const directory = await fs.mkdtemp(path.join(root, 'playback-'));
      readers++;
      let released = false;
      return { directory, id: crypto.randomUUID(), playlist: path.join(directory, 'playlist.m3u'),
        async release() {
          if (released) return;
          released = true;
          await check(); await fs.rm(directory, { recursive: true }); readers--; await cleanup();
        } };
    };
    stage.close = async ({ published = false, discard = false } = {}) => {
      if (closed) return;
      closed = true; complete = published || discard;
      try { await cleanup(); } finally { try { await release(); } finally { active.delete(target); } }
    };
    return stage;
  } catch (error) {
    try { await release?.(); } finally { active.delete(target); }
    throw error;
  }
}

module.exports = { openDownloadStaging, downloadStagingIdentity, assertDownloadDestination, downloadDestinationKey };
