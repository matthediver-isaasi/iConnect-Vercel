// Accounting-only continuation. This module never collects a Direct Debit,
// activates membership, changes benefits, or replays a GoCardless webhook.
import { enqueueAccountingRequest, processAccountingRequest } from './accountingRequestQueue.js';
import { isDeepStrictEqual } from 'node:util';

export const GO_CARDLESS_ACCOUNTING_SOURCE = 'gocardless_payment';
export const goCardlessAccountingQueueEnabled = () =>
  process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED === 'true'
  && (process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES || '').split(',').map(x => x.trim())
    .includes(GO_CARDLESS_ACCOUNTING_SOURCE);
const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, definitelyNotWritten: true }); };
// JSONB can reorder object keys. Preserve exact values and array order without
// mistaking serialization order for a change to frozen financial authority.
const same = (a, b) => isDeepStrictEqual(a ?? null, b ?? null);
async function one(query, code) {
  const { data, error } = await query.maybeSingle();
  if (error || !data) fail(code);
  return data;
}
const scope = (db, table, id, tenantId) => db.from(table).select('*').eq('id', id).eq('tenant_id', tenantId);

export async function findGoCardlessAccountingRequest({ db, tenantId, paymentId, allowMissingQueue = false }) {
  const { data, error } = await db.from('accounting_request_queue').select('*')
    .eq('tenant_id', tenantId).eq('source_type', GO_CARDLESS_ACCOUNTING_SOURCE)
    .eq('source_id', paymentId).maybeSingle();
  if (error) {
    if (allowMissingQueue && (error.code === '42P01'
      || (error.code === 'PGRST205' && String(error.message).includes('accounting_request_queue')))) return null;
    fail('ACCOUNTING_QUEUE_LOOKUP_FAILED');
  }
  return data;
}

export async function resumeGoCardlessAccountingRequest({ db, row, adapters }) {
  let result = row;
  if (row.state !== 'complete') {
    try {
      result = await processAccountingRequest({ db, requestId: row.id, ...(adapters ? { adapters } : {}) }) || row;
    } catch {
      // Ownership has already committed. Never fall back to the old writer.
    }
  }
  const { accountingQueueFacadeResult } = await import('./accountingQueueIntegration.js');
  const facade = accountingQueueFacadeResult(result);
  return { ...facade, status: !facade.accounting_pending && facade.payment_recorded ? 'posted' : 'pending',
    invoiceId: facade.id || null, invoiceNumber: facade.invoiceNumber || facade.invoice_number || null,
    reason: facade.accounting_pending ? `Accounting request ${row.id} is ${facade.accounting_state}` : undefined };
}

// Check original authority on EVERY provider/auth request, not just enqueue.
export async function assertGoCardlessAccountingSource({ db, row }) {
  const link = row.snapshot?.linkage;
  const evidence = row.snapshot?.evidence;
  if (row.source_type !== GO_CARDLESS_ACCOUNTING_SOURCE || link?.paymentId !== row.source_id
    || !link.agreementId || !evidence?.payment || !evidence.agreement) fail('GC_QUEUE_INVALID_AUTHORITY');
  const payment = await one(scope(db, 'gocardless_payments', row.source_id, row.tenant_id), 'GC_QUEUE_PAYMENT_UNAVAILABLE');
  const agreement = await one(scope(db, 'membership_billing_agreements', link.agreementId, row.tenant_id),
    'GC_QUEUE_AGREEMENT_UNAVAILABLE');
  for (const key of ['gocardless_payment_id', 'plan_id', 'gocardless_mandate_id', 'amount_minor', 'currency', 'environment', 'charge_date']) {
    if (!same(payment[key], evidence.payment[key])) fail('GC_QUEUE_PAYMENT_AUTHORITY_CHANGED');
  }
  if (!['confirmed', 'paid_out'].includes(payment.status) || !Number.isSafeInteger(payment.amount_minor)
    || payment.amount_minor <= 0) fail('GC_QUEUE_PAYMENT_NOT_CONFIRMED');
  for (const key of ['member_id', 'organization_id', 'provider', 'environment', 'gocardless_mandate_id']) {
    if (!same(agreement[key], evidence.agreement[key])) fail('GC_QUEUE_AGREEMENT_AUTHORITY_CHANGED');
  }
  if (agreement.provider !== 'gocardless' || payment.gocardless_mandate_id !== agreement.gocardless_mandate_id
    || payment.environment !== agreement.environment) fail('GC_QUEUE_PAYMENT_AGREEMENT_MISMATCH');
  const originalDd = evidence.agreement.metadata?.dd;
  if (originalDd?.currency && String(originalDd.currency).toUpperCase() !== payment.currency) {
    fail('GC_QUEUE_COLLECTION_CURRENCY_MISMATCH');
  }
  for (const key of ['invoicing_mode', 'collection_policy', 'accounting_migration', 'config_id', 'band_id', 'currency']) {
    if (!same(agreement.metadata?.dd?.[key], originalDd?.[key])) fail('GC_QUEUE_AGREEMENT_ECONOMICS_CHANGED');
  }
  if (evidence.ddAccountingMigration) {
    // Adoption/release holds are live authority, not a privilege captured
    // forever by the accepted financial snapshot.
    const { resolveBetaAccountingContext } = await import('./bnmsBetaAccounting.js');
    const { resolveAlphaAccountingContext } = await import('./bnmsAlphaAccounting.js');
    const { resolveManualAccountingContext } = await import('./bnmsManualCohort.js');
    const { assertBnmsAccountingContext } = await import('./xero.js');
    const current = await resolveBetaAccountingContext(agreement, db)
      || await resolveAlphaAccountingContext(agreement, db)
      || await resolveManualAccountingContext(agreement, db)
      || (agreement.metadata?.dd?.accounting_migration ? {
        snapshot: agreement.metadata.dd.accounting_migration, memberId: agreement.member_id,
        environment: agreement.environment, provider: agreement.provider,
      } : null);
    if (!current || !same(current, evidence.ddAccountingMigration)) fail('GC_QUEUE_BNMS_RELEASE_CHANGED');
    assertBnmsAccountingContext(row.tenant_id, current);
  }
  const plan = await one(scope(db, 'membership_payment_plans', payment.plan_id, row.tenant_id), 'GC_QUEUE_PLAN_UNAVAILABLE');
  if (plan.billing_agreement_id !== agreement.id) fail('GC_QUEUE_PLAN_AGREEMENT_MISMATCH');
  const { data: intents, error: intentError } = await db.from('membership_monthly_collection_intent')
    .select('id').eq('tenant_id', row.tenant_id).eq('plan_id', payment.plan_id)
    .eq('provider_reference', payment.gocardless_payment_id);
  if (intentError) fail('GC_QUEUE_ARREARS_AUTHORITY_UNAVAILABLE');
  if (intents?.length) fail('GC_QUEUE_ARREARS_ALLOCATION_OWNER');
  if (evidence.reservation) {
    const reservation = await one(scope(db, 'gocardless_collection_reservations', evidence.reservation.id, row.tenant_id),
      'GC_QUEUE_RESERVATION_UNAVAILABLE');
    for (const key of ['billing_agreement_id', 'gocardless_payment_id', 'amount_minor', 'currency',
      'price_snapshot', 'term_key', 'due_date', 'requested_charge_date', 'plan_id']) {
      if (!same(reservation[key], evidence.reservation[key])) fail('GC_QUEUE_RESERVATION_CHANGED');
    }
  }
  const allowedInvoiceId = row.invoice_result?.id || row.snapshot.existingInvoice?.id;
  if ((payment.accounting_provider && payment.accounting_provider !== row.provider)
    || (payment.accounting_invoice_id && payment.accounting_invoice_id !== allowedInvoiceId)
    || (payment.xero_invoice_id && (row.provider !== 'xero' || payment.xero_invoice_id !== allowedInvoiceId))) {
    fail('GC_QUEUE_PAYMENT_ALREADY_LINKED');
  }
  if (link.historyId) {
    if (!['member_membership_history', 'organisation_membership_history'].includes(link.historyTable)) fail('GC_QUEUE_HISTORY_AUTHORITY');
    const history = await one(scope(db, link.historyTable, link.historyId, row.tenant_id), 'GC_QUEUE_HISTORY_UNAVAILABLE');
    const invoiceId = history.accounting_invoice_id || history.xero_invoice_id;
    if (history.billing_agreement_id !== agreement.id || invoiceId !== row.snapshot.existingInvoice?.id
      || (history.accounting_provider !== row.provider
        && !(row.provider === 'xero' && !history.accounting_provider && history.xero_invoice_id === invoiceId))
      || (agreement.member_id && history.member_id !== agreement.member_id)
      || (agreement.organization_id && history.organization_id !== agreement.organization_id)) fail('GC_QUEUE_HISTORY_AUTHORITY_CHANGED');
  }
  return { payment, agreement };
}

export async function linkGoCardlessAccountingSource({ db, row }) {
  await assertGoCardlessAccountingSource({ db, row });
  if (!row.invoice_result?.id || row.payment_status !== 'done' || !row.payment_result?.id
    || row.payment_result.payment_recorded !== true) fail('GC_QUEUE_PAYMENT_NOT_VERIFIED');
  const invoiceNumber = row.invoice_result.invoiceNumber || row.invoice_result.invoice_number || null;
  const patch = {
    accounting_provider: row.provider, accounting_invoice_id: row.invoice_result.id,
    accounting_invoice_number: invoiceNumber, accounting_sync_status: 'posted',
    accounting_sync_error: null, accounting_synced_at: new Date().toISOString(),
    ...(row.provider === 'xero' ? { xero_invoice_id: row.invoice_result.id, xero_invoice_number: invoiceNumber } : {}),
  };
  const { payment } = await assertGoCardlessAccountingSource({ db, row });
  let update = db.from('gocardless_payments').update(patch).eq('id', row.source_id).eq('tenant_id', row.tenant_id)
    .eq('amount_minor', payment.amount_minor).eq('currency', payment.currency)
    .in('status', ['confirmed', 'paid_out']);
  update = payment.accounting_invoice_id
    ? update.eq('accounting_invoice_id', payment.accounting_invoice_id) : update.is('accounting_invoice_id', null);
  const { data, error } = await update.select('id');
  if (error || data?.length !== 1) fail('GC_QUEUE_SOURCE_LINK_FAILED');
  const saved = await one(scope(db, 'gocardless_payments', row.source_id, row.tenant_id), 'GC_QUEUE_SOURCE_LINK_UNAVAILABLE');
  if (Object.entries(patch).some(([key, value]) => !same(saved[key], value))) fail('GC_QUEUE_SOURCE_LINK_NOT_PERSISTED');
  return { linked: true, paymentId: row.source_id, invoiceId: row.invoice_result.id, providerPaymentId: row.payment_result.id };
}

export async function prepareGoCardlessSourceRequest({ row, db, providers, transport }, dependencies = {}) {
  await assertGoCardlessAccountingSource({ db, row });
  const evidence = row.snapshot.evidence;
  if (evidence.preparationError) fail(evidence.preparationError);
  if (evidence.legacyWriteUncertain) fail('GC_QUEUE_LEGACY_WRITE_REQUIRES_REVIEW');
  // Imported BNMS accounting has a separate invoice-operation ledger (and
  // pinned bank/contact/revenue authority). Never evade that ledger by using
  // the generic existing-invoice payment path; retain a durable review hold.
  if (evidence.ddAccountingMigration) fail('GC_QUEUE_BNMS_EXISTING_SETTLEMENT_OWNER');
  let args = row.snapshot.invoice.args;
  if (row.operation !== 'payment') {
    const context = evidence.context ? structuredClone(evidence.context) : null;
    if (!context) fail('GC_QUEUE_FROZEN_CONTEXT_REQUIRED');
    const migration = evidence.ddAccountingMigration;
    if (migration) {
      if (row.provider !== 'xero' || context.currency !== 'GBP'
        || (['bnms_beta_approved_existing_bank', 'bnms_alpha_approved_existing_bank'].includes(migration.snapshot.source)
          && context.nominalCode !== migration.snapshot.revenue_account_code)) fail('GC_QUEUE_BNMS_ECONOMICS_CHANGED');
      context.nominalCode = migration.snapshot.revenue_account_code;
    }
    args = { ...args, organizationName: context.contactName, invoicingEmail: context.invoicingEmail,
      invoicingAddress: context.invoicingAddress || undefined, membershipYear: context.membershipYear,
      tierLabel: context.tierLabel, vatRate: context.vatRate, nominalCode: context.nominalCode };
  }
  const prepare = dependencies.prepare || (await import('./accountingGoCardlessPreparation.js')).prepareGoCardlessAccountingRequest;
  // Provider bank/contact reads are fenced on the ORIGINAL row. The provider
  // preparer resolves only its original frozen bank setting, never today's.
  return prepare({ row, args, db, providers, transport }, dependencies);
}

export async function queueGoCardlessAccountingPayment({
  db, agreement, paymentRow, provider, ddAccountingMigration = null,
}, dependencies = {}) {
  const enabled = dependencies.enabled ?? goCardlessAccountingQueueEnabled();
  const owned = await findGoCardlessAccountingRequest({ db, tenantId: agreement.tenant_id,
    paymentId: paymentRow.id, allowMissingQueue: !enabled });
  if (owned) return resumeGoCardlessAccountingRequest({ db, row: owned, adapters: dependencies.adapters });
  if (!enabled) return undefined;
  const { resolveAccountingQueueBinding } = await import('./accountingQueueIntegration.js');
  const { isPerInstalmentAgreement } = await import('./membershipInstalmentInvoicing.js');
  const binding = await (dependencies.resolveBinding || resolveAccountingQueueBinding)({
    db, tenantId: agreement.tenant_id, provider: provider.name,
  });
  const payment = await one(scope(db, 'gocardless_payments', paymentRow.id, agreement.tenant_id), 'GC_QUEUE_PAYMENT_UNAVAILABLE');
  if (payment.gocardless_payment_id !== paymentRow.gocardless_payment_id
    || payment.amount_minor !== paymentRow.amount_minor) fail('GC_QUEUE_CALLER_EVIDENCE_CHANGED');
  let snapshot = agreement.metadata?.dd || agreement.metadata?.card;
  let reservation = null;
  if (snapshot?.collection_policy?.version === 1 && snapshot.collection_policy.pricing_policy === 'dynamic') {
    reservation = await one(db.from('gocardless_collection_reservations').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('billing_agreement_id', agreement.id)
      .eq('gocardless_payment_id', payment.gocardless_payment_id), 'GC_QUEUE_IMMUTABLE_PRICE_REQUIRED');
    if (reservation.amount_minor !== payment.amount_minor || reservation.currency !== payment.currency) fail('GC_QUEUE_PRICE_MISMATCH');
    const term = agreement.metadata?.dd?.commitment;
    if (ddAccountingMigration && (reservation.plan_id !== payment.plan_id
      || !reservation.due_date || reservation.due_date < '2026-10-01' || reservation.currency !== 'GBP'
      || !term?.term_key || reservation.term_key !== term.term_key || !term.term_start_date || !term.term_end_date
      || reservation.due_date < term.term_start_date || reservation.due_date > term.term_end_date
      || payment.charge_date < reservation.due_date || payment.charge_date > term.term_end_date
      || reservation.requested_charge_date !== payment.charge_date)) fail('GC_QUEUE_BNMS_RESERVATION_MISMATCH');
    snapshot = { ...snapshot, ...reservation.price_snapshot, collection_price_snapshot: reservation.price_snapshot };
  }
  const linkage = { paymentId: payment.id, agreementId: agreement.id };
  let existingInvoice = payment.accounting_invoice_id || payment.xero_invoice_id
    ? { id: payment.accounting_invoice_id || payment.xero_invoice_id,
      invoiceNumber: payment.accounting_invoice_number || payment.xero_invoice_number || null } : null;
  if (existingInvoice && payment.accounting_provider !== provider.name
    && !(provider.name === 'xero' && !payment.accounting_provider && payment.xero_invoice_id === existingInvoice.id)) {
    fail('GC_QUEUE_EXISTING_INVOICE_PROVIDER_UNPROVEN');
  }
  if (!isPerInstalmentAgreement(agreement)) {
    const historyTable = agreement.member_id ? 'member_membership_history' : 'organisation_membership_history';
    const { data: history, error } = await db.from(historyTable).select('*')
      .eq('tenant_id', agreement.tenant_id).eq('billing_agreement_id', agreement.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) fail('GC_QUEUE_HISTORY_UNAVAILABLE');
    const id = history?.accounting_invoice_id || history?.xero_invoice_id;
    if (!id) throw Object.assign(new Error('Waiting for a genuine linked membership invoice'), { code: 'GC_QUEUE_WAITING_FOR_INVOICE', retry: true });
    existingInvoice = { id, invoiceNumber: history.accounting_invoice_number || history.xero_invoice_number || null };
    Object.assign(linkage, { historyTable, historyId: history.id });
  }
  const reference = `GoCardless DD: ${payment.gocardless_payment_id}`;
  const operation = existingInvoice ? 'payment' : 'invoice';
  // Local-only context is frozen before acceptance. A local preparation failure
  // is itself retained as original evidence; it cannot escape into a legacy
  // writer or be silently rebuilt from tomorrow's catalogue on central retry.
  let context = null, preparationError = null;
  if (operation === 'invoice') {
    try {
      const resolveContext = dependencies.resolveContext
        || (await import('./membershipInstalmentInvoicing.js')).resolveInstalmentInvoiceContext;
      context = await resolveContext({ agreement, snapshot, db });
    } catch {
      preparationError = 'GC_QUEUE_LOCAL_CONTEXT_PREPARATION_FAILED';
    }
  }
  const bankSettingKey = provider.name === 'xero' ? 'xero_gocardless_bank_account_code' : 'quickbooks_gocardless_bank_account_id';
  let bankSettingValue = null;
  try {
    const { data: setting, error } = await db.from('system_settings').select('setting_value')
      .eq('tenant_id', agreement.tenant_id).eq('setting_key', bankSettingKey).maybeSingle();
    if (error) throw error;
    bankSettingValue = typeof setting?.setting_value === 'string' ? setting.setting_value.trim() : null;
  } catch { preparationError ||= 'GC_QUEUE_BANK_SETTING_CAPTURE_FAILED'; }
  const waitingForInvoice = ['Waiting for a genuine linked membership invoice',
    'waiting for invoice linked on membership history row'].includes(payment.accounting_sync_error);
  // These rows predate queue ownership. A failed legacy writer may already
  // have committed externally using a DIFFERENT provider identity. Do not
  // reinterpret its missing local link as proof that a fresh POST is safe.
  const legacyWriteUncertain = ['posting', 'failed', 'invoice_unpaid'].includes(payment.accounting_sync_status)
    && !waitingForInvoice;
  const original = { version: 1, preparation: true, environment: binding.environment || null, linkage,
    evidence: { agreement, payment, snapshot, reservation, ddAccountingMigration, context, preparationError, legacyWriteUncertain },
    invoice: { args: {
      appTenantId: agreement.tenant_id, finalCost: payment.amount_minor / 100, currency: payment.currency,
      reference: `Membership ${snapshot?.membership_year || ''} - DD instalment ${payment.gocardless_payment_id}`.trim(),
      invoiceDescription: 'Monthly membership instalment ({year})', markAsPaid: true,
      paymentReference: reference, strictBankAccount: true,
      bankAccountSettingKey: bankSettingKey,
      ddAccountingMigration, idempotencyKey: `mii-gc-${payment.gocardless_payment_id}`,
      paymentIdempotencyKey: `mii-gc-${payment.gocardless_payment_id}-pay`,
    } },
    payment: { bankSetting: { key: bankSettingKey, value: bankSettingValue },
      collection: { amountMinor: payment.amount_minor, currency: payment.currency,
      date: (payment.confirmed_at || payment.charge_date || payment.created_at)?.slice(0, 10), reference } },
    ...(existingInvoice ? { existingInvoice } : {}),
  };
  const candidate = { tenant_id: agreement.tenant_id, provider: provider.name, source_type: GO_CARDLESS_ACCOUNTING_SOURCE,
    source_id: payment.id, snapshot: original, operation };
  await assertGoCardlessAccountingSource({ db, row: candidate });
  let row;
  try {
    row = await (dependencies.enqueue || enqueueAccountingRequest)({
      db, tenantId: agreement.tenant_id, provider: provider.name, connectionId: binding.connectionId,
      companyId: binding.companyId, sourceType: GO_CARDLESS_ACCOUNTING_SOURCE, sourceId: payment.id, operation, snapshot: original,
    });
  } catch (error) {
    // A concurrent webhook/reconciliation caller or lost enqueue response may
    // already have committed the original evidence. Resume that owner, never
    // replace its payload with the newer mirror or release the old writer.
    row = await findGoCardlessAccountingRequest({ db, tenantId: agreement.tenant_id, paymentId: payment.id });
    if (!row) throw error;
  }
  return resumeGoCardlessAccountingRequest({ db, row, adapters: dependencies.adapters });
}