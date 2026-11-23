import test from 'node:test';
import assert from 'node:assert/strict';
import { transactionBody, releaseFiles, main } from './apply-event-funnel-release.mjs';
test('only known outer transaction boundaries are removed', () => {
  assert.equal(transactionBody('BEGIN;\nSELECT 1;\nCOMMIT;'), '\nSELECT 1;\n');
  assert.throws(() => transactionBody('SELECT 1;'));
  assert.throws(() => transactionBody('BEGIN;\nCOMMIT;\nCOMMIT;'));
  assert.throws(() => transactionBody('BEGIN;\nROLLBACK;\nCOMMIT;'));
});
test('all 45 source files are pinned and can form one atomic release', async () => {
  const result = await releaseFiles();
  assert.equal(result.files.length, 45);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.hash, (await releaseFiles()).hash);
  assert.ok(result.files.every(f => f.body.length > 0));
});
test('writes require explicit mode and exact hash before connection', async () => {
  await assert.rejects(main(['--apply'], {}), /Exact reviewed SHA/);
  await assert.rejects(main(['--apply','--rehearse'], {}), /Choose one/);
  await assert.rejects(main(['--force'], {}), /Unknown argument/);
});
