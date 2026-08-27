import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDryRunManifest,
  changeSinceDryRunReason,
  isLegacyMembershipReference,
  isUnpaidInvoice,
  validateManifest,
  signManifest,
  processReviewedInvoice,
} from './repair-gfi-xero-references.mjs';

const invoice = {
  InvoiceID: 'inv-1', InvoiceNumber: 'INV-1', Type: 'ACCREC',
  Status: 'AUTHORISED', AmountDue: 100, Total: 100,
  Reference: 'Membership 2025/2026', Contact: { ContactID: 'c1', Name: 'Example' },
};
const target = { id: 'tenant-1', slug: 'gfi', name: 'Graduate Futures Institute' };
const secret = 'test-only-secret';

test('legacy matcher accepts only the exact historical shape', () => {
  assert.equal(isLegacyMembershipReference('Membership 2025'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/2026'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/26'), true);
  assert.equal(isLegacyMembershipReference('Membership 2025/1999'), false);
  assert.equal(isLegacyMembershipReference('membership 2025/2026'), false);
  assert.equal(isLegacyMembershipReference('Membership 2025/26 - PO: ABC'), false);
  assert.equal(isLegacyMembershipReference('PO-123'), false);
});

test('unpaid eligibility requires a positive balance and non-terminal status', () => {
  assert.equal(isUnpaidInvoice(invoice), true);
  assert.equal(isUnpaidInvoice({ ...invoice, AmountDue: 0 }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'PAID' }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'VOIDED' }), false);
  assert.equal(isUnpaidInvoice({ ...invoice, Status: 'DELETED' }), false);
});

test('manifest validation pins tenant, Xero organisation and reviewed values', async () => {
  let saved;
  const manifest = await buildDryRunManifest({
    tenant: target, xeroTenantId: 'xero-1', invoices: [invoice],
    loadHistory: async () => [], writeReport: async (value) => { saved = value; },
    signingSecret: secret,
  });
  assert.equal(validateManifest(saved, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret), true);
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'other' }, secret),
    /Xero organisation/,
  );
  manifest.selected[0].amountDue = 1;
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret),
    /signature/,
  );
  manifest.signature = signManifest(manifest, secret);
  manifest.selected.push({ ...manifest.selected[0] });
  manifest.signature = signManifest(manifest, secret);
  assert.throws(
    () => validateManifest(manifest, { tenantId: target.id, xeroTenantId: 'xero-1' }, secret),
    /duplicate/,
  );
});

test('change protection catches balance, status and reference drift', () => {
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  assert.equal(changeSinceDryRunReason(reviewed, invoice), null);
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, AmountDue: 90 }), 'balance-changed');
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, Reference: 'PO-1' }), 'reference-changed');
  assert.equal(changeSinceDryRunReason(reviewed, { ...invoice, Status: 'PAID', AmountDue: 0 }), 'no-longer-unpaid');
});

test('dry run writes a report but invokes no mutation dependency', async () => {
  let writes = 0;
  let mutations = 0;
  const report = await buildDryRunManifest({
    tenant: target, xeroTenantId: 'xero-1', invoices: [invoice],
    loadHistory: async () => [{ table: 'organisation_membership_history', id: 'h1' }],
    writeReport: async () => { writes++; },
    updateInvoice: async () => { mutations++; },
    signingSecret: secret,
  });
  assert.equal(writes, 1);
  assert.equal(mutations, 0);
  assert.equal(report.mutationCount, 0);
  assert.equal(report.selected.length, 1);
});

test('failed write-ahead checkpoint prevents the Xero mutation', async () => {
  let updates = 0;
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  await assert.rejects(
    processReviewedInvoice({
      reviewed,
      fetchInvoice: async () => invoice,
      updateInvoice: async () => { updates++; },
      checkpoint: async (outcome) => {
        if (outcome.state === 'updating') throw new Error('disk unavailable');
      },
    }),
    /disk unavailable/,
  );
  assert.equal(updates, 0);
});

test('write-ahead journal marks an invoice updating before provider mutation', async () => {
  const states = [];
  let current = invoice;
  const reviewed = {
    invoiceId: 'inv-1', invoiceNumber: 'INV-1', amountDue: 100,
    status: 'AUTHORISED', originalReference: 'Membership 2025/2026',
  };
  const outcome = await processReviewedInvoice({
    reviewed,
    fetchInvoice: async () => current,
    updateInvoice: async () => {
      assert.deepEqual(states, ['updating']);
      current = { ...invoice, Reference: 'TBC' };
      return { InvoiceID: 'inv-1', Reference: 'TBC' };
    },
    checkpoint: async (value) => { states.push(value.state); },
  });
  assert.deepEqual(states, ['updating', 'complete']);
  assert.equal(outcome.result, 'success');
});
