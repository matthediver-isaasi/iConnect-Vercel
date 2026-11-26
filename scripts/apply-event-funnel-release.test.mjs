import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionBody, releaseFiles, main, managedReleaseQuery } from './apply-event-funnel-release.mjs';
test('only known outer transaction boundaries are removed', () => {
  assert.equal(transactionBody('BEGIN;\nSELECT 1;\nCOMMIT;'), '\nSELECT 1;\n');
  assert.throws(() => transactionBody('SELECT 1;'));
  assert.throws(() => transactionBody('BEGIN;\nCOMMIT;\nCOMMIT;'));
  assert.throws(() => transactionBody('BEGIN;\nROLLBACK;\nCOMMIT;'));
});
test('all 45 source files are pinned and can form one atomic release', async () => {
  const result = await releaseFiles();
  assert.equal(result.files.length, 45);
  assert.equal(result.hash, 'ea07ea80966f064028e6ad5aa0555b2953791ab558d8e2781bcf3f4439306527',
    'The installed base release must stay byte-for-byte unchanged');
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.hash, (await releaseFiles()).hash);
  assert.ok(result.files.every(f => f.body.length > 0));
});
test('writes require explicit mode and exact hash before connection', async () => {
  await assert.rejects(main(['--apply'], {}), /Exact reviewed SHA/);
  await assert.rejects(main(['--apply','--rehearse'], {}), /Choose one/);
  await assert.rejects(main(['--force'], {}), /Unknown argument/);
});
test('managed rehearsal fails deliberately and applies only on explicit selection', async () => {
  const {files} = await releaseFiles();
  const rehearsal = managedReleaseQuery(files);
  assert.ok(rehearsal.includes('FUNNEL_REHEARSAL_PASSED_ROLLED_BACK'));
  assert.ok(!managedReleaseQuery(files,{rehearse:false}).includes('FUNNEL_REHEARSAL_PASSED_ROLLED_BACK'));
  assert.equal((rehearsal.match(/stage := '20270123/g)||[]).length,45);
  assert.throws(()=>managedReleaseQuery([]));
});
