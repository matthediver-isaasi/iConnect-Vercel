import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canActivateScheduledMembershipWithoutInvoice,
  getMembershipGrandTotal,
  isZeroDueMembership,
  fireNewZeroDueMembershipPaidWorkflow,
  isZeroDueExistingMembership,
  toMinorUnits,
  zeroDuePaymentFields,
} from './zeroDueMembership.js';
import fs from 'node:fs';

test('zero due uses rounded final payable total', () => {
  assert.equal(toMinorUnits(0.004), 0);
  assert.equal(isZeroDueMembership({ finalCost: 0, totalWithVat: 0 }), true);
  assert.equal(isZeroDueMembership({ finalCost: 0, totalWithVat: 0.004 }), true);
  assert.equal(isZeroDueMembership({ finalCost: 0, totalWithVat: 0.005 }), false);
});

test('positive VAT or add-ons keep the membership billable', () => {
  assert.equal(isZeroDueMembership({ finalCost: 0, totalWithVat: 20 }), false);
  assert.equal(isZeroDueMembership({ finalCost: 0, totalWithVat: 0 }, { total: 12 }), false);
  assert.equal(getMembershipGrandTotal({ totalWithVat: 10.2 }, { total: 2.35 }), 12.55);
});

test('existing membership zero decisions use durable totals, not a changed simulation', () => {
  const nowZeroSimulation = { finalCost: 0, totalWithVat: 0 };
  const positiveExisting = { final_cost: 100, total_with_vat: 120 };
  assert.equal(isZeroDueMembership(nowZeroSimulation), true);
  assert.equal(isZeroDueExistingMembership(positiveExisting), false);
  assert.equal(isZeroDueExistingMembership({ final_cost: 0, total_with_vat: 0 }), true);
});

test('invoice-less scheduled activation requires a durably paid zero total', () => {
  assert.equal(canActivateScheduledMembershipWithoutInvoice({
    payment_status: 'paid',
    total_with_vat: 0,
    final_cost: 0,
  }), true);
  assert.equal(canActivateScheduledMembershipWithoutInvoice({
    payment_status: 'paid',
    total_with_vat: 120,
    final_cost: 100,
  }), false);
  assert.equal(canActivateScheduledMembershipWithoutInvoice({
    payment_status: 'unpaid',
    total_with_vat: 0,
    final_cost: 0,
  }), false);
});

test('settlement fields contain no payment-provider metadata', () => {
  const paidAt = '2026-08-27T10:00:00.000Z';
  assert.deepEqual(zeroDuePaymentFields(paidAt), {
    payment_status: 'paid',
    paid_at: paidAt,
    payment_method: null,
    stripe_payment_intent_id: null,
  });
});

test('paid workflow delivery uses a deterministic history-row key', () => {
  const source = fs.readFileSync(new URL('./zeroDueMembership.js', import.meta.url), 'utf8');
  assert.match(source, /membership-paid:\$\{table\}:\$\{durableRow\.id\}/);
  assert.match(source, /deliveryKey,/);
});

test('zero-due endpoint retries require a settled row and confirmed workflow delivery', () => {
  for (const endpoint of [
    new URL('../forms/membership-payment.js', import.meta.url),
    new URL('../membership/member-fees.js', import.meta.url),
  ]) {
    const source = fs.readFileSync(endpoint, 'utf8');
    assert.match(source, /payment_status, paid_at, total_with_vat, member_id, organization_id/);
    assert.match(source, /existingRow\.payment_status !== 'paid'/);
    assert.match(source, /isZeroDueExistingMembership\(existingRow\)/);
    assert.match(source, /deliver(?:Form|Portal)ZeroDueWorkflow/);
    assert.match(source, /retryable: true/);
  }
});

test('payment GET and POST paths prefer durable existing totals after pricing changes', () => {
  for (const endpoint of [
    new URL('../forms/membership-payment.js', import.meta.url),
    new URL('../membership/member-fees.js', import.meta.url),
  ]) {
    const source = fs.readFileSync(endpoint, 'utf8');
    assert.match(source, /existingRecord\s*\?\s*isZeroDueExistingMembership\(existingRecord\)/);
    const existingBranches = source.match(/if \(simResult\.existingRecord\) \{\s*return settleExisting/g) || [];
    assert.ok(existingBranches.length >= (endpoint.pathname.endsWith('member-fees.js') ? 2 : 1));
  }
});

test('admin and cron existing-record retries classify the durable row', () => {
  for (const endpoint of [
    new URL('./workflows.js', import.meta.url),
    new URL('../membership/member-membership-invoicing.js', import.meta.url),
    new URL('../membership/org-membership-invoicing.js', import.meta.url),
    new URL('../cron/process-membership-renewals.js', import.meta.url),
  ]) {
    const source = fs.readFileSync(endpoint, 'utf8');
    assert.match(source, /isZeroDueExistingMembership\(existingRow|isZeroDueExistingMembership\(record\)/);
  }
  const workflows = fs.readFileSync(new URL('./workflows.js', import.meta.url), 'utf8');
  assert.equal((workflows.match(/isZeroDueExistingMembership\(existingRow\)/g) || []).length >= 2, true);
  const cron = fs.readFileSync(new URL('../cron/process-membership-renewals.js', import.meta.url), 'utf8');
  assert.equal((cron.match(/isZeroDueExistingMembership\(record\)/g) || []).length >= 2, true);
  assert.match(cron, /final_cost, total_with_vat/);
  assert.match(cron, /canActivateScheduledMembershipWithoutInvoice\(row\)/);
  assert.match(cron, /!invoiceLessZeroDue/);
});

test('invoicing zero-due callers use retryable durable delivery sources', () => {
  const callers = [
    new URL('../membership/org-membership-invoicing.js', import.meta.url),
    new URL('../membership/member-membership-invoicing.js', import.meta.url),
    new URL('../cron/process-membership-renewals.js', import.meta.url),
  ];
  for (const endpoint of callers) {
    const source = fs.readFileSync(endpoint, 'utf8');
    assert.match(source, /fireNewZeroDueMembershipPaidWorkflow/);
    assert.doesNotMatch(source, /Zero-due paid workflow failed \(non-fatal\)/);
  }

  const org = fs.readFileSync(callers[0], 'utf8');
  assert.match(org, /manual_org_membership_zero_due/);
  assert.match(org, /advance_org_membership_zero_due/);
  const member = fs.readFileSync(callers[1], 'utf8');
  assert.match(member, /manual_member_membership_zero_due/);
  const cron = fs.readFileSync(callers[2], 'utf8');
  assert.match(cron, /cron_org_membership_zero_due/);
  assert.match(cron, /cron_member_membership_zero_due/);
  assert.match(cron, /zero_due_workflow_delivery_retried/);
});

test('paid workflow fires from the durably reloaded row with a stable delivery key', async () => {
  const durableRow = {
    id: 'history-1',
    organization_id: 'org-1',
    payment_status: 'paid',
    paid_at: '2026-08-27T09:00:00.000Z',
  };
  const calls = [];
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: durableRow, error: null }; },
  };
  const db = { from() { return query; } };
  const fire = async (args) => {
    calls.push(args);
    return { fired: true, delivery: { status: 'completed' } };
  };

  const first = await fireNewZeroDueMembershipPaidWorkflow({
    table: 'organisation_membership_history',
    row: { id: durableRow.id },
    paidAt: durableRow.paid_at,
    client: db,
    workflowDispatcher: fire,
  });
  const second = await fireNewZeroDueMembershipPaidWorkflow({
    table: 'organisation_membership_history',
    row: { id: durableRow.id },
    paidAt: durableRow.paid_at,
    client: db,
    workflowDispatcher: fire,
  });

  assert.equal(first.fired, true);
  assert.equal(second.fired, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].row, durableRow);
  assert.equal(calls[0].deliveryKey, 'membership-paid:organisation_membership_history:history-1');
  assert.equal(calls[1].deliveryKey, calls[0].deliveryKey);
});

test('paid workflow is not dispatched unless the reloaded row is durably paid', async () => {
  let dispatched = false;
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return { data: { id: 'history-2', payment_status: 'unpaid' }, error: null };
    },
  };
  const result = await fireNewZeroDueMembershipPaidWorkflow({
    table: 'member_membership_history',
    row: { id: 'history-2' },
    client: { from() { return query; } },
    workflowDispatcher: async () => { dispatched = true; },
  });

  assert.deepEqual(result, { fired: false, skippedReason: 'row-not-durably-paid' });
  assert.equal(dispatched, false);
});