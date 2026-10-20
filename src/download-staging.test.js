'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openDownloadStaging, downloadStagingIdentity, assertDownloadDestination } = require('./download-staging');
const run = promisify(execFile);

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-staging-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const spec = changes => downloadStagingIdentity({ outPath: path.join(parent, 'movie.mkv'), fileSize: 96, chunkSize: 32,
    fileKey: '01'.repeat(16), fileIv: '02'.repeat(16), metaMacHex: '03'.repeat(8), postBody: 'node-1', apiUrl: 'api-1', ...changes });
  return { parent, spec };
}

test('an owned cache survives reopening and binds its cryptographic identity and layout', async t => {
  const f = await fixture(t), first = await openDownloadStaging(f.spec());
  await fs.writeFile(first.encrypted(32), 'PARTIAL'); await fs.writeFile(first.plaintext, 'PREFIX');
  await first.writeCheckpoints(new Set([0])); await first.close();
  const second = await openDownloadStaging(f.spec());
  assert.equal(second.root, first.root); assert.equal(await fs.readFile(second.encrypted(32), 'utf8'), 'PARTIAL');
  assert.deepEqual(await second.readCheckpoints(), [0]); await second.close();
  for (const changes of [{ fileKey: '04'.repeat(16) }, { chunkSize: 64 }, { postBody: 'node-2' }, { fileSize: 128 }]) {
    const different = await openDownloadStaging(f.spec(changes));
    assert.notEqual(different.root, first.root); await different.close({ published: true });
  }
  const stored = await fs.readFile(path.join(first.root, 'manifest.json'), 'utf8');
  assert.equal(stored.includes('01'.repeat(16)), false); assert.equal(stored.includes('node-1'), false);
  assert.equal(await fs.readFile(first.plaintext, 'utf8'), 'PREFIX');
});

test('unowned and malformed staging-looking directories are preserved', async t => {
  const f = await fixture(t);
  for (const name of ['.m3-download-user', '.m3-download-malformed']) {
    const root = path.join(f.parent, name); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'manifest.json'), name === '.m3-download-user' ? '{}' : '{broken');
    await fs.writeFile(path.join(root, 'mine'), 'USER DATA');
  }
  const stage = await openDownloadStaging(f.spec()); await stage.close({ published: true });
  for (const name of ['.m3-download-user', '.m3-download-malformed']) assert.equal(await fs.readFile(path.join(f.parent, name, 'mine'), 'utf8'), 'USER DATA');
});

test('duplicate destinations are locked within this process and across application processes', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  await assert.rejects(openDownloadStaging(f.spec()), { code: 'DOWNLOAD_STAGING_CONFLICT' });
  const source = `require(${JSON.stringify(require.resolve('./download-staging'))}).openDownloadStaging(${JSON.stringify(f.spec())})
    .then(() => process.exit(2), error => { console.log(error.code); });`;
  const { stdout } = await run(process.execPath, ['-e', source]); assert.match(stdout, /DOWNLOAD_STAGING_CONFLICT/);
  await stage.close();
  const reopened = await openDownloadStaging(f.spec()); assert.equal(reopened.root, stage.root); await reopened.close({ published: true });
});

test('a fresh application process resumes after the previous owner exits without cleanup', async t => {
  const f = await fixture(t);
  const source = `(async () => {
    const fs = require('fs/promises');
    const stage = await require(${JSON.stringify(require.resolve('./download-staging'))}).openDownloadStaging(${JSON.stringify(f.spec())});
    await fs.writeFile(stage.encrypted(0), 'RETAINED'); console.log(stage.root);
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const { stdout } = await run(process.execPath, ['-e', source]);
  const stage = await openDownloadStaging(f.spec()); assert.equal(stage.root, stdout.trim());
  assert.equal(await fs.readFile(stage.encrypted(0), 'utf8'), 'RETAINED'); await stage.close({ published: true });
});

test('an unrelated file occupying the lock path is never overwritten or removed', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  const lock = (await fs.readdir(f.parent)).find(name => name.startsWith('.m3-download-lock-'));
  await stage.close(); await fs.writeFile(path.join(f.parent, lock), 'USER FILE');
  await assert.rejects(openDownloadStaging(f.spec()), { code: 'DOWNLOAD_STAGING_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.parent, lock), 'utf8'), 'USER FILE');
});

test('staging trees and active lock files cannot be used as output destinations', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  const lock = (await fs.readdir(f.parent)).find(name => name.startsWith('.m3-download-lock-'));
  for (const destination of [stage.root, stage.plaintext, path.join(stage.root, 'nested', 'out'), path.join(f.parent, lock)]) {
    await assert.rejects(assertDownloadDestination(destination), { code: 'DOWNLOAD_STAGING_CONFLICT' });
  }
  await stage.close({ published: true });
});

test('symlinks in a retained cache cannot redirect reuse or cleanup into another directory', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  const user = path.join(f.parent, 'user'); await fs.mkdir(user); await fs.writeFile(path.join(user, 'mine'), 'KEEP');
  await fs.symlink(user, path.join(stage.root, 'link'), 'dir'); await stage.close();
  await assert.rejects(openDownloadStaging(f.spec()), { code: 'DOWNLOAD_STAGING_CONFLICT' });
  assert.equal(await fs.readFile(path.join(user, 'mine'), 'utf8'), 'KEEP');
});

test('changed ownership prevents recursive cleanup and still releases the destination lease', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  await fs.writeFile(path.join(stage.root, 'mine'), 'PRESERVE');
  await fs.writeFile(path.join(stage.root, 'manifest.json'), '{}');
  await assert.rejects(stage.close({ published: true }), { code: 'DOWNLOAD_STAGING_CONFLICT' });
  assert.equal(await fs.readFile(path.join(stage.root, 'mine'), 'utf8'), 'PRESERVE');
  const next = await openDownloadStaging(f.spec()); assert.notEqual(next.root, stage.root); await next.close({ published: true });
});

test('playback readers keep their own attempt alive after publication without blocking later attempts', async t => {
  const f = await fixture(t), spec = f.spec({ mode: 'http' });
  const first = await openDownloadStaging(spec), reader = await first.playback();
  await fs.writeFile(reader.playlist, 'FIRST'); await first.close({ published: true });
  const second = await openDownloadStaging(spec), other = await second.playback();
  await fs.writeFile(other.playlist, 'SECOND'); await second.close({ published: true });
  assert.notEqual(second.root, first.root); await reader.release();
  assert.equal(await fs.readFile(other.playlist, 'utf8'), 'SECOND');
  await assert.rejects(fs.stat(first.root), { code: 'ENOENT' });
  await other.release(); await assert.rejects(fs.stat(second.root), { code: 'ENOENT' });
});

test('failed publication retains plaintext for a later attempt and reset touches only owned data', async t => {
  const f = await fixture(t), stage = await openDownloadStaging(f.spec());
  const neighbor = path.join(f.parent, 'movie.mkv.bin'); await fs.writeFile(neighbor, 'USER FILE');
  await fs.writeFile(stage.plaintext, 'VERIFIED'); await stage.close();
  const next = await openDownloadStaging(f.spec()); assert.equal(await fs.readFile(next.plaintext, 'utf8'), 'VERIFIED');
  await next.reset(); assert.equal(await fs.readFile(neighbor, 'utf8'), 'USER FILE');
  await assert.rejects(fs.stat(next.plaintext), { code: 'ENOENT' });
  assert.throws(() => next.encrypted('../outside'), /Invalid encrypted cache offset/);
  await next.close({ published: true });
});
