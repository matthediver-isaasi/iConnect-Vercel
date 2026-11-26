import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectManifest, evaluateRecoveryEvidence } from './event-funnel-recovery-readiness.mjs';

const entries = [{ file: '1_event_funnel_test.sql', sha256: 'abc', collisions: [] }];
const complete = () => ({
  manifest: entries.map(({ file, sha256 }) => ({ file, sha256 })),
  ...Object.fromEntries(['targetIdentity', 'backupRestorePoint', 'restoreWindowVerifiedAt',
    'isolatedRestoreReport', 'preChangeSchemaEvidence', 'partialBackoutReport',
    'fullBaselineMigrationReport', 'standaloneRegressionReport', 'signedReceiptRecoveryReport',
    'paymentReconciliationProcedure', 'operator', 'maintenanceWindow',
    'previousApplicationRevision'].map(key => [key, 'fixture evidence'])),
  implementationComplete: true, purchasingDisabled: true, workersControlled: true, recoveryApproved: true,
  measuredRestoreMinutes: 15, acceptedDataLossMinutes: 0,
});

test('missing evidence fails closed', () => {
  const result = evaluateRecoveryEvidence(entries);
  assert.equal(result.readyForOperatorReview, false);
  assert.ok(result.blockers.includes('Missing backupRestorePoint'));
  assert.ok(result.blockers.includes('Missing partialBackoutReport'));
});
test('complete evidence permits review only; any changed migration invalidates it', () => {
  assert.equal(evaluateRecoveryEvidence(entries, complete()).readyForOperatorReview, true);
  assert.equal(evaluateRecoveryEvidence([{ ...entries[0], sha256: 'changed' }], complete()).readyForOperatorReview, false);
});
test('collisions, missing files and incomplete implementation prevent review readiness', () => {
  assert.equal(evaluateRecoveryEvidence([{ ...entries[0], collisions: ['1_other.sql'] }], complete()).readyForOperatorReview, false);
  assert.equal(evaluateRecoveryEvidence([], complete()).readyForOperatorReview, false);
  assert.equal(evaluateRecoveryEvidence(entries, { ...complete(), implementationComplete: false }).readyForOperatorReview, false);
});
test('reordered files invalidate the reviewed manifest', () => {
  const second = { file: '2_event_funnel_test.sql', sha256: 'def', collisions: [] };
  const evidence = { ...complete(), manifest: [second, entries[0]] };
  assert.equal(evaluateRecoveryEvidence([entries[0], second], evidence).readyForOperatorReview, false);
});
test('an explicit owner waiver replaces only restore-rehearsal evidence, never actual recovery coverage', () => {
  const evidence = { ...complete(), isolatedRestoreReport: undefined, measuredRestoreMinutes: undefined,
    restoreRehearsalWaiver: { approvedByOwner:true, approvedAt:'2026-11-23T12:00:00Z',
      reason:'Owner explicitly waived a restore rehearsal' } };
  assert.equal(evaluateRecoveryEvidence(entries,evidence).readyForOperatorReview,true);
  assert.equal(evaluateRecoveryEvidence(entries,{...evidence,backupRestorePoint:undefined}).readyForOperatorReview,false);
  assert.equal(evaluateRecoveryEvidence(entries,{...evidence,restoreWindowVerifiedAt:undefined}).readyForOperatorReview,false);
  for(const waiver of [{approvedByOwner:false},{approvedByOwner:true,reason:'',approvedAt:'invalid'}]) {
    assert.equal(evaluateRecoveryEvidence(entries,{...evidence,restoreRehearsalWaiver:waiver}).readyForOperatorReview,false);
  }
});
test('actual saved batch is inventoried with checksums and known collisions', async () => {
  const manifest = await inspectManifest();
  assert.equal(manifest.length, 45);
  assert.ok(manifest.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.ok(manifest.some(entry => entry.collisions.length > 0));
});
