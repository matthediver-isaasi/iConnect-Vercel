import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authoritativeMembershipEntity, missingMembershipEntityOutcome, MAX_ENTITY_WAIT_MS } from './formMembershipIntegrity.js';
import { formPaymentCompletionStatus } from './formPaymentFinalize.js';

test('authoritative member and organisation links are tenant validated; prefill alone is not authority', async () => {
  for (const target of ['member', 'organization']) {
    const filters = [];
    const db = { from(table) {
      assert.equal(table, target);
      const q = { select() { return q; }, eq(k, v) { filters.push([k, v]); return q; },
        maybeSingle: async () => ({ data: { id: 'entity-1', tenant_id: 'tenant-1' } }) };
      return q;
    } };
    assert.equal(await authoritativeMembershipEntity(db, { tenant_id: 'tenant-1',
      created_member_id: 'entity-1', organization_id: 'entity-1' }, target), 'entity-1');
    assert.deepEqual(filters, [['id', 'entity-1'], ['tenant_id', 'tenant-1']]);
  }
  assert.equal(await authoritativeMembershipEntity({}, {
    tenant_id: 'tenant-1', payment_meta: { prefill_organization_id: 'entity-1' },
  }, 'organization'), null);
});

test('finished processor without required entity stops, not inferred from a pending marker', () => {
  assert.equal(missingMembershipEntityOutcome({ entity_processing_completed_at: '2027-01-01' }).status, 'blocked');
  assert.equal(missingMembershipEntityOutcome({ entity_processing_completed_at: '2027-01-01',
    payment_meta: { related_records_pending: true } }).status, 'awaiting_entity');
  assert.equal(missingMembershipEntityOutcome({ entity_processing_completed_at: '2027-01-01' },
    {}, { ran: true, partial: true }).status, 'awaiting_entity');
  assert.equal(missingMembershipEntityOutcome({}, {}, { ran: true, failed: false }).integrity_error_code,
    'MEMBERSHIP_PROCESSOR_TARGET_MISSING');
});

test('legacy diagnostic attempts and age are bounded but exact in-flight work is not misclassified', () => {
  assert.equal(missingMembershipEntityOutcome({}, { attempts: 6 }).status, 'awaiting_entity');
  assert.equal(missingMembershipEntityOutcome({}, { attempts: 7 }).status, 'blocked');
  assert.equal(missingMembershipEntityOutcome({}, { entity_wait_started_at: new Date(0).toISOString() },
    null, MAX_ENTITY_WAIT_MS).status, 'blocked');
  assert.equal(missingMembershipEntityOutcome({}, { attempts: 100 }, { awaitingOperation: true }).status, 'awaiting_entity');
});

test('blocked membership overrides a misleading done receipt and legacy paid stamp', () => {
  for (const completion of [undefined, { version: 1, status: 'done' }, { version: 1, status: 'retryable' }]) {
    assert.equal(formPaymentCompletionStatus({ payment_meta: {
      finalized: true, completion, membership_result: { status: 'blocked' },
    } }), 'attention');
  }
});

test('legacy membership sweep excludes blocked states at SQL selection and runtime boundary', () => {
  const source = readFileSync(new URL('./formPaymentReconciliation.js', import.meta.url), 'utf8');
  const sweep = source.slice(source.indexOf('const { data: pendingMembership'), source.indexOf('// Retry incomplete Structured'));
  for (const field of ['status', 'integrity_state', 'invoice_state', 'settlement_state']) {
    assert.ok(sweep.includes(`membership_result->>${field}.neq.blocked`));
  }
  assert.ok(sweep.includes('if (membershipIsBlocked(row.payment_meta?.membership_result)) continue'));
  assert.ok(sweep.includes('if (pipelineOut.awaitingOperation)'));
  assert.ok(sweep.includes('processorResult: pipelineOut'));
});