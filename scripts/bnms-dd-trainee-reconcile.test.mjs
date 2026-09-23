import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import XLSX from 'xlsx';
import {
  allPages,
  deliveryState,
  explainPayment,
  parseWorkbook,
  reconcile,
} from './bnms-dd-trainee-reconcile.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const member = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Rows');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function payment(overrides = {}) {
  return {
    id: 'PM0001', status: 'paid_out', charge_date: '2026-04-01',
    amount: 1200, amount_refunded: 0, currency: 'GBP',
    metadata: { 'Invoice number': 'INV-1' }, ...overrides,
  };
}

function invoice(overrides = {}) {
  return {
    InvoiceID: '11111111-1111-4111-8111-111111111111',
    InvoiceNumber: 'INV-1', Type: 'ACCREC', Status: 'PAID', CurrencyCode: 'GBP',
    DateString: '2026-04-01', Total: 12, AmountPaid: 12, AmountDue: 0, AmountCredited: 0,
    Contact: { ContactID: '22222222-2222-4222-8222-222222222222' },
    LineItems: [{ AccountCode: '200' }],
    Payments: [{ PaymentID: '33333333-3333-4333-8333-333333333333', Reference: 'PM0001', Amount: 12 }],
    ...overrides,
  };
}

test('diagnoses the exact 21-row headerless mapping', () => {
  const rows = Array.from({ length: 21 }, (_, index) => [
    member(index + 1), `person${index + 1}@example.invalid`, `MDTEST${index + 1}`,
  ]);
  const bytes = workbook(rows);
  const parsed = parseWorkbook(bytes, digest(bytes));
  assert.equal(parsed.length, 21);
  assert.deepEqual(parsed[0], {
    sourceRow: 1,
    memberId: member(1),
    corroboratingEmail: 'person1@example.invalid',
    mandateId: 'MDTEST1',
  });
  assert.equal(parsed[20].sourceRow, 21);
});

test('rejects fingerprint drift and duplicate identities without fallback', () => {
  const rows = Array.from({ length: 21 }, (_, index) => [
    member(index + 1), `person${index + 1}@example.invalid`, `MDTEST${index + 1}`,
  ]);
  const bytes = workbook(rows);
  assert.throws(() => parseWorkbook(bytes, '0'.repeat(64)), /fingerprint drift/);
  rows[20][0] = rows[0][0];
  const duplicate = workbook(rows);
  assert.throws(() => parseWorkbook(duplicate, digest(duplicate)), /duplicate member or mandate/);
});

test('requires exact invoice/payment mapping and approved financial fields', () => {
  const exactInvoice = invoice();
  const contacts = new Map([[
    exactInvoice.Contact.ContactID,
    { ContactID: exactInvoice.Contact.ContactID, ContactStatus: 'ACTIVE', EmailAddress: 'owner@example.invalid' },
  ]]);
  const result = explainPayment(payment(), [exactInvoice], contacts);
  assert.equal(result.inReconciliationWindow, true);
  assert.equal(result.classification, 'financially_exact');
  assert.equal(result.exactInvoiceCount, 1);

  const mismatch = explainPayment(payment(), [invoice({ Total: 13 })], contacts);
  assert.equal(mismatch.classification, 'blocked_financial_evidence');
  assert.ok(mismatch.issues.some(issue => issue.code === 'INVOICE_TOTAL_CONFLICT'));
});

test('never treats old saved evidence as fresh Xero fallback', () => {
  const saved = invoice({ LineItems: [{ AccountCode: '204' }] });
  const result = explainPayment(payment(), [], new Map(), {
    xeroFailure: { message: 'Stored token expired; refresh prohibited' },
    priorIssue: { paymentId: 'PM0001', flags: ['REVENUE_ACCOUNT_OUTSIDE_REVIEWED_ALLOWLIST'] },
    savedInvoices: [saved],
    savedContactById: new Map([[
      saved.Contact.ContactID,
      { ContactID: saved.Contact.ContactID, ContactStatus: 'ACTIVE', EmailAddress: 'owner@example.invalid' },
    ]]),
  });
  assert.equal(result.originalPinnedEvidence.exactInvoiceCount, 1);
  assert.deepEqual(result.originalPinnedEvidence.invoice.accountCodes, ['204']);
  assert.equal(result.classification, 'blocked_financial_evidence');
  assert.ok(result.issues.some(issue => issue.code === 'FRESH_XERO_REVALIDATION_UNAVAILABLE'));
  assert.equal(result.xeroInvoiceId, null);
});

function paged(responses) {
  let index = 0;
  return {
    async get() {
      if (index >= responses.length) throw Error('unexpected page');
      return { observedAt: `page-${index + 1}`, body: responses[index++] };
    },
  };
}

test('pagination requires explicit terminal metadata and exact ownership', async () => {
  const exact = await allPages(paged([
    { payments: [{ id: 'PM1', links: { mandate: 'MD1' } }], meta: { cursors: { after: 'next' } } },
    { payments: [{ id: 'PM2', links: { mandate: 'MD1' } }], meta: { cursors: { after: null } } },
  ]), 'payments', { mandate: 'MD1' });
  assert.deepEqual(exact.values.map(item => item.id), ['PM1', 'PM2']);

  await assert.rejects(allPages(paged([
    { payments: [], meta: {} },
  ]), 'payments', { mandate: 'MD1' }), /cursor metadata/);
  await assert.rejects(allPages(paged([
    { payments: [{ id: 'PM1', links: { mandate: 'OTHER' } }], meta: { cursors: { after: null } } },
  ]), 'payments', { mandate: 'MD1' }), /ownership mismatch/);
});

test('pagination rejects missing/duplicate IDs and cursor cycles', async () => {
  await assert.rejects(allPages(paged([
    { payments: [{ links: { mandate: 'MD1' } }], meta: { cursors: { after: null } } },
  ]), 'payments', { mandate: 'MD1' }), /Duplicate\/missing/);
  await assert.rejects(allPages(paged([
    { payments: [{ id: 'PM1', links: { mandate: 'MD1' } }], meta: { cursors: { after: 'cycle' } } },
    { payments: [{ id: 'PM2', links: { mandate: 'MD1' } }], meta: { cursors: { after: 'cycle' } } },
  ]), 'payments', { mandate: 'MD1' }), /Repeated.*cursor/);
  await assert.rejects(allPages(paged([
    { payments: [{ id: 'PM1', links: { mandate: 'MD1' } }, { id: 'PM1', links: { mandate: 'MD1' } }], meta: { cursors: { after: null } } },
  ]), 'payments', { mandate: 'MD1' }), /Duplicate\/missing/);
  await assert.rejects(allPages(paged(Array.from({ length: 100 }, (_, index) => ({
    payments: [{ id: `PM${index}`, links: { mandate: 'MD1' } }],
    meta: { cursors: { after: `cursor-${index}` } },
  }))), 'payments', { mandate: 'MD1' }), /pagination bound exceeded/);
});

test('reports reconciliation delivery separately from accounting and adoption', () => {
  assert.deepEqual(deliveryState({ eligible: 0, xeroComplete: false }), {
    reconciliationDeliverableComplete: true,
    providerAccountingVerificationComplete: false,
    adoptionTaskComplete: false,
    supplementalManifestState: 'blocked_not_eligible',
  });
  assert.equal(deliveryState({ eligible: 3, xeroComplete: false }).supplementalManifestState, 'blocked_not_eligible');
  assert.equal(deliveryState({ eligible: 3, xeroComplete: true }).supplementalManifestState, 'review_required');
});

test('an existing private run directory is rejected before any live read', async () => {
  const out = 'exports/private-bnms-trainee-reconcile-test-existing';
  await mkdir(out, { recursive: true });
  try {
    await assert.rejects(reconcile({ outDir: out }), error => error?.code === 'EEXIST');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});