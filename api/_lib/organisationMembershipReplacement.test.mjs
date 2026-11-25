import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReplacementError,
  assertPeriodUnchanged,
  createOrganisationMembershipReplacementService,
  evaluateReplacementEligibility,
  normalizeReplacementOverride,
  planReplacementAccounting,
  providerCreditArgument,
  assertCreditMatchesApproved,
  attachReplacementOperations,
} from './organisationMembershipReplacement.js';
import { ORGANISATION_MEMBERSHIP_VALUE_EXCLUDED_STATUSES } from '../dashboard/_lib/organisationMembershipValue.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const ORIGINAL = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase-style client.
// ---------------------------------------------------------------------------
function createFakeDb(tables, { rpc } = {}) {
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  function builder(table) {
    const filters = [];
    let mode = 'select';
    let payload = null;
    let wantRows = false;
    const rows = () => (tables[table] ||= []);
    const match = (row) => filters.every((f) => f(row));
    const api = {
      select() { wantRows = true; return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      neq(col, val) { filters.push((r) => r[col] !== val); return api; },
      not(col, op, list) {
        const values = String(list).replace(/[()]/g, '').split(',');
        filters.push((r) => !values.includes(r[col]));
        return api;
      },
      or(expr) {
        // Only the lease predicate is used: lease_expires_at.is.null,lease_expires_at.lt.<iso>
        const m = /lease_expires_at\.lt\.(.+)$/.exec(expr);
        if (m) filters.push((r) => !r.lease_expires_at || r.lease_expires_at < m[1]);
        return api;
      },
      update(values) { mode = 'update'; payload = values; return api; },
      insert(values) { mode = 'insert'; payload = values; return api; },
      delete() { mode = 'delete'; return api; },
      order() { return api; },
      run() {
        if (mode === 'insert') {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const r of list) rows().push({ id: r.id || `row-${rows().length + 1}`, ...clone(r) });
          return { data: list, error: null };
        }
        const hit = rows().filter(match);
        if (mode === 'update') for (const r of hit) Object.assign(r, clone(payload));
        if (mode === 'delete') tables[table] = rows().filter((r) => !match(r));
        return { data: clone(hit), error: null };
      },
      maybeSingle() { const { data } = api.run(); return Promise.resolve({ data: data[0] || null, error: null }); },
      single() { const { data } = api.run(); return Promise.resolve({ data: data[0] || null, error: data[0] ? null : { message: 'not found' } }); },
      then(resolve, reject) { return Promise.resolve(api.run()).then(resolve, reject); },
    };
    return api;
  }
  return {
    tables,
    from: (table) => builder(table),
    rpc: async (name, args) => rpc(name, args, tables),
  };
}

function originalRow(overrides = {}) {
  return {
    id: ORIGINAL, tenant_id: TENANT, organization_id: ORG, status: 'active',
    membership_year: '2026/27', term_start_date: '2026-04-01', term_end_date: '2027-03-31',
    config_id: 'cfg-1', tier_label: 'Small', final_cost: 100, vat_amount: 20, total_with_vat: 120,
    currency: 'GBP', accounting_provider: 'xero', accounting_invoice_id: 'inv-orig', accounting_invoice_number: 'INV-1',
    purchase_order_number: 'PO-9', payment_status: 'unpaid',
    ...overrides,
  };
}

function eligibilityFacts(overrides = {}) {
  return {
    currentYearLabel: '2026/27', activeCollectionPlan: false, hasTrainingFundAddons: false, addonTotal: 0,
    existingOperation: false, activeProvider: 'xero',
    originalInvoice: { status: 'unpaid', totalAmt: 120, balance: 120, raw: { Status: 'AUTHORISED', AmountCredited: 0 } },
    ...overrides,
  };
}

// The RPC fake mirrors the migration: retire the original, create a linked
// replacement with copied period, and journal an operation row.
function applyRpc(name, args, tables) {
  assert.equal(name, 'apply_organisation_membership_replacement');
  const ops = (tables.organisation_membership_replacement ||= []);
  const prior = ops.find((op) => op.idempotency_key === args.p_idempotency_key);
  if (prior) return { data: { operation_id: prior.id, replayed: true }, error: null };
  if (ops.some((op) => op.source_record_id === args.p_source_record_id)) {
    return { data: null, error: { code: 'PT409', message: 'already replaced' } };
  }
  const original = tables.organisation_membership_history.find((r) => r.id === args.p_source_record_id);
  const p = args.p_payload;
  for (const key of ['membership_year', 'term_start_date', 'term_end_date']) {
    if (p.period[key] !== original[key]) return { data: null, error: { code: '22023', message: 'period changed' } };
  }
  const targetId = `target-${ops.length + 1}`;
  tables.organisation_membership_history.push({
    ...p.history, id: targetId, tenant_id: original.tenant_id, organization_id: original.organization_id,
    status: 'active', membership_year: original.membership_year, term_start_date: original.term_start_date,
    term_end_date: original.term_end_date, purchase_order_number: original.purchase_order_number, replaces_record_id: original.id,
  });
  Object.assign(original, { status: 'replaced', replaced_by_record_id: targetId });
  const op = {
    id: `op-${ops.length + 1}`, tenant_id: original.tenant_id, organization_id: original.organization_id,
    source_record_id: original.id, target_record_id: targetId, idempotency_key: args.p_idempotency_key,
    membership_year: original.membership_year, reason: args.p_reason, actor_id: args.p_actor_id,
    accounting_provider: p.accounting_provider, original_invoice_id: original.accounting_invoice_id,
    original_invoice_number: original.accounting_invoice_number, original_total: p.original_total,
    original_paid: p.original_paid, replacement_total: p.replacement_total, addon_lines: p.addon_lines,
    invoice_snapshot: p.invoice_snapshot, credit_note_state: p.credit_note_state, invoice_state: p.invoice_state,
    allocation_state: p.allocation_state, email_state: p.email_state, sync_state: 'pending', attempts: 0,
  };
  ops.push(op);
  return { data: { operation_id: op.id, replayed: false }, error: null };
}

function createProvider({ invoice, failInvoiceTimes = 0 } = {}) {
  const calls = { creditNotes: [], invoices: [], allocations: [] };
  let invoiceFailures = failInvoiceTimes;
  const provider = {
    name: 'xero',
    calls,
    async fetchInvoiceStatus() { return invoice; },
    async createCreditNote(args) {
      calls.creditNotes.push(args);
      return { creditNoteId: 'cn-1', creditNoteNumber: 'CN-1', amount: args.creditAmount };
    },
    async createMembershipInvoice(args) {
      calls.invoices.push(args);
      if (invoiceFailures > 0) { invoiceFailures -= 1; throw new Error('Xero is unavailable'); }
      return { provider: 'xero', invoiceId: 'inv-new', invoiceNumber: 'INV-2' };
    },
    async allocateCreditNoteToInvoice(args) {
      calls.allocations.push(args);
      return { amount: args.amount };
    },
  };
  return provider;
}

function createService({ db, provider, sim = {}, emails = [], deps = {}, simCalls = [] }) {
  return createOrganisationMembershipReplacementService({
    db,
    simulate: async (...args) => (simCalls.push(args), {
      success: true, membershipYear: { label: '2026/27' }, config: { id: 'cfg-2' }, tierLabel: 'Large',
      annualCost: 200, finalCost: 200, vatAmount: 40, totalWithVat: 240, currency: 'GBP', ...sim,
    }),
    getConfig: async () => ({ id: 'cfg-1' }),
    currentYearLabel: () => '2026/27',
    getActiveProvider: async () => provider,
    getProviderByName: () => provider,
    hasActiveCollectionPlan: async () => false,
    loadApprovedAddonLines: async () => [],
    getAddonSettings: async () => ({ addons_enabled: true, addon_freeform_enabled: true }),
    sendInvoiceEmail: async (args) => { emails.push(args); return { success: true }; },
    resolveInvoiceAddress: async () => null,
    resolveNominalCode: async () => '200',
    randomUUID: (() => { let n = 0; return () => `lease-${++n}`; })(),
    ...deps,
  });
}

// ---------------------------------------------------------------------------

test('eligibility blockers', () => {
  const ok = evaluateReplacementEligibility(originalRow(), eligibilityFacts());
  assert.equal(ok.eligible, true);
  const cases = [
    [originalRow({ status: 'replaced' }), {}, 'already_replaced'],
    [originalRow({ status: 'cancelled' }), {}, 'cancelled'],
    [originalRow({ status: 'scheduled' }), {}, 'not_recorded'],
    [originalRow({ membership_year: '2025/26' }), {}, 'not_current_year'],
    [originalRow({ term_key: 'rolling-1' }), {}, 'rolling_term'],
    [originalRow({ billing_agreement_id: 'ba-1' }), {}, 'collection_plan_active'],
    [originalRow(), { activeCollectionPlan: true }, 'collection_plan_active'],
    [originalRow(), { existingOperation: true }, 'already_replaced'],
    [originalRow({ accounting_invoice_id: null }), {}, 'invoice_not_synced'],
    [originalRow({ accounting_sync_status: 'failed' }), {}, 'invoice_not_synced'],
    [originalRow(), { activeProvider: 'quickbooks' }, 'provider_mismatch'],
    [originalRow(), { originalInvoice: { status: 'voided', raw: {} } }, 'invoice_voided'],
    [originalRow(), { originalInvoice: { status: 'unpaid', raw: { Status: 'DRAFT' } } }, 'invoice_draft'],
    [originalRow(), { hasTrainingFundAddons: true }, 'training_fund_addons'],
  ];
  for (const [row, facts, code] of cases) {
    assert.equal(evaluateReplacementEligibility(row, eligibilityFacts(facts)).code, code, code);
  }
  // Zero-value original without invoice is allowed (no credit note).
  const zero = originalRow({ accounting_invoice_id: null, final_cost: 0, total_with_vat: 0 });
  assert.equal(evaluateReplacementEligibility(zero, eligibilityFacts({ originalInvoice: null })).eligible, true);
});

test('period is immutable', () => {
  const row = originalRow();
  assert.doesNotThrow(() => assertPeriodUnchanged(row, { membershipYear: '2026/27', termStartDate: '2026-04-01', termEndDate: '2027-03-31' }));
  for (const changed of [{ membershipYear: '2027/28' }, { termStartDate: '2026-05-01' }, { termEndDate: '2027-04-30' }]) {
    assert.throws(() => assertPeriodUnchanged(row, changed), (e) => e instanceof ReplacementError && e.code === 'period_locked');
  }
  assert.throws(() => normalizeReplacementOverride({ overrideType: 'discount', discountType: 'percentage', discountValue: 120 }));
  assert.deepEqual(normalizeReplacementOverride({ overrideType: 'price', manualPrice: '50' }).manual_price, 50);
});

test('allocation plans: unpaid, part-paid, paid and surplus', () => {
  assert.deepEqual(planReplacementAccounting({ originalTotal: 120, originalPaid: 0, replacementTotal: 240, hasOriginalInvoice: true }),
    { creditAmount: 120, allocateToOriginal: 120, allocateToReplacement: 0, replacementInvoiceAmount: 240, amountDue: 240, surplusCredit: 0 });
  assert.deepEqual(planReplacementAccounting({ originalTotal: 120, originalPaid: 50, replacementTotal: 240, hasOriginalInvoice: true }),
    { creditAmount: 120, allocateToOriginal: 70, allocateToReplacement: 50, replacementInvoiceAmount: 240, amountDue: 190, surplusCredit: 0 });
  assert.deepEqual(planReplacementAccounting({ originalTotal: 120, originalPaid: 120, replacementTotal: 240, hasOriginalInvoice: true }),
    { creditAmount: 120, allocateToOriginal: 0, allocateToReplacement: 120, replacementInvoiceAmount: 240, amountDue: 120, surplusCredit: 0 });
  assert.deepEqual(planReplacementAccounting({ originalTotal: 120, originalPaid: 120, replacementTotal: 60, hasOriginalInvoice: true }),
    { creditAmount: 120, allocateToOriginal: 0, allocateToReplacement: 60, replacementInvoiceAmount: 60, amountDue: 0, surplusCredit: 60 });
  assert.equal(planReplacementAccounting({ originalTotal: 0, originalPaid: 0, replacementTotal: 60, hasOriginalInvoice: false }).creditAmount, 0);
  // QuickBooks credit lines are net unless the invoice is tax inclusive.
  assert.equal(providerCreditArgument('quickbooks', { totalAmt: 120, raw: { TxnTaxDetail: { TotalTax: 20 } } }), 100);
  assert.equal(providerCreditArgument('quickbooks', { totalAmt: 120, raw: { GlobalTaxCalculation: 'TaxInclusive' } }), 120);
  assert.equal(providerCreditArgument('xero', { totalAmt: 120 }), 120);
});

test('execute rejects period changes before writing anything', async () => {
  const db = createFakeDb({ organisation_membership_history: [originalRow()] }, { rpc: applyRpc });
  const service = createService({ db, provider: createProvider({ invoice: eligibilityFacts().originalInvoice }) });
  await assert.rejects(service.execute({
    tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null, reason: 'Wrong tier', actorId: 'admin-1',
    idempotencyKey: 'key-aaaaaaaa', period: { termEndDate: '2027-06-30' },
  }), (e) => e.code === 'period_locked');
  assert.equal(db.tables.organisation_membership_replacement?.length ?? 0, 0);
  assert.equal(db.tables.organisation_membership_history.length, 1);
});

test('part-paid replacement: provider failure then retry never duplicates documents', async () => {
  const invoice = { status: 'partial', totalAmt: 120, balance: 70, raw: { Status: 'AUTHORISED', AmountCredited: 0 } };
  const provider = createProvider({ invoice, failInvoiceTimes: 1 });
  const emails = [];
  const db = createFakeDb({ organisation_membership_history: [originalRow({ payment_status: 'partial' })],
    organization: [{ id: ORG, tenant_id: TENANT, name: 'Acme', invoicing_email: 'finance@example.test' }] }, { rpc: applyRpc });
  const service = createService({ db, provider, emails });

  const preview = await service.preview({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null });
  assert.equal(preview.replacement.termStartDate, '2026-04-01');
  assert.equal(preview.replacement.termEndDate, '2027-03-31');
  assert.equal(preview.accounting.creditNoteAmount, 120);
  assert.equal(preview.accounting.paidCreditToApply, 50);
  assert.equal(preview.accounting.amountDue, 190);

  const first = await service.execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null,
    reason: 'Wrong tier', actorId: 'admin-1', idempotencyKey: 'key-bbbbbbbb' });
  assert.equal(first.operation.sync_state, 'failed');
  assert.equal(first.operation.credit_note_state, 'done');
  assert.equal(first.operation.invoice_state, 'failed');
  assert.match(first.operation.last_error, /Xero is unavailable/);
  const original = db.tables.organisation_membership_history.find((r) => r.id === ORIGINAL);
  assert.equal(original.status, 'replaced');
  assert.equal(original.accounting_credit_note_number, 'CN-1');
  assert.equal(original.accounting_invoice_number, 'INV-1', 'original keeps its invoice');

  // Same request replayed (double click) resumes the same operation.
  const replay = await service.execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null,
    reason: 'Wrong tier', actorId: 'admin-1', idempotencyKey: 'key-bbbbbbbb' });
  assert.equal(replay.replayed, true);
  assert.equal(db.tables.organisation_membership_replacement.length, 1);
  assert.equal(replay.operation.sync_state, 'complete');

  // A further retry is a no-op once complete.
  await service.retry({ tenantId: TENANT, organizationId: ORG, operationId: replay.operation.id });

  assert.equal(provider.calls.creditNotes.length, 1, 'one credit note');
  assert.equal(provider.calls.invoices.filter((c) => c.idempotencyKey === `omr-inv-${replay.operation.id}`).length, 2,
    'invoice attempts share one idempotency key');
  assert.equal(provider.calls.invoices.length, 2, 'one failed attempt, one success');
  assert.equal(provider.calls.invoices[1].reference, 'Membership 2026/27 - PO: PO-9');
  assert.deepEqual(provider.calls.allocations.map((a) => [a.invoiceId, a.amount]), [['inv-orig', 70], ['inv-new', 50]]);
  assert.equal(emails.length, 1);

  const target = db.tables.organisation_membership_history.find((r) => r.replaces_record_id === ORIGINAL);
  assert.equal(target.term_start_date, original.term_start_date);
  assert.equal(target.membership_year, original.membership_year);
  assert.equal(target.accounting_invoice_number, 'INV-2');
  assert.equal(target.payment_status, 'partial');

  // A second, different request cannot replace the same year again.
  await assert.rejects(service.execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null,
    reason: 'Again', actorId: 'admin-1', idempotencyKey: 'key-cccccccc' }), (e) => e.code === 'already_replaced');
});

test('unpaid original: credit clears it and no paid credit moves', async () => {
  const invoice = { status: 'unpaid', totalAmt: 120, balance: 120, raw: { Status: 'AUTHORISED', AmountCredited: 0 } };
  const provider = createProvider({ invoice });
  const db = createFakeDb({ organisation_membership_history: [originalRow()],
    organization: [{ id: ORG, tenant_id: TENANT, name: 'Acme' }] }, { rpc: applyRpc });
  const result = await createService({ db, provider }).execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL,
    override: null, reason: 'Discount agreed', actorId: 'admin-1', idempotencyKey: 'key-dddddddd' });
  assert.equal(result.operation.sync_state, 'complete');
  assert.deepEqual(provider.calls.allocations.map((a) => [a.invoiceId, a.amount]), [['inv-orig', 120]]);
});

test('zero-value original without an invoice gets no credit note', async () => {
  const provider = createProvider({ invoice: null });
  const db = createFakeDb({ organisation_membership_history: [originalRow({ accounting_invoice_id: null, accounting_invoice_number: null, final_cost: 0, total_with_vat: 0 })],
    organization: [{ id: ORG, tenant_id: TENANT, name: 'Acme' }] }, { rpc: applyRpc });
  const result = await createService({ db, provider }).execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL,
    override: null, reason: 'Now paying', actorId: 'admin-1', idempotencyKey: 'key-eeeeeeee' });
  assert.equal(result.operation.credit_note_state, 'not_required');
  assert.equal(provider.calls.creditNotes.length, 0);
  assert.equal(provider.calls.invoices.length, 1);
});

test('downstream readers ignore replaced rows', async () => {
  assert.ok(ORGANISATION_MEMBERSHIP_VALUE_EXCLUDED_STATUSES.includes('replaced'));
  const { reconcileRow, fireWorkflowForPaidRow } = await import('./membershipPaymentReconciliation.js');
  const result = await reconcileRow({ table: 'organisation_membership_history', row: originalRow({ status: 'replaced' }) },
    { fetchStatus: async () => { throw new Error('must not query the provider'); } });
  assert.match(JSON.stringify(result), /replaced/);
  const fired = await fireWorkflowForPaidRow({ table: 'organisation_membership_history', row: originalRow({ status: 'replaced' }) },
    { trigger: async () => { throw new Error('must not fire'); } });
  assert.equal(fired.fired, false);
});

test('QuickBooks: mixed VAT invoices and prior credits block replacement', () => {
  const qboInvoice = (raw) => ({ status: 'unpaid', totalAmt: 220, balance: 220, raw });
  const row = originalRow({ accounting_provider: 'quickbooks' });
  const mixed = qboInvoice({ Line: [
    { DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { TaxCodeRef: { value: '20' } } },
    { DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { TaxCodeRef: { value: '0' } } },
    { DetailType: 'SubTotalLineDetail', Amount: 200 },
  ] });
  assert.equal(evaluateReplacementEligibility(row, eligibilityFacts({ activeProvider: 'quickbooks', originalInvoice: mixed })).code, 'mixed_tax_invoice');
  const single = qboInvoice({ Line: [{ DetailType: 'SalesItemLineDetail', Amount: 100, SalesItemLineDetail: { TaxCodeRef: { value: '20' } } }] });
  assert.equal(evaluateReplacementEligibility(row, eligibilityFacts({ activeProvider: 'quickbooks', originalInvoice: single })).eligible, true);
  assert.equal(evaluateReplacementEligibility(row, eligibilityFacts({ activeProvider: 'quickbooks', originalInvoice: single, priorCredits: 'present' })).code, 'already_credited');
  assert.equal(evaluateReplacementEligibility(row, eligibilityFacts({ activeProvider: 'quickbooks', originalInvoice: single, priorCredits: 'unavailable' })).code, 'credit_evidence_unavailable');
});

test('QuickBooks prior credit discovery: applied memo, discovery failure, and clean invoice', async () => {
  const base = { status: 'unpaid', totalAmt: 120, balance: 120, raw: { Line: [{ DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { TaxCodeRef: { value: '20' } } }] } };
  const run = async (invoice, readInvoiceCreditEvidence) => {
    const db = createFakeDb({ organisation_membership_history: [originalRow({ accounting_provider: 'quickbooks' })] });
    const provider = { ...createProvider({ invoice }), name: 'quickbooks' };
    const service = createService({ db, provider, deps: { readInvoiceCreditEvidence } });
    return service.preview({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null }).then(() => 'ok', (e) => e.code);
  };
  assert.equal(await run(base, async () => ({ notes: [{ providerId: 'cm-1', status: 'AUTHORISED' }] })), 'already_credited');
  assert.equal(await run(base, async () => { throw new Error('QBO down'); }), 'credit_evidence_unavailable');
  assert.equal(await run({ ...base, raw: { ...base.raw, LinkedTxn: [{ TxnType: 'CreditMemo', TxnId: '9' }] } }, async () => ({ notes: [] })), 'already_credited');
  assert.equal(await run(base, async () => ({ notes: [{ providerId: 'cm-0', status: 'VOIDED' }] })), 'ok');
});

test('credit note must equal the approved gross; a mismatch never allocates and retry never duplicates', async () => {
  const invoice = eligibilityFacts().originalInvoice;
  const db = createFakeDb({ organisation_membership_history: [originalRow()], organization: [{ id: ORG, tenant_id: TENANT, name: 'Org' }] }, { rpc: applyRpc });
  const provider = createProvider({ invoice });
  let creates = 0;
  provider.createCreditNote = async (args) => {
    provider.calls.creditNotes.push(args);
    creates += 1;
    // Provider rediscovers the same document by reference on retry.
    return { creditNoteId: 'cn-1', creditNoteNumber: 'CN-1', amount: 144 };
  };
  const service = createService({ db, provider });
  const { operation } = await service.execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null,
    reason: 'Wrong tier', actorId: 'admin-1', idempotencyKey: 'key-mismatch',
    period: { membershipYear: '2026/27', termStartDate: '2026-04-01', termEndDate: '2027-03-31' } });
  assert.equal(operation.credit_note_state, 'failed');
  assert.match(operation.last_error, /does not match the original invoice total/);
  assert.equal(provider.calls.allocations.length, 0);
  assert.equal(provider.calls.invoices.length, 0);
  assert.equal(db.tables.organisation_membership_history.find((r) => r.id === ORIGINAL).accounting_credit_note_id, undefined);
  const again = await service.retry({ tenantId: TENANT, organizationId: ORG, operationId: operation.id });
  assert.equal(again.credit_note_state, 'failed');
  assert.equal(provider.calls.allocations.length, 0);
  assert.equal(creates, 2);
  assert.throws(() => assertCreditMatchesApproved({ amount: null }, 120));
  assert.doesNotThrow(() => assertCreditMatchesApproved({ amount: 120.004 }, 120));
});

test('replacement history stores add-on-inclusive totals while the invoice line stays membership-only', async () => {
  const addon = { type: 'freeform', description: 'Extra seat', unit_cost: 50, quantity: 1, line_total: 50, nominal_code: '210', vat_rate: { effectiveRate: 20 } };
  const db = createFakeDb({ organisation_membership_history: [originalRow()], organization: [{ id: ORG, tenant_id: TENANT, name: 'Org' }] }, { rpc: applyRpc });
  const provider = createProvider({ invoice: eligibilityFacts().originalInvoice });
  const simCalls = [];
  const service = createService({ db, provider, simCalls, deps: { loadApprovedAddonLines: async () => [addon] } });
  const preview = await service.preview({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null });
  assert.equal(preview.replacement.total, 300); // 240 membership + 60 add-on
  assert.equal(simCalls[0][2].replacementOfRecordId, ORIGINAL);
  await service.execute({ tenantId: TENANT, organizationId: ORG, recordId: ORIGINAL, override: null,
    reason: 'Add seat', actorId: 'admin-1', idempotencyKey: 'key-addons',
    period: { membershipYear: '2026/27', termStartDate: '2026-04-01', termEndDate: '2027-03-31' } });
  const target = db.tables.organisation_membership_history.find((r) => r.replaces_record_id === ORIGINAL);
  assert.equal(target.final_cost, 250);
  assert.equal(target.vat_amount, 50);
  assert.equal(target.total_with_vat, 300);
  assert.equal(provider.calls.invoices.length, 1);
  assert.equal(provider.calls.invoices[0].finalCost, 200);
  assert.equal(provider.calls.invoices[0].extraLineItems.length, 1);
});

test('interrupted sync with an expired lease is presented as resumable and resumes', async () => {
  const db = createFakeDb({
    organisation_membership_history: [originalRow({ status: 'replaced', replaced_by_record_id: 'target-1' }),
      { id: 'target-1', tenant_id: TENANT, organization_id: ORG, replaces_record_id: ORIGINAL, membership_year: '2026/27', final_cost: 200, total_with_vat: 240, currency: 'GBP' }],
    organization: [{ id: ORG, tenant_id: TENANT, name: 'Org' }],
    organisation_membership_replacement: [{
      id: 'op-1', tenant_id: TENANT, organization_id: ORG, source_record_id: ORIGINAL, target_record_id: 'target-1',
      membership_year: '2026/27', accounting_provider: 'xero', original_invoice_id: 'inv-orig', original_total: 120, original_paid: 0,
      replacement_total: 240, addon_lines: [], invoice_snapshot: { membershipFinalCost: 200 },
      credit_note_state: 'pending', invoice_state: 'pending', allocation_state: 'pending', email_state: 'pending',
      sync_state: 'in_progress', lease_token: 'dead-worker', lease_expires_at: '2000-01-01T00:00:00.000Z', attempts: 1,
    }],
  });
  const rows = JSON.parse(JSON.stringify(db.tables.organisation_membership_history));
  await attachReplacementOperations(db, TENANT, rows);
  const op = rows.find((r) => r.id === 'target-1').replacement_operation;
  assert.equal(op.resumable, true);
  assert.equal(op.stalled, true);
  assert.equal('lease_expires_at' in op, false);
  const { replacementSyncStatus } = await import('../../client/src/components/membership/replacementSyncStatus.js');
  const view = replacementSyncStatus(op);
  assert.equal(view.canRetry, true);
  assert.equal(view.label, 'interrupted');
  assert.equal(replacementSyncStatus({ sync_state: 'in_progress', resumable: false }).canRetry, false);
  assert.equal(replacementSyncStatus({ sync_state: 'complete' }), null);

  const provider = createProvider({ invoice: eligibilityFacts().originalInvoice });
  const service = createService({ db, provider });
  const resumed = await service.retry({ tenantId: TENANT, organizationId: ORG, operationId: 'op-1' });
  assert.equal(resumed.sync_state, 'complete');
  assert.equal(provider.calls.creditNotes.length, 1);
  assert.equal(provider.calls.invoices.length, 1);
});

test('existing approved add-on lines open ready to preview', async () => {
  const { toEditorLine } = await import('../../client/src/components/membership/addonLineShape.js');
  const line = toEditorLine({ type: 'freeform', description: 'Seat', unit_cost: 50, quantity: 2, nominal_code: '210', vat_rate: { effectiveRate: 20 } });
  assert.equal(line.unitCost, '50');
  assert.equal(line.nominalCode, '210');
  assert.deepEqual(line.vatRate, { effectiveRate: 20 });
  assert.equal(line.quantity, '2');
});
