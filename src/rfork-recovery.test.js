'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createUploadJournal, recordUploadCompletion } = require('./upload-journal');
const { reviewUploadRecovery } = require('./upload-recovery-review');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rfork-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = createUploadJournal(dir);
  return { dir, journal, record: journal.begin({ account:'test@example.test',source:path.join(dir,'source'),destination:'folder/source',bytes:7,checkpoint:path.join(dir,'private-state') }) };
}
test('checkpoint holds cannot be cleared by legacy whole-queue approval or turning resume off', async t => {
  const f = fixture(t); let asked = false;
  const result = await reviewUploadRecovery({ directory:()=>f.dir,busy:()=>false,confirm:async()=>{asked=true;return true;} });
  assert.equal(result.ok,false); assert.equal(asked,false);
  assert.throws(()=>f.journal.acknowledge([f.record.id]),/individually/);
  assert.equal(createUploadJournal(f.dir).read()[0].checkpoint,f.record.checkpoint);
});
test('legacy journal entries remain readable without inventing resumable state', t => {
  const f = fixture(t);
  const entry={...f.record};delete entry.checkpoint;
  fs.writeFileSync(path.join(f.dir,'upload-recovery.json'),JSON.stringify({schemaVersion:1,entries:[entry]}));
  assert.equal(f.journal.read()[0].checkpoint,undefined);
  assert.throws(()=>f.journal.assertClear(),e=>e.uploadUncertain);
});
test('completion recording recovers a partial CSV write and never duplicates a durable row', t => {
  const f = fixture(t); const filename=path.join(f.dir,'upload_log.csv'); const header='header\n'; const row='"name\nwith newline","test@example.test"';
  fs.writeFileSync(filename,header+row.slice(0,8));
  f.journal.update(f.record.id,'committed',{node:'node-id',completionRow:row,completionOffset:Buffer.byteLength(header)});
  recordUploadCompletion(f.journal,f.record,filename,'different retry row');
  assert.equal(fs.readFileSync(filename,'utf8'),header+row+'\n');assert.equal(f.journal.read().length,0);
  const g=fixture(t);g.journal.update(g.record.id,'committed',{completionRow:row,completionOffset:Buffer.byteLength(header)});
  recordUploadCompletion(g.journal,g.record,filename,row);assert.equal(fs.readFileSync(filename,'utf8'),header+row+'\n');
});
test('external CSV changes retain the committed hold rather than overwrite data', t => {
  const f=fixture(t);const filename=path.join(f.dir,'log.csv');fs.writeFileSync(filename,'header\nuser-edited');
  f.journal.update(f.record.id,'committed',{completionRow:'expected',completionOffset:7});
  assert.throws(()=>recordUploadCompletion(f.journal,f.record,filename,'ignored'),e=>e.uploadUncertain);
  assert.equal(f.journal.read().length,1);assert.equal(fs.readFileSync(filename,'utf8'),'header\nuser-edited');
});
test('checkpoint location rejects relative paths and symlink roots', {skip:process.platform==='win32'}, t => {
  const {validateCheckpointRoot}=require('./rfork-checkpoints');const f=fixture(t);
  assert.throws(()=>validateCheckpointRoot('relative'),/absolute/);
  fs.symlinkSync(f.dir,path.join(f.dir,'alias'));assert.throws(()=>validateCheckpointRoot(path.join(f.dir,'alias','new')),/symlink/);
  assert.equal(validateCheckpointRoot(path.join(f.dir,'new')),path.join(f.dir,'new'));
});
