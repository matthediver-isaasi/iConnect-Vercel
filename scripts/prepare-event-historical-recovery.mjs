#!/usr/bin/env node
// Default: offline review only. Private evidence/plan files MUST remain under /tmp.
// --capture --out /tmp/evidence.json performs bounded GET/read-only inspection.
// --evidence /tmp/evidence.json --out /tmp/plan.json prints the reviewed plan hash.
// --apply --evidence /tmp/evidence.json --out /tmp/result.json --review-sha256=...
// Apply never calls Xero writes directly: admission authority + existing worker only.
import { createHash } from 'node:crypto';
import { readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { destinationConnection } from './run-bnms-dd-pilot-history.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { capturedEventSettlement } from '../api/_lib/eventInvoiceProducer.js';
import { validRecoverySnapshot, recoveryIdentity, processEventInvoiceRecovery,
  approveHistoricalEventInvoiceRecovery, resolveHistoricalEventInvoiceRecovery } from '../api/_lib/eventInvoiceRecovery.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const EVENT = '20bae95f-3b24-45f8-bd6b-b984cdbee3cf';
export const TARGETS = Object.freeze([
  { id: '01e349e2-9ae5-49e6-9ec8-95a47a1b3b9f', group: 'OOE-1790198684011-DC5F1', pi: 'pi_3UIxe10UfSpC8b2b064ihJr0', member: '1c8ae6bc-6e50-406a-8eee-b48c7e0bd1ce', guest: false },
  { id: 'b09afeb8-0955-4c3d-9636-35aa543a9f5a', group: 'OOE-1790198918339-82WJL', pi: 'pi_3UIxi50UfSpC8b2b1z2RZruQ', member: null, guest: true },
]);
export const ACCOUNT = '33bd8a94-b20d-48fc-8f87-76656c02426f';
export const TEST_PIS = ['pi_3UI4SU0Ku8P2LW360YyrobBX', 'pi_3UI58T0Ku8P2LW3604t5CQhL'];
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const fail = code => { throw new Error(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const day = value => new Date(value).toISOString().slice(0, 10);
const plus30 = value => day(Date.parse(value) + 30 * 86400000);
const privatePath = value => {
  const path = resolve(value || '');
  if (dirname(path) !== '/tmp') fail('private_tmp_path_required');
  return path;
};
export function parseArgs(args) {
  const opts = { capture: false, apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--capture', '--apply'].includes(arg) && !opts[arg.slice(2)]) opts[arg.slice(2)] = true;
    else if (/^--review-sha256=[a-f0-9]{64}$/.test(arg) && !opts.review) opts.review = arg.split('=')[1];
    else if (['--evidence', '--out'].includes(arg) && !opts[arg.slice(2)] && args[i + 1] && !args[i + 1].startsWith('--')) opts[arg.slice(2)] = privatePath(args[++i]);
    else fail('unsupported_or_duplicate_argument');
  }
  if (!opts.out || (opts.capture && (opts.apply || opts.evidence || opts.review))
    || (!opts.capture && !opts.evidence) || (opts.apply && !opts.review) || (!opts.apply && opts.review)) fail('invalid_mode_or_missing_review_hash');
  if (opts.out === opts.evidence) fail('output_must_not_overwrite_evidence');
  return opts;
}
export function bookingFingerprint(b) {
  // Mirrors an exact frozen booking, excluding only recovery worker's own mirrors.
  const copy = { ...b };
  delete copy.invoice_recovery_status;
  delete copy.invoice_recovery_next_attempt_at;
  return hash(copy);
}
export function verifiedPurchaser(target, b, pi, members) {
  const customer = pi.customer;
  if (!customer || typeof customer !== 'object' || !customer.id || customer.deleted || customer.livemode !== true
    || customer.metadata?.tenant_id !== TENANT) fail('verified_live_stripe_customer_required');
  const payerEmails = [pi.receipt_email, pi.latest_charge?.receipt_email,
    pi.latest_charge?.billing_details?.email, customer.email].map(email).filter(Boolean);
  if (!payerEmails.length || new Set(payerEmails).size !== 1) fail('stripe_payer_email_missing_or_conflicting');
  if (pi.metadata?.tenant_id !== TENANT || pi.metadata?.event_id !== EVENT) fail('stripe_tenant_event_binding_mismatch');
  if (!target.guest) {
    const member = members.find(m => m.id === target.member && m.tenant_id === TENANT);
    if (!member || b.member_id !== member.id || email(pi.metadata?.member_email) !== email(member.email)
      || pi.metadata?.is_guest !== 'false'
      || (pi.metadata?.member_id && pi.metadata.member_id !== member.id)
      || (customer.metadata?.member_id && customer.metadata.member_id !== member.id)
      || email(member.email) !== payerEmails[0]
      || (member.stripe_customer_id && member.stripe_customer_id !== customer.id)) fail('original_member_purchaser_not_verified');
    const name = `${member.first_name || ''} ${member.last_name || ''}`.trim();
    if (!name) fail('original_member_purchaser_name_missing');
    return { name, email: payerEmails[0], provenance: { kind: 'historical_member_verified_stripe_payer',
      memberId: member.id, customerId: customer.id, paymentIntentId: pi.id, evidence: 'booking booker member ID; PI member_email/is_guest metadata and live customer/payer-email agreement; not attendee selection' } };
  }
  if (b.member_id || pi.metadata?.member_id || pi.metadata?.is_guest !== 'true') fail('guest_purchaser_binding_conflict');
  const name = customer.name || pi.latest_charge?.billing_details?.name || payerEmails[0];
  return { name: name.trim(), email: payerEmails[0], provenance: { kind: 'historical_guest_verified_stripe_payer',
    customerId: customer.id, paymentIntentId: pi.id,
    evidence: 'Stripe receipt/customer/billing payer-email agreement; attendee not used; absent verified payer name uses payer email as Xero contact display name' } };
}
export function buildPlan(e) {
  if (e.version !== 1 || e.tenantId !== TENANT || e.eventId !== EVENT
    || !Number.isFinite(Date.parse(e.observedAt))) fail('evidence_scope_invalid');
  if (!e.provider?.connectionId || !e.provider.xeroTenantId
    || !e.connections?.some(c => c.tenantId === e.provider.xeroTenantId)) fail('current_xero_connection_not_verified');
  if (e.settings?.xero_invoice_enabled !== 'true' || e.activeProvider !== 'xero'
    || e.settings.xero_sales_account_code !== '210') fail('active_xero_sales_mapping_mismatch');
  const bankCode = e.settings.xero_stripe_bank_account_code;
  const bank = e.accounts?.filter(a => a.Code === bankCode);
  if (!bankCode || bank?.length !== 1 || bank[0].Status !== 'ACTIVE' || bank[0].CurrencyCode !== 'GBP'
    || (bank[0].Type !== 'BANK' && bank[0].EnablePaymentsToAccount !== true)) fail('existing_stripe_bank_mapping_not_verified');
  const sales = e.accounts.filter(a => a.Code === '210');
  if (sales.length !== 1 || sales[0].Status !== 'ACTIVE') fail('sales210_not_verified');
  const vat = e.taxRates?.filter(t => t.TaxType === 'OUTPUT2' && t.Status === 'ACTIVE');
  if (vat?.length !== 1 || Number(vat[0].EffectiveRate) !== 20) fail('current_OUTPUT2_20_percent_not_verified');
  const rows = TARGETS.map(target => {
    const matches = e.bookings?.filter(b => b.id === target.id);
    const b = matches?.[0];
    if (matches?.length !== 1 || b.tenant_id !== TENANT || b.event_id !== EVENT
      || b.booking_group_reference !== target.group || b.status !== 'confirmed' || b.payment_method !== 'card'
      || b.stripe_payment_intent_id !== target.pi || !!b.is_guest_booking !== target.guest
      || Number(b.total_cost) !== 166.67 || Number(b.ticket_price) !== 166.67
      || Number(b.account_amount || 0) !== 0 || b.member_id !== target.member
      || e.bookings.filter(x => x.booking_group_reference === target.group).length !== 1) fail('exact_card_booking_invariant_failed');
    if (b.xero_invoice_id || b.accounting_invoice_id) fail('booking_already_has_invoice_requires_review');
    const pis = e.paymentIntents?.filter(p => p.id === target.pi);
    const pi = pis?.[0];
    if (pis?.length !== 1 || pi.livemode !== true || pi.latest_charge?.livemode !== true) fail('exact_live_pi_required');
    const contact = verifiedPurchaser(target, b, pi, e.members || []);
    const settlement = { ...capturedEventSettlement({ paymentIntent: pi, paymentIntentId: target.pi,
      amount: 166.67, currency: 'GBP', accountCode: bankCode, eventId: EVENT }), livemode: true };
    const date = day(settlement.paidAt);
    const snapshot = {
      version: 1, provider: e.provider, contact, amount: 166.67, currency: 'GBP',
      paymentMethod: 'stripe', checkoutPaymentMethod: 'card', purchaseOrderNumber: b.purchase_order_number || null,
      poToFollow: false, settlement,
      historicalReview: { kind: 'explicit_user_approved_reconstruction', immutableCheckoutEvidence: false,
        approval: 'User approved only these two live card receipts: GBP166.67 VAT-inclusive, fully paid.',
        taxProvenance: 'User-approved inclusive treatment; current verified OUTPUT2 20% mapping, NOT immutable historical checkout tax.',
        dateProvenance: 'Invoice issue date reconstructed from verified automatic captured charge date; due date +30 days; hash review required.',
        purchaserProvenance: contact.provenance },
      legacyDiscovery: { version: 1, fromDate: day(b.created_at), toDate: day(e.observedAt) },
      invoice: { Type: 'ACCREC', Contact: { Name: contact.name, EmailAddress: contact.email },
        Date: date, DueDate: plus30(settlement.paidAt), CurrencyCode: 'GBP', LineAmountTypes: 'Inclusive',
        Status: 'AUTHORISED', Reference: b.purchase_order_number || 'TBC',
        LineItems: [{ Description: `Historical event recovery ${EVENT}; booking ${target.group}; Stripe: ${target.pi}`,
          Quantity: 1, UnitAmount: 166.67, AccountCode: '210', TaxType: 'OUTPUT2', TaxAmount: 27.78 }] },
    };
    const windowDays = (Date.parse(snapshot.legacyDiscovery.toDate) - Date.parse(snapshot.legacyDiscovery.fromDate)) / 86400000;
    if (windowDays < 0 || windowDays > 366 || !validRecoverySnapshot(snapshot)) fail('reconstructed_snapshot_invalid');
    const candidates = e.candidates?.filter(c => c.tenantId === TENANT && c.source === 'booking' && c.bookingGroupReference === target.group) || [];
    if (candidates.length > 1) fail('historical_candidate_ambiguous');
    return { bookingId: target.id, bookingGroupReference: target.group, expectedBookingHash: bookingFingerprint(b),
      candidate: candidates[0] || null,
      operationIdentity: recoveryIdentity(TENANT, 'booking', target.group), snapshot };
  });
  const account = e.bookings?.find(b => b.id === ACCOUNT);
  if (!account || account.tenant_id !== TENANT || account.event_id !== EVENT
    || account.booking_group_reference !== 'OOE-1790858488719-1I8XH' || account.payment_method !== 'account'
    || account.status !== 'confirmed' || Number(account.total_cost) !== 200 || Number(account.account_amount) !== 200
    || !account.organization_id || account.po_to_follow !== true) fail('account_booking_preservation_invariant_failed');
  const plan = { version: 1, tenantId: TENANT, eventId: EVENT, source: 'booking', provider: e.provider,
    rows, blocked: [{ bookingId: ACCOUNT, amountPayable: 200, settlement: null,
      reason: 'Historical account VAT basis/rate/amount not established. Current OUTPUT2 is not historical evidence; explicit account tax policy approval or authentic history required. Original Xero contact search HTTP429 is not invoice absence evidence.' }],
    excludedTestPaymentIntents: TEST_PIS, accountBookingHash: bookingFingerprint(account),
    evidenceHash: hash(e), execution: 'Historical authority admission then existing fenced processor; no alternate Xero writer' };
  return { ...plan, reviewSha256: hash(plan) };
}

// No credentials, PI client_secret, PAN, address, or provider response errors are persisted.
function safePi(pi) {
  const customer = pi.customer;
  const charge = pi.latest_charge;
  return { id: pi.id, status: pi.status, livemode: pi.livemode, amount: pi.amount,
    amount_received: pi.amount_received, currency: pi.currency, capture_method: pi.capture_method,
    receipt_email: pi.receipt_email, metadata: Object.fromEntries(['tenant_id', 'event_id', 'member_id', 'member_email', 'is_guest'].filter(k => pi.metadata?.[k]).map(k => [k, pi.metadata[k]])),
    customer: typeof customer === 'object' && customer ? { id: customer.id, deleted: customer.deleted,
      livemode: customer.livemode, email: customer.email, name: customer.name,
      metadata: Object.fromEntries(['tenant_id', 'member_id'].filter(k => customer.metadata?.[k]).map(k => [k, customer.metadata[k]])) } : customer,
    latest_charge: typeof charge === 'object' && charge ? Object.fromEntries([
      'id', 'status', 'livemode', 'paid', 'captured', 'refunded', 'amount_refunded', 'amount_captured',
      'currency', 'payment_intent', 'created', 'receipt_email',
    ].map(k => [k, charge[k]]).concat([['billing_details', { name: charge.billing_details?.name, email: charge.billing_details?.email }]])) : charge };
}
export async function captureEvidence(env = process.env) {
  destinationTarget(env);
  const c = await destinationConnection(env);
  let state;
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='10s'");
    const tenant = (await c.query('SELECT name FROM tenant WHERE id=$1', [TENANT])).rows;
    if (tenant.length !== 1 || !/bnms|british nuclear medicine society/i.test(tenant[0].name)) fail('tenant_identity_mismatch');
    const bookings = (await c.query('SELECT to_jsonb(b) AS b FROM booking b WHERE tenant_id=$1 AND event_id=$2 ORDER BY id', [TENANT, EVENT])).rows.map(r => r.b);
    const members = (await c.query('SELECT to_jsonb(m) AS m FROM member m WHERE tenant_id=$1 AND id=$2', [TENANT, TARGETS[0].member])).rows.map(r => {
      const m = r.m;
      return { id: m.id, tenant_id: m.tenant_id, first_name: m.first_name, last_name: m.last_name, email: m.email, stripe_customer_id: m.stripe_customer_id };
    });
    const tokens = (await c.query('SELECT id,tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    if (tokens.length !== 1 || !tokens[0].access_token || Date.parse(tokens[0].expires_at) < Date.now() + 120000) fail('current_xero_auth_required_no_refresh_attempted');
    const settings = Object.fromEntries((await c.query('SELECT setting_key,setting_value FROM system_settings WHERE tenant_id=$1 AND setting_key=ANY($2::text[])',
      [TENANT, ['xero_invoice_enabled', 'xero_sales_account_code', 'xero_stripe_bank_account_code']])).rows.map(r => [r.setting_key, r.setting_value]));
    const active = (await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1', [TENANT])).rows;
    const stripe = (await c.query("SELECT credentials,is_enabled FROM tenant_integrations WHERE tenant_id=$1 AND integration_type='stripe'", [TENANT])).rows;
    const xero = (await c.query("SELECT is_enabled FROM tenant_integrations WHERE tenant_id=$1 AND integration_type='xero'", [TENANT])).rows;
    if (stripe.length !== 1 || stripe[0].is_enabled !== true || xero.length !== 1 || xero[0].is_enabled !== true) fail('enabled_tenant_integrations_required');
    const available = (await c.query("SELECT to_regprocedure('public.event_invoice_recovery_historical_candidates(integer,uuid,text,text)') IS NOT NULL AS ready")).rows[0].ready;
    const candidates = [];
    if (available) {
      for (const target of TARGETS) {
        const result = (await c.query('SELECT public.event_invoice_recovery_historical_candidates(2,$1,$2,$3) AS candidates', [TENANT, 'booking', target.group])).rows[0].candidates;
        candidates.push(...result);
      }
    }
    state = { bookings, members, candidates, token: tokens[0], settings, activeProvider: active.length === 1 ? active[0].active_provider : null, stripe: stripe[0].credentials };
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  const { decryptCredentials } = await import('../api/_lib/stripeCredentials.js');
  const credentials = decryptCredentials(state.stripe);
  if (!credentials.secret_key?.startsWith('sk_live_')) fail('tenant_live_stripe_key_required');
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(credentials.secret_key, { timeout: 10000, maxNetworkRetries: 0 });
  const paymentIntents = [];
  for (const target of TARGETS) paymentIntents.push(safePi(await stripe.paymentIntents.retrieve(target.pi, { expand: ['latest_charge', 'customer'] })));
  let requests = 0;
  const get = async path => {
    if (!['/connections', '/api.xro/2.0/Accounts', '/api.xro/2.0/TaxRates'].includes(path) || ++requests > 3) fail('xero_get_budget_or_path_violation');
    if (requests > 1) await new Promise(r => setTimeout(r, 1500));
    const response = await fetch(`https://api.xero.com${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${state.token.access_token}`, 'xero-tenant-id': state.token.tenant_id, Accept: 'application/json' } });
    if (!response.ok) fail(`xero_read_HTTP_${response.status}_no_retry`);
    return response.json();
  };
  const connections = (await get('/connections')).map(c => ({ tenantId: c.tenantId }));
  const accounts = (await get('/api.xro/2.0/Accounts')).Accounts?.map(a => ({
    Code: a.Code, AccountID: a.AccountID, Status: a.Status, Type: a.Type, CurrencyCode: a.CurrencyCode, EnablePaymentsToAccount: a.EnablePaymentsToAccount,
  }));
  const taxRates = (await get('/api.xro/2.0/TaxRates')).TaxRates?.map(t => ({
    TaxType: t.TaxType, Status: t.Status, EffectiveRate: t.EffectiveRate,
  }));
  return { version: 1, tenantId: TENANT, eventId: EVENT, observedAt: new Date().toISOString(),
    bookings: state.bookings, members: state.members, candidates: state.candidates, settings: state.settings, activeProvider: state.activeProvider,
    provider: { connectionId: String(state.token.id), xeroTenantId: state.token.tenant_id },
    connections, accounts, taxRates, paymentIntents };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(args);
  // Reserve a new owner-only output before any authority mutation.
  const output = await open(opts.out, 'wx', 0o600);
  try {
    if (opts.capture) {
      const evidence = await captureEvidence(env);
      await output.writeFile(JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ mode: 'read_only_capture', writes: 0, evidenceSha256: hash(evidence) }));
      return;
    }
    const evidence = JSON.parse(await readFile(opts.evidence, 'utf8'));
    const plan = buildPlan(evidence);
    if (!opts.apply) {
      await output.writeFile(JSON.stringify(plan, null, 2));
      console.log(JSON.stringify({ mode: 'offline_review', writes: 0, reviewSha256: plan.reviewSha256,
        readyCards: plan.rows.length, admissionCandidates: plan.rows.filter(r => r.candidate).length,
        requiredMigrations: ['202611300001_event_invoice_recovery.sql', '202611300002_event_invoice_recovery_historical.sql'],
        blockedAccount: ACCOUNT, accountPayable: 200 }));
      return;
    }
    if (opts.review !== plan.reviewSha256) fail('review_hash_mismatch');
    await applyPlan(plan, evidence, output, env);
  } finally { await output.close(); }
}

async function applyPlan(plan, evidence, output, env) {
  destinationTarget(env);
  if (!env.DEST_SUPABASE_KEY) fail('destination_service_credential_required');
  if (plan.rows.some(r => !r.candidate)) fail('historical_candidates_missing_apply_migrations_and_prepare_again');
  // All read-only checks complete before the first admission mutation.
  const current = await captureEvidence(env);
  const currentPlan = buildPlan(current);
  if (hash(currentPlan.provider) !== hash(plan.provider) || currentPlan.accountBookingHash !== plan.accountBookingHash) fail('connection_or_account_booking_drift');
  for (const row of plan.rows) {
    const fresh = currentPlan.rows.find(r => r.bookingId === row.bookingId);
    if (!fresh || fresh.expectedBookingHash !== row.expectedBookingHash
      || hash(fresh.snapshot.settlement) !== hash(row.snapshot.settlement)
      || hash(fresh.snapshot.contact) !== hash(row.snapshot.contact)
      || hash(fresh.candidate) !== hash(row.candidate)) fail('reviewed_booking_provider_or_candidate_drift');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(env.DEST_SUPABASE_URL, env.DEST_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { createEventInvoiceRecoveryXero } = await import('../api/_lib/eventInvoiceRecoveryXero.js');
  // Complete new-adapter legacy discovery for BOTH exact operations before admission.
  // An expired token must fail capture; prohibit refresh/write transports explicitly.
  for (const row of plan.rows) {
    const provider = await createEventInvoiceRecoveryXero({ db,
      row: { id: row.candidate.operationId, tenant_id: TENANT, source: 'booking',
        booking_group_reference: row.bookingGroupReference, snapshot: row.snapshot },
      identity: row.operationIdentity, guard: async () => {}, deadlineAt: Date.now() + 35000,
      fetchImpl: async (url, init) => {
        if (init?.method !== 'GET' || new URL(url).origin !== 'https://api.xero.com') fail('readonly_adapter_preflight_forbids_writes_or_refresh');
        return fetch(url, { ...init, redirect: 'error' });
      } });
    const invoices = await provider.findInvoices();
    const payments = await provider.findPayments();
    if (invoices.length > 1 || payments.length > 1 || (!invoices.length && payments.length)) fail('legacy_identity_ambiguous');
    if (invoices.length) {
      provider.validateInvoice(invoices[0]);
      if (payments.length) provider.validatePayment(payments[0], invoices[0]);
      else if (Number(invoices[0].AmountPaid || 0) !== 0 || Number(invoices[0].AmountDue) !== 166.67) fail('existing_invoice_settlement_requires_review');
    }
  }
  const result = { mode: 'apply', reviewSha256: plan.reviewSha256, accountPreservedPayable: 200, rows: [] };
  const saveAudit = async () => {
    await output.truncate(0);
    await output.write(JSON.stringify(result), 0, 'utf8');
    await output.sync();
  };
  await saveAudit();
  for (const row of plan.rows) {
    const approved = await approveHistoricalEventInvoiceRecovery({ db, candidate: row.candidate, snapshot: row.snapshot,
      evidence: { version: 1, kind: 'approved_repair_manifest', approvalReference: `sha256:${plan.reviewSha256}`,
        approvedBy: 'operator presenting exact user-approved manifest hash', approvedAt: new Date().toISOString(),
        environment: 'live', paymentIntentId: row.snapshot.settlement.paymentIntentId,
        provenance: [row.snapshot.historicalReview.approval, row.snapshot.historicalReview.taxProvenance,
          row.snapshot.historicalReview.dateProvenance, row.snapshot.contact.provenance.evidence,
          `Pinned read-only evidence SHA256 ${plan.evidenceHash}; legacy discovery through existing adapter; not immutable checkout evidence`] } });
    if (!['approved', 'already_approved'].includes(approved?.status)) fail('historical_admission_not_confirmed');
    const progress = { bookingId: row.bookingId, operationId: row.candidate.operationId, status: 'approved' };
    result.rows.push(progress);
    await saveAudit();
    const promoted = await resolveHistoricalEventInvoiceRecovery({ db, limit: 1, operationId: row.candidate.operationId });
    if (Number(promoted) !== 1) fail('historical_hydration_deferred_stop_before_worker');
    progress.status = 'hydrated';
    await saveAudit();
    const processed = await processEventInvoiceRecovery({ db, tenantId: TENANT, source: 'booking',
      bookingGroupReference: row.bookingGroupReference, deadlineAt: Date.now() + 35000 });
    progress.status = processed.status;
    await saveAudit();
    if (processed.status !== 'complete') fail('worker_not_complete_stop_and_review');
  }
  console.log(JSON.stringify({ mode: 'apply', completed: result.rows.length, reviewSha256: plan.reviewSha256,
    accountPayable: 200, excludedTestIntents: TEST_PIS.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Only our static errors are printable. SDK/DB/provider errors can carry secrets/PII.
    const code = /^[a-zA-Z0-9_]+$/.test(error.message || '') ? error.message : 'operation_failed_inspect_private_state_before_retry';
    console.error(JSON.stringify({ ok: false, blocker: code }));
    process.exitCode = 1;
  });
}