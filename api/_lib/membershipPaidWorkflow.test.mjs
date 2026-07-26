// Task #3110 — tests for the exported fireWorkflowForPaidRow helper
// (shared between the reconciliation cron and the card-payment confirm
// endpoint). Verifies payload shape and entity-hydration skip cases via
// injected db/trigger stubs (no network).

import test from 'node:test';
import assert from 'node:assert/strict';
import { fireWorkflowForPaidRow } from './membershipPaymentReconciliation.js';

function makeDb(entity) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: entity }),
      };
    },
  };
}

function makeTrigger() {
  const fired = [];
  const trigger = async (...args) => { fired.push(args); };
  trigger.fired = fired;
  return trigger;
}

test('member row: fires field_change with unpaid->paid payload shape', async () => {
  const entity = { id: 'm1', first_name: 'A', status: 'active' };
  const db = makeDb(entity);
  const trigger = makeTrigger();
  const row = {
    id: 'h1',
    member_id: 'm1',
    accounting_invoice_number: 'INV-42',
    accounting_invoice_id: 'acc-1',
    accounting_provider: 'quickbooks',
    membership_year: '2026',
    final_cost: 100,
    currency: 'GBP',
  };

  const result = await fireWorkflowForPaidRow(
    { table: 'member_membership_history', row, snapshot: { paidAt: '2026-07-26T00:00:00Z' }, baseUrl: 'https://x.test', source: 'membership_card_payment_confirm' },
    { db, trigger },
  );

  assert.equal(result.fired, true);
  assert.equal(db.calls[0], 'member');
  assert.equal(trigger.fired.length, 1);
  const [entityType, entityId, beforeData, afterData, triggerType, baseUrl, context] = trigger.fired[0];
  assert.equal(entityType, 'member');
  assert.equal(entityId, 'm1');
  assert.equal(triggerType, 'field_change');
  assert.equal(baseUrl, 'https://x.test');
  assert.equal(beforeData.payment_status, 'unpaid');
  assert.equal(beforeData.paid_at, null);
  assert.equal(beforeData.last_membership_invoice_number, null);
  assert.equal(afterData.payment_status, 'paid');
  assert.equal(afterData.paid_at, '2026-07-26T00:00:00Z');
  assert.equal(afterData.last_membership_invoice_number, 'INV-42');
  assert.equal(afterData.accounting_invoice_number, 'INV-42');
  assert.equal(afterData.accounting_invoice_id, 'acc-1');
  assert.equal(afterData.accounting_provider, 'quickbooks');
  assert.equal(afterData.membership_year, '2026');
  assert.equal(afterData.final_cost, 100);
  assert.equal(afterData.currency, 'GBP');
  // Entity fields are hydrated into both payloads
  assert.equal(beforeData.first_name, 'A');
  assert.equal(afterData.status, 'active');
  assert.equal(context.source, 'membership_card_payment_confirm');
  assert.equal(context.historyTable, 'member_membership_history');
  assert.equal(context.historyRecordId, 'h1');
});

test('org row: entity is organization; xero_* fallbacks used', async () => {
  const db = makeDb({ id: 'o1', name: 'Org' });
  const trigger = makeTrigger();
  const row = {
    id: 'h2',
    organization_id: 'o1',
    xero_invoice_number: 'X-7',
    xero_invoice_id: 'xid-7',
    membership_year: '2026',
  };

  const result = await fireWorkflowForPaidRow(
    { table: 'organisation_membership_history', row, snapshot: {} },
    { db, trigger },
  );

  assert.equal(result.fired, true);
  assert.equal(db.calls[0], 'organization');
  const [entityType, entityId, , afterData, , , context] = trigger.fired[0];
  assert.equal(entityType, 'organization');
  assert.equal(entityId, 'o1');
  assert.equal(afterData.accounting_invoice_number, 'X-7');
  assert.equal(afterData.accounting_invoice_id, 'xid-7');
  // Missing paidAt defaults to a timestamp
  assert.ok(afterData.paid_at);
  // Default source stays the reconciliation one
  assert.equal(context.source, 'membership_payment_reconciliation');
});

test('skips when the row has no entity id', async () => {
  const db = makeDb({ id: 'nope' });
  const trigger = makeTrigger();
  const result = await fireWorkflowForPaidRow(
    { table: 'member_membership_history', row: { id: 'h3', member_id: null }, snapshot: {} },
    { db, trigger },
  );
  assert.equal(result.fired, false);
  assert.equal(result.skippedReason, 'no-entity-id');
  assert.equal(trigger.fired.length, 0);
});

test('skips when the entity record cannot be hydrated', async () => {
  const db = makeDb(null);
  const trigger = makeTrigger();
  const result = await fireWorkflowForPaidRow(
    { table: 'member_membership_history', row: { id: 'h4', member_id: 'gone' }, snapshot: {} },
    { db, trigger },
  );
  assert.equal(result.fired, false);
  assert.equal(result.skippedReason, 'entity-not-found');
  assert.equal(trigger.fired.length, 0);
});
