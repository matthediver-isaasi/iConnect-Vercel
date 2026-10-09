import { isDeepStrictEqual } from 'node:util';
import { accountingOperationIdentity } from './accountingOperationIdentity.js';

const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, definitelyNotWritten: true }); };
const prefixes = {
  bnms_alpha_approved_existing_bank: 'bnms_alpha',
  bnms_manual_95_existing_bank: 'bnms_manual',
};

// Import provenance describes the agreement, not the age of the collection.
// This bridge is deliberately limited to the authorised October transactions.
export function bnmsOctoberRecovery(row) {
  const evidence = row.snapshot?.evidence;
  const context = evidence?.ddAccountingMigration;
  if (!context) return null;
  const payment = evidence.payment;
  const prefix = prefixes[context.snapshot?.source];
  if (row.tenant_id !== 'ff2df806-b321-4254-b651-3af11fccf1db'
    || row.provider !== 'xero' || row.source_type !== 'gocardless_payment'
    || row.operation !== 'invoice' || !prefix || payment?.environment !== 'live'
    || !['confirmed', 'paid_out'].includes(payment.status)
    || !/^2026-10-\d{2}$/.test(payment.charge_date || '')
    || !payment.gocardless_payment_id || context.planId !== payment.plan_id
    || row.snapshot.existingInvoice) fail('GC_IMPORTED_RECOVERY_OUT_OF_SCOPE');
  if (evidence.legacyWriteUncertain
    && evidence.payment.accounting_sync_error !== '[Xero bnms-pilot-account-validation] HTTP 429 (non-JSON response): ') {
    fail('GC_QUEUE_LEGACY_WRITE_REQUIRES_REVIEW');
  }
  return { prefix, context, payment };
}

async function existingOperation(db, row, recovery) {
  const { data, error } = await db.from(`${recovery.prefix}_invoice_operations`).select('*')
    .eq('tenant_id', row.tenant_id).eq('payment_id', recovery.payment.gocardless_payment_id).maybeSingle();
  if (error) fail('GC_IMPORTED_OPERATION_UNAVAILABLE');
  return data;
}

export async function assertBnmsOctoberPreparation({ db, row }) {
  const recovery = bnmsOctoberRecovery(row);
  if (!recovery) return null;
  const operation = await existingOperation(db, row, recovery);
  // A legacy claim, even without an invoice ID, is an uncertain financial write.
  // Absence is meaningful here: both imported writers claim durably BEFORE POST,
  // and the sole accepted legacy error is from their earlier bank validation.
  if (operation) fail('GC_IMPORTED_PRIOR_OPERATION_REQUIRES_REVIEW');
  return recovery;
}

function identity(row, recovery) {
  const snapshot = row.resolved_snapshot;
  const envelope = snapshot?.invoice?.envelope;
  if (!envelope || !snapshot?.importedOctoberRecovery) fail('GC_IMPORTED_PREPARATION_REQUIRED');
  if (!snapshot.payment?.envelope?.operationKey || !envelope.operationKey) {
    fail('GC_IMPORTED_PREPARATION_REQUIRED');
  }
  return {
    queueRequestId: row.id, contactId: envelope.expected.contactId,
    xeroTenantId: row.company_id, amountMinor: recovery.payment.amount_minor,
    currency: recovery.payment.currency,
    revenueCode: String(recovery.context.snapshot.revenue_account_code),
    paymentReference: row.snapshot.payment.collection.reference,
    // Record the keys the queue actually sends, not those of the old writer.
    // Ownership is transferred only when that old writer has never claimed.
    idempotencyKey: accountingOperationIdentity(envelope.operationKey, 'inv', 128),
    paymentIdempotencyKey: accountingOperationIdentity(snapshot.payment.envelope.operationKey, 'pay', 128),
  };
}

async function claim({ db, row, recovery, allowCreate }) {
  const expected = identity(row, recovery);
  const existing = await existingOperation(db, row, recovery);
  if (existing) {
    if (!isDeepStrictEqual(existing.request_identity, expected)) fail('GC_IMPORTED_OPERATION_OWNER_MISMATCH');
    return { id: existing.id, token: existing.claim_token, invoice_id: existing.invoice_id };
  }
  if (!allowCreate) fail('GC_IMPORTED_OPERATION_MISSING');
  const { data, error } = await db.rpc(`${recovery.prefix}_claim_invoice`, {
    p_tenant: row.tenant_id, p_plan: recovery.payment.plan_id,
    p_payment: recovery.payment.gocardless_payment_id, p_identity: expected,
  });
  if (error || !data) fail('GC_IMPORTED_OPERATION_CLAIM_FAILED');
  return data;
}

// Runs inside the queue's fenced invoice stage, never during preparation.
// The existing non-expiring ledger also prevents a legacy writer taking over.
export async function runBnmsOctoberInvoice({ db, row, adapter, discover = false }) {
  const recovery = bnmsOctoberRecovery(row);
  if (!recovery) return discover ? adapter.discoverInvoice(row) : adapter.createInvoice(row);
  await adapter.assertBinding(row);
  const operation = await claim({ db, row, recovery, allowCreate: !discover });
  let result;
  if (operation.invoice_id) {
    result = (await adapter.readInvoice(row, operation.invoice_id)).result;
  } else if (discover) {
    const found = await adapter.discoverInvoice(row);
    if (found.outcome !== 'found') return found;
    result = found.result;
  } else {
    result = await adapter.createInvoice(row);
  }
  const { data, error } = await db.rpc(`${recovery.prefix}_link_invoice`, {
    p_operation: operation.id, p_token: operation.token, p_invoice: result.id,
  });
  // A failure here follows a possible provider write: NEVER mark it definitely
  // unwritten. The queue must discover/read the same invoice on the next run.
  if (error || !data) throw new Error('GC_IMPORTED_OPERATION_LINK_FAILED');
  return discover ? { outcome: 'found', result } : result;
}
