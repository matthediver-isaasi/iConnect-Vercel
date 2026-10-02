#!/usr/bin/env node
// Exact user-approved account recovery. Capture/offline review are read-only.
// Private evidence, manifests and audit outputs must be newly created under /tmp.
import { open, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectDestination } from './annual-meeting-destination.mjs';
import { hash, bookingFingerprint, TENANT, EVENT, ACCOUNT } from './prepare-event-historical-recovery.mjs';
import { validRecoverySnapshot, recoveryIdentity, approveHistoricalEventInvoiceRecovery,
  resolveHistoricalEventInvoiceRecovery, processEventInvoiceRecovery } from '../api/_lib/eventInvoiceRecovery.js';
import { createEventInvoiceRecoveryXero } from '../api/_lib/eventInvoiceRecoveryXero.js';

export const GROUP = 'OOE-1790858488719-1I8XH';
export const TICKET = 'ticket-1789458288647-cpu5y';
const ORG = 'efa4d302-9ceb-4085-9e38-8510c16d8206';
const MEMBER = 'cf6c8598-32d9-461f-94c5-1dadfd8df43e';
const fail = code => { throw new Error(code); };
const day = value => new Date(value).toISOString().slice(0, 10);
const policy = { invoice_line_amount_type: 'Inclusive', vat_rate_key: 'OUTPUT2',
  vat_rate_percentage: 20 };
const safePath = value => {
  const path = resolve(value || '');
  if (dirname(path) !== '/tmp') fail('private_tmp_path_required');
  return path;
};
export function argsFor(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--capture', '--apply', '--resume-survey-repair', '--apply-ticket', '--code-policy-confirmed'].includes(arg) && !opts[arg.slice(2)]) opts[arg.slice(2)] = true;
    else if (['--evidence', '--out'].includes(arg) && !opts[arg.slice(2)] && args[i + 1] && !args[i + 1].startsWith('--')) opts[arg.slice(2)] = safePath(args[++i]);
    else if (/^--review-sha256=[a-f0-9]{64}$/.test(arg) && !opts.review) opts.review = arg.split('=')[1];
    else fail('unsupported_or_duplicate_argument');
  }
  if (!opts.out || opts.out === opts.evidence
    || [opts.capture, opts.apply, opts['resume-survey-repair'], opts['apply-ticket']].filter(Boolean).length > 1
    || (opts.capture && (opts.evidence || opts.review || opts['code-policy-confirmed']))
    || (!opts.capture && !opts.evidence)
    || (opts.apply && (opts['apply-ticket'] || !opts.review || opts['code-policy-confirmed']))
    || (opts['resume-survey-repair'] && (!opts.review || opts['code-policy-confirmed']))
    || (opts['apply-ticket'] && (!opts.review || !opts['code-policy-confirmed']))
    || (!opts.apply && !opts['resume-survey-repair'] && !opts['apply-ticket'] && (opts.review || opts['code-policy-confirmed']))) fail('invalid_mode');
  return opts;
}
const safeBooking = b => Object.fromEntries([
  'id', 'tenant_id', 'event_id', 'booking_group_reference', 'status', 'payment_method',
  'member_id', 'organization_id', 'ticket_class_id', 'ticket_price', 'total_cost',
  'account_amount', 'voucher_amount', 'training_fund_amount', 'discount_code_amount',
  'po_to_follow', 'purchase_order_number', 'stripe_payment_intent_id', 'xero_invoice_id',
  'accounting_invoice_id', 'created_at',
].map(k => [k, b[k]]));
export async function capture() {
  const c = await connectDestination();
  let state, protectedIdentities;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='10s'");
    const all = (await c.query('SELECT to_jsonb(b) AS b FROM booking b WHERE tenant_id=$1 AND event_id=$2 ORDER BY id', [TENANT, EVENT])).rows.map(r => r.b);
    const group = all.filter(b => b.booking_group_reference === GROUP);
    if (group.length !== 1 || group[0].id !== ACCOUNT) fail('exact_single_booking_required');
    protectedIdentities = all.filter(b => b.id !== ACCOUNT).map(b => ({
      id: b.id, invoiceIds: [b.xero_invoice_id, b.accounting_invoice_id].filter(Boolean),
      pi: b.stripe_payment_intent_id,
      identity: recoveryIdentity(TENANT, 'booking', b.booking_group_reference),
    }));
    const event = (await c.query('SELECT title,internal_reference,pricing_config,xero_account_code FROM event WHERE tenant_id=$1 AND id=$2', [TENANT, EVENT])).rows;
    const org = (await c.query('SELECT id,name,invoicing_email FROM organization WHERE tenant_id=$1 AND id=$2', [TENANT, ORG])).rows;
    const member = (await c.query('SELECT id,email FROM member WHERE tenant_id=$1 AND id=$2', [TENANT, MEMBER])).rows;
    const tokens = (await c.query('SELECT id,tenant_id,access_token,expires_at FROM xero_token WHERE app_tenant_id=$1', [TENANT])).rows;
    if (tokens.length !== 1 || !tokens[0].access_token || Date.parse(tokens[0].expires_at) < Date.now() + 120000) fail('current_xero_auth_required_no_refresh_attempted');
    if (event.length !== 1 || org.length !== 1 || member.length !== 1) fail('original_recipient_binding_missing');
    const settings = Object.fromEntries((await c.query('SELECT setting_key,setting_value FROM system_settings WHERE tenant_id=$1 AND setting_key=ANY($2::text[])',
      [TENANT, ['xero_invoice_enabled', 'xero_sales_account_code', 'xero_invoice_status']])).rows.map(r => [r.setting_key, r.setting_value]));
    const active = (await c.query('SELECT active_provider FROM tenant_accounting_settings WHERE tenant_id=$1', [TENANT])).rows;
    const enabled = (await c.query("SELECT is_enabled FROM tenant_integrations WHERE tenant_id=$1 AND integration_type='xero'", [TENANT])).rows;
    const candidate = (await c.query("SELECT public.event_invoice_recovery_historical_candidates(2,$1,'booking',$2) AS candidates", [TENANT, GROUP])).rows[0].candidates;
    state = { booking: safeBooking(group[0]), bookingHash: bookingFingerprint(group[0]),
      protectedBookings: all.filter(b => b.id !== ACCOUNT).map(b => ({ id: b.id, hash: bookingFingerprint(b) })),
      event: event[0], org: { id: org[0].id, name: org[0].name, hasInvoicingEmail: !!org[0].invoicing_email },
      bookerMatchesRequestedEmail: member[0].email?.trim().toLowerCase() === 'membership@bnms.org.uk',
      settings, activeProvider: active.length === 1 ? active[0].active_provider : null,
      enabled: enabled.length === 1 && enabled[0].is_enabled === true, candidate, token: tokens[0] };
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  const token = state.token;
  delete state.token;
  let requests = 0;
  const get = async path => {
    if (++requests > 9 || !(/^\/connections$/.test(path)
      || /^\/api\.xro\/2\.0\/(Accounts|TaxRates|Contacts|Invoices)(\?|$)/.test(path))) fail('xero_get_budget_or_path_violation');
    if (requests > 1) await new Promise(r => setTimeout(r, 1500));
    const response = await fetch(`https://api.xero.com${path}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'xero-tenant-id': token.tenant_id, Accept: 'application/json' } });
    if (!response.ok) fail(`xero_read_HTTP_${response.status}_no_retry`);
    return response.json();
  };
  const connections = await get('/connections');
  if (!Array.isArray(connections) || !connections.some(x => x.tenantId === token.tenant_id)) fail('current_xero_connection_not_verified');
  const accounts = (await get('/api.xro/2.0/Accounts')).Accounts;
  const taxRates = (await get('/api.xro/2.0/TaxRates')).TaxRates;
  const contacts = (await get('/api.xro/2.0/Contacts?where=' + encodeURIComponent(`Name==${JSON.stringify(state.org.name)}`))).Contacts;
  if (!Array.isArray(contacts) || contacts.length > 1 || contacts.some(x => !x.ContactID || x.Name !== state.org.name || x.ContactStatus === 'ARCHIVED')) fail('organization_contact_ambiguous');
  const observedAt = new Date().toISOString();
  const from = day(state.booking.created_at), to = day(observedAt);
  if (Date.parse(to) - Date.parse(from) < 0 || Date.parse(to) - Date.parse(from) > 366 * 86400000) fail('legacy_date_scope_invalid');
  const identity = recoveryIdentity(TENANT, 'booking', GROUP);
  const where = `Type=="ACCREC"&&Date>=DateTime(${from.replaceAll('-', ',')})&&Date<=DateTime(${to.replaceAll('-', ',')})`;
  let complete = false;
  const invoices = [], ids = new Set();
  for (let page = 1; page <= 3; page++) {
    const data = await get(`/api.xro/2.0/Invoices?where=${encodeURIComponent(where)}&page=${page}&pageSize=100`);
    if (!Array.isArray(data.Invoices) || data.Invoices.length > 100) fail('legacy_lookup_invalid');
    if (!data.Invoices.length) { complete = true; break; }
    for (const i of data.Invoices) {
      if (!i.InvoiceID || ids.has(i.InvoiceID) || i.HasErrors || i.ValidationErrors?.length
        || i.Type !== 'ACCREC' || !Array.isArray(i.LineItems) || i.LineItems.some(l => typeof l.Description !== 'string')) fail('legacy_lookup_incomplete');
      ids.add(i.InvoiceID);
      const groupMatch = i.Reference === GROUP || i.InvoiceNumber === identity || i.LineItems.some(l => l.Description.includes(GROUP) || l.Description.includes(identity));
      const eventMatch = i.LineItems.some(l => l.Description.includes(state.event.title) || (state.event.internal_reference && l.Description.includes(state.event.internal_reference)));
      const orgMatch = i.Contact?.Name === state.org.name || !!(contacts[0] && i.Contact?.ContactID === contacts[0].ContactID);
      const protectedBookingMatches = protectedIdentities.filter(b => b.invoiceIds.includes(i.InvoiceID)
        || i.InvoiceNumber === b.identity || i.LineItems.some(l => l.Description.includes(b.identity)
          || (b.pi && l.Description.includes(b.pi)))).map(b => b.id);
      invoices.push({ id: i.InvoiceID, invoiceNumber: i.InvoiceNumber, groupMatch, eventMatch, orgMatch,
        protectedBookingMatches,
        total: Number(i.Total), amountPaid: Number(i.AmountPaid || 0), amountDue: Number(i.AmountDue),
        status: i.Status, lineAmountTypes: i.LineAmountTypes });
    }
  }
  if (!complete) fail('legacy_lookup_incomplete');
  return { version: 1, tenantId: TENANT, eventId: EVENT, observedAt, ...state,
    provider: { connectionId: String(token.id), xeroTenantId: token.tenant_id },
    salesAccounts: (accounts || []).filter(a => a.Code === '210').map(a => ({ Code: a.Code, Status: a.Status })),
    vatRates: (taxRates || []).filter(r => r.TaxType === 'OUTPUT2').map(r => ({ TaxType: r.TaxType, Status: r.Status, EffectiveRate: r.EffectiveRate, Name: r.Name })),
    organizationContactId: contacts[0]?.ContactID || null,
    discovery: { from, to, complete, invoiceCount: invoices.length, requests, invoices } };
}
export function buildAccountPlan(e) {
  const b = e.booking;
  if (e.version !== 1 || e.tenantId !== TENANT || e.eventId !== EVENT || !Number.isFinite(Date.parse(e.observedAt))
    || b?.id !== ACCOUNT || b.tenant_id !== TENANT || b.event_id !== EVENT || b.booking_group_reference !== GROUP
    || b.status !== 'confirmed' || b.payment_method !== 'account' || b.member_id !== MEMBER || b.organization_id !== ORG
    || b.ticket_class_id !== TICKET || Number(b.ticket_price) !== 200 || Number(b.total_cost) !== 200 || Number(b.account_amount) !== 200
    || [b.voucher_amount, b.training_fund_amount, b.discount_code_amount].some(v => Number(v || 0) !== 0)
    || b.po_to_follow !== true || b.purchase_order_number || b.stripe_payment_intent_id || b.xero_invoice_id || b.accounting_invoice_id
    || !e.bookerMatchesRequestedEmail || e.org?.id !== ORG || e.org.name !== 'British Nuclear Medicine Society' || e.org.hasInvoicingEmail) fail('exact_account_invariant_failed');
  if (e.activeProvider !== 'xero' || !e.enabled || e.settings.xero_invoice_enabled !== 'true'
    || e.settings.xero_invoice_status !== 'AUTHORISED' || e.settings.xero_sales_account_code !== '210'
    || e.event.xero_account_code !== '210' || e.salesAccounts.length !== 1 || e.salesAccounts[0].Status !== 'ACTIVE'
    || e.vatRates.length !== 1 || e.vatRates[0].Status !== 'ACTIVE' || Number(e.vatRates[0].EffectiveRate) !== 20) fail('verified_provider_tax_mapping_required');
  const tickets = e.event.pricing_config?.ticket_classes;
  if (!Array.isArray(tickets) || tickets.filter(t => t.id === TICKET).length !== 1) fail('exact_ticket_required');
  if (!e.discovery?.complete || e.discovery.invoices.some(i => i.groupMatch
    || (i.eventMatch && !i.protectedBookingMatches?.length)
    || (i.orgMatch && i.total === 200))) fail('legacy_duplicate_candidate_requires_review');
  if (e.candidate?.length !== 1 || e.candidate[0].tenantId !== TENANT || e.candidate[0].source !== 'booking'
    || e.candidate[0].bookingGroupReference !== GROUP) fail('fresh_historical_candidate_required');
  const date = day(b.created_at);
  const contact = { name: e.org.name, email: null, isOrganization: true,
    provenance: { kind: 'historical_linked_organization', id: ORG,
      evidence: 'Original booking organization ID and original checkout organization-first recipient policy; booker is not billing recipient.' } };
  const snapshot = { version: 1, provider: e.provider, contact, amount: 200, currency: 'GBP',
    paymentMethod: 'invoice', checkoutPaymentMethod: 'account', purchaseOrderNumber: null, poToFollow: true, settlement: null,
    invoiceLineAmountPolicies: ['Inclusive'],
    historicalReview: { kind: 'explicit_user_approved_reconstruction',
      approval: 'User explicitly confirmed GBP200 includes 20% VAT: GBP166.67 net and GBP33.33 VAT; recover this specific unpaid account invoice.',
      taxProvenance: 'Explicit user approval, not immutable historical checkout VAT evidence; active OUTPUT2 20% verified.',
      dateProvenance: 'Reconstructed invoice date from original booking UTC creation date, due date +30 days; reviewed manifest.' },
    legacyDiscovery: { version: 1, fromDate: e.discovery.from, toDate: e.discovery.to, bookingReference: GROUP },
    invoice: { Type: 'ACCREC', Contact: e.organizationContactId ? { ContactID: e.organizationContactId } : { Name: contact.name },
      Date: date, DueDate: day(Date.parse(b.created_at) + 30 * 86400000), CurrencyCode: 'GBP',
      LineAmountTypes: 'Inclusive', Reference: 'TBC', Status: 'AUTHORISED',
      LineItems: [{ Description: `Event: ${e.event.title}; Reference: ${e.event.internal_reference}; booking ${GROUP}; historical unpaid account invoice, PO to follow.`,
        Quantity: 1, UnitAmount: 200, AccountCode: '210', TaxType: 'OUTPUT2', TaxAmount: 33.33 }] } };
  if (!validRecoverySnapshot(snapshot)) fail('approved_account_snapshot_invalid');
  const previousTicket = tickets.find(t => t.id === TICKET);
  const ticketPatch = { ...policy, vat_rate_label: e.vatRates[0].Name || '20% VAT on Income' };
  const plan = { version: 1, tenantId: TENANT, eventId: EVENT, bookingId: ACCOUNT, group: GROUP,
    evidenceHash: hash(e), expectedBookingHash: e.bookingHash, protectedBookings: e.protectedBookings,
    protectedProviderInvoices: e.discovery.invoices.filter(i => i.protectedBookingMatches?.length).map(i => ({
      id: i.id, total: i.total, amountPaid: i.amountPaid, amountDue: i.amountDue,
      status: i.status, lineAmountTypes: i.lineAmountTypes,
    })),
    expectedPricingHash: hash(e.event.pricing_config), previousTicket, ticketPatch,
    candidate: e.candidate[0], snapshot, operationIdentity: recoveryIdentity(TENANT, 'booking', GROUP),
    execution: 'Invoice-only reviewed historical admission/hydration and local fenced worker now; no payment/email/ticket mutation. Separate exact-ticket policy apply only after confirmed publication.' };
  return { ...plan, reviewSha256: hash(plan) };
}
async function verifyCompletedInvoice(plan) {
  const c = await connectDestination();
  let invoiceId, token;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='10s'");
    const all = (await c.query('SELECT to_jsonb(b) AS b FROM booking b WHERE tenant_id=$1 AND event_id=$2 ORDER BY id', [TENANT, EVENT])).rows.map(r => r.b);
    const protectedNow = all.filter(b => b.id !== ACCOUNT).map(b => ({ id: b.id, hash: bookingFingerprint(b) }));
    if (hash(protectedNow) !== hash(plan.protectedBookings)) fail('protected_bookings_drift_stop');
    const booking = all.find(b => b.id === ACCOUNT);
    if (!booking || Number(booking.account_amount) !== 200 || Number(booking.total_cost) !== 200
      || booking.payment_method !== 'account' || booking.stripe_payment_intent_id || booking.status !== 'confirmed') fail('completed_account_booking_invariant_failed');
    const rows = (await c.query('SELECT status,invoice_id,payment_id,payment_write_started_at FROM event_invoice_recovery WHERE id=$1 AND tenant_id=$2 AND source=$3 AND booking_group_reference=$4',
      [plan.candidate.operationId, TENANT, 'booking', GROUP])).rows;
    if (rows.length !== 1 || rows[0].status !== 'complete' || !rows[0].invoice_id || rows[0].payment_id
      || rows[0].payment_write_started_at || booking.xero_invoice_id !== rows[0].invoice_id) fail('completed_account_invoice_mirror_invalid');
    invoiceId = rows[0].invoice_id;
    const tokens = (await c.query('SELECT access_token,tenant_id,expires_at FROM xero_token WHERE id=$1 AND app_tenant_id=$2', [plan.snapshot.provider.connectionId, TENANT])).rows;
    if (tokens.length !== 1 || tokens[0].tenant_id !== plan.snapshot.provider.xeroTenantId
      || !tokens[0].access_token || Date.parse(tokens[0].expires_at) < Date.now() + 60000) fail('postflight_current_xero_auth_required');
    token = tokens[0];
    await c.query('ROLLBACK');
  } finally { await c.end(); }
  const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(invoiceId)}`,
    { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'xero-tenant-id': token.tenant_id, Accept: 'application/json' } });
  if (!response.ok) fail(`postflight_xero_HTTP_${response.status}_no_retry`);
  const invoices = (await response.json()).Invoices;
  const i = invoices?.[0];
  if (invoices?.length !== 1 || i.InvoiceID !== invoiceId || i.Status !== 'AUTHORISED' || i.CurrencyCode !== 'GBP'
    || Number(i.Total) !== 200 || Number(i.AmountPaid || 0) !== 0 || Number(i.AmountDue) !== 200
    || i.LineAmountTypes !== 'Inclusive' || Number(i.TotalTax) !== 33.33 || Number(i.SubTotal) !== 166.67
    || i.LineItems?.length !== 1 || Number(i.LineItems[0].Quantity) !== 1
    || Number(i.LineItems[0].UnitAmount) !== 200 || Number(i.LineItems[0].TaxAmount) !== 33.33
    || i.LineItems[0].TaxType !== 'OUTPUT2' || String(i.LineItems[0].AccountCode) !== '210'
    || i.Payments?.length || i.HasErrors || i.ValidationErrors?.length) fail('postflight_unpaid_invoice_evidence_mismatch');
  for (const original of plan.protectedProviderInvoices) {
    const response = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(original.id)}`,
      { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token.access_token}`, 'xero-tenant-id': token.tenant_id, Accept: 'application/json' } });
    if (!response.ok) fail(`protected_invoice_xero_HTTP_${response.status}_no_retry`);
    const invoices = (await response.json()).Invoices;
    const current = invoices?.[0];
    if (invoices?.length !== 1 || current.InvoiceID !== original.id
      || Number(current.Total) !== original.total || Number(current.AmountPaid || 0) !== original.amountPaid
      || Number(current.AmountDue) !== original.amountDue || current.Status !== original.status
      || current.LineAmountTypes !== original.lineAmountTypes) fail('protected_provider_invoice_drift_stop');
  }
  return { invoiceId, invoiceNumber: i.InvoiceNumber, amountDue: 200, amountPaid: 0, totalTax: 33.33,
    net: 166.67, gross: 200,
    protectedBookingsVerified: plan.protectedBookings.length, protectedProviderInvoicesVerified: plan.protectedProviderInvoices.length };
}
async function updateTicket(plan) {
  const c = await connectDestination();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='10s'");
    const result = await c.query('SELECT pricing_config FROM event WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [TENANT, EVENT]);
    const pricing = result.rows[0]?.pricing_config;
    if (!pricing) fail('ticket_pricing_drift');
    const expectedNext = { ...pricing, ticket_classes: pricing.ticket_classes.map(t => t.id === TICKET ? { ...plan.previousTicket, ...plan.ticketPatch } : t) };
    if (hash(pricing) !== plan.expectedPricingHash) {
      // Idempotent resume permits precisely our patch, never unrelated drift.
      const original = { ...pricing, ticket_classes: pricing.ticket_classes.map(t => t.id === TICKET ? plan.previousTicket : t) };
      if (hash(original) !== plan.expectedPricingHash || hash(pricing) !== hash(expectedNext)) fail('ticket_pricing_drift');
      await c.query('ROLLBACK');
      return hash(pricing);
    }
    const next = { ...pricing, ticket_classes: pricing.ticket_classes.map(t => t.id === TICKET ? { ...t, ...plan.ticketPatch } : t) };
    const changed = await c.query('UPDATE event SET pricing_config=$3::jsonb WHERE tenant_id=$1 AND id=$2 RETURNING id', [TENANT, EVENT, JSON.stringify(next)]);
    if (changed.rowCount !== 1) fail('exact_ticket_update_failed');
    await c.query('COMMIT');
    return hash(next);
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { await c.end(); }
}
async function runScopedWorker(db) {
  return processEventInvoiceRecovery({ db, tenantId: TENANT, source: 'booking', bookingGroupReference: GROUP,
    deadlineAt: Date.now() + 35000, providerFactory: options => createEventInvoiceRecoveryXero({ ...options,
      fetchImpl: async (url, init) => {
        const target = new URL(url);
        if (target.origin !== 'https://api.xero.com' || !(init?.method === 'GET'
          || (init?.method === 'POST' && target.pathname === '/api.xro/2.0/Invoices'))) fail('account_worker_forbids_payment_refresh_or_alternate_write');
        return fetch(url, { ...init, redirect: 'error' });
      } }) });
}
async function prepareSurveyReadmission(plan, originalEvidence) {
  // Fresh complete provider discovery and all unaffected evidence are required
  // before this narrowly authorized append-only admission repair.
  const freshEvidence = await capture();
  const freshPlan = buildAccountPlan(freshEvidence);
  for (const key of ['protectedBookings', 'protectedProviderInvoices', 'expectedPricingHash', 'snapshot', 'ticketPatch']) {
    if (hash(freshPlan[key]) !== hash(plan[key])) fail('readmission_reviewed_evidence_drift');
  }
  if (hash(freshEvidence.booking) !== hash(originalEvidence.booking)) fail('readmission_original_booking_fields_changed');
  const c = await connectDestination();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='10s'");
    const rows = (await c.query('SELECT to_jsonb(h) AS h FROM event_invoice_recovery_historical_evidence h WHERE operation_id=$1', [plan.candidate.operationId])).rows;
    const rejected = rows[0]?.h;
    if (rows.length !== 1 || rejected.state !== 'rejected' || rejected.reason_code !== 'historical_candidate_stale'
      || rejected.consumed_at || hash(rejected.snapshot) !== hash(plan.snapshot)
      || hash(rejected.candidate) !== hash(plan.candidate)
      || rejected.evidence?.approvalReference !== `sha256:${plan.reviewSha256}`) fail('exact_original_rejection_required');
    const b = (await c.query('SELECT to_jsonb(b) AS b FROM booking b WHERE tenant_id=$1 AND event_id=$2 AND id=$3 AND booking_group_reference=$4',
      [TENANT, EVENT, ACCOUNT, GROUP])).rows[0]?.b;
    if (!b || !Number.isSafeInteger(Number(b.survey_invitation_revision)) || Number(b.survey_invitation_revision) > 100) fail('bounded_original_revision_lookup_required');
    const matches = (await c.query(`WITH revisions AS (SELECT generate_series(0,$5::integer) AS revision)
      SELECT revision FROM revisions WHERE
      (SELECT md5(jsonb_agg(jsonb_set(to_jsonb(b)-'invoice_recovery_status'-'invoice_recovery_next_attempt_at',
        '{survey_invitation_revision}',to_jsonb(revision)) ORDER BY b.id)::text)
       FROM booking b WHERE tenant_id=$1 AND event_id=$2 AND id=$3 AND booking_group_reference=$4)=$6`,
    [TENANT, EVENT, ACCOUNT, GROUP, Number(b.survey_invitation_revision), rejected.candidate.bookingFingerprint])).rows;
    if (matches.length !== 1) fail('unique_original_survey_revision_not_verified');
    // pg exposes bigint as string; the original JSON fingerprint requires the
    // original numeric JSON type, not its textual representation.
    const revision = matches[0].revision;
    if (bookingFingerprint({ ...b, survey_invitation_revision: revision }) !== plan.expectedBookingHash) fail('non_survey_booking_drift');
    await c.query('ROLLBACK');
    return { rejected, originalSurveyRevisions: { [ACCOUNT]: revision },
      observedCurrentRevision: Number(b.survey_invitation_revision), freshEvidenceHash: hash(freshEvidence),
      repairReference: `User-authorized exact survey-only readmission; manifest sha256:${plan.reviewSha256}; migration005; invoice-only GBP200 inclusive20 unpaid` };
  } finally { await c.end(); }
}
export async function main(args = process.argv.slice(2)) {
  const opts = argsFor(args);
  const output = await open(opts.out, 'wx', 0o600);
  try {
    if (opts.capture) {
      const e = await capture();
      await output.writeFile(JSON.stringify(e, null, 2));
      console.log(JSON.stringify({ mode: 'read_only_capture', writes: 0, evidenceSha256: hash(e), invoicesInspected: e.discovery.invoiceCount }));
      return;
    }
    const evidence = JSON.parse(await readFile(opts.evidence, 'utf8'));
    const plan = buildAccountPlan(evidence);
    if (!opts.apply && !opts['resume-survey-repair'] && !opts['apply-ticket']) {
      await output.writeFile(JSON.stringify(plan, null, 2));
      console.log(JSON.stringify({ mode: 'offline_review', writes: 0, reviewSha256: plan.reviewSha256, payable: 200, vat: 33.33, settlement: null }));
      return;
    }
    if (opts.review !== plan.reviewSha256) fail('review_hash_mismatch');
    if (opts['apply-ticket']) {
      // This flag is an operator attestation of actual publication, not just
      // presence of a local patch. Invoice-only apply must never require it.
      const producer = await readFile(new URL('../api/_lib/eventInvoiceProducer.js', import.meta.url), 'utf8');
      if (!producer.includes('invoice_line_amount_type') || !producer.includes('Inclusive')) fail('inclusive_code_policy_not_present');
      const audit = { mode: 'apply_ticket_after_confirmed_publication', reviewSha256: plan.reviewSha256,
        bookingId: ACCOUNT, steps: [], paymentWrites: 0, emails: 0 };
      const save = async () => { await output.truncate(0); await output.write(JSON.stringify(audit, null, 2), 0, 'utf8'); await output.sync(); };
      await save();
      audit.invoice = await verifyCompletedInvoice(plan);
      audit.steps.push('unpaid_invoice_and_protected_bookings_verified'); await save();
      audit.ticketPricingHash = await updateTicket(plan);
      audit.steps.push('exact_ticket_policy_updated'); await save();
      console.log(JSON.stringify({ mode: audit.mode, status: 'complete', reviewSha256: plan.reviewSha256, paymentWrites: 0, emails: 0 }));
      return;
    }
    if (!process.env.DEST_SUPABASE_KEY) fail('destination_service_credential_required');
    if (opts['resume-survey-repair']) {
      const repair = await prepareSurveyReadmission(plan, evidence);
      const { createClient } = await import('@supabase/supabase-js');
      const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const adapter = await createEventInvoiceRecoveryXero({ db,
        row: { id: plan.candidate.operationId, tenant_id: TENANT, source: 'booking', booking_group_reference: GROUP, snapshot: plan.snapshot },
        identity: plan.operationIdentity, guard: async () => {}, deadlineAt: Date.now() + 35000,
        fetchImpl: async (url, init) => {
          if (init?.method !== 'GET' || new URL(url).origin !== 'https://api.xero.com') fail('readonly_preflight_forbids_writes_or_refresh');
          return fetch(url, { ...init, redirect: 'error' });
        } });
      if ((await adapter.findInvoices()).length || (await adapter.findPayments()).length) fail('readmission_legacy_duplicate_requires_review');
      const audit = { mode: 'resume_survey_only_invoice', reviewSha256: plan.reviewSha256, bookingId: ACCOUNT,
        repair, steps: [], paymentWrites: 0, emails: 0, ticketPolicyStatus: 'pending_confirmed_publication' };
      const save = async () => { await output.truncate(0); await output.write(JSON.stringify(audit, null, 2), 0, 'utf8'); await output.sync(); };
      await save();
      const { data, error } = await db.rpc('event_invoice_recovery_readmit_survey_stale', {
        p_id: plan.candidate.operationId, p_expected_rejected: repair.rejected,
        p_original_survey_revisions: repair.originalSurveyRevisions, p_repair_reference: repair.repairReference });
      if (error || data?.status !== 'approved') fail('audited_readmission_not_confirmed');
      audit.readmissionAuditId = data.auditId;
      audit.steps.push('audited_survey_only_readmission'); await save();
      if (Number(await resolveHistoricalEventInvoiceRecovery({ db, limit: 1, operationId: plan.candidate.operationId })) !== 1) fail('readmitted_hydration_deferred_stop_before_worker');
      audit.steps.push('historical_hydrated'); await save();
      const result = await runScopedWorker(db);
      audit.steps.push(`worker_${result.status}`); await save();
      if (result.status !== 'complete') fail('readmitted_worker_not_complete_stop_and_review');
      audit.invoice = await verifyCompletedInvoice(plan);
      const c = await connectDestination();
      try {
        await c.query('BEGIN READ ONLY');
        const pricing = (await c.query('SELECT pricing_config FROM event WHERE tenant_id=$1 AND id=$2', [TENANT, EVENT])).rows[0]?.pricing_config;
        if (hash(pricing) !== plan.expectedPricingHash) fail('invoice_only_ticket_pricing_changed');
        await c.query('ROLLBACK');
      } finally { await c.end(); }
      audit.steps.push('unpaid_invoice_protected_originals_and_unchanged_ticket_verified'); await save();
      console.log(JSON.stringify({ mode: audit.mode, status: 'complete', ...audit.invoice,
        paymentWrites: 0, emails: 0, ticketPolicyStatus: audit.ticketPolicyStatus }));
      return;
    }
    const fresh = buildAccountPlan(await capture());
    for (const key of ['expectedBookingHash', 'protectedBookings', 'protectedProviderInvoices', 'expectedPricingHash', 'candidate', 'snapshot', 'ticketPatch']) {
      if (hash(fresh[key]) !== hash(plan[key])) fail('reviewed_evidence_drift');
    }
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const readOnlyFetch = async (url, init) => {
      if (init?.method !== 'GET' || new URL(url).origin !== 'https://api.xero.com') fail('readonly_preflight_forbids_writes_or_refresh');
      return fetch(url, { ...init, redirect: 'error' });
    };
    const adapter = await createEventInvoiceRecoveryXero({ db,
      row: { id: plan.candidate.operationId, tenant_id: TENANT, source: 'booking', booking_group_reference: GROUP, snapshot: plan.snapshot },
      identity: plan.operationIdentity, guard: async () => {}, deadlineAt: Date.now() + 35000, fetchImpl: readOnlyFetch });
    if ((await adapter.findInvoices()).length || (await adapter.findPayments()).length) fail('legacy_duplicate_requires_review');
    const audit = { mode: 'apply_invoice_only', reviewSha256: plan.reviewSha256, bookingId: ACCOUNT,
      steps: [], paymentWrites: 0, emails: 0, ticketPolicyStatus: 'pending_confirmed_publication' };
    const save = async () => { await output.truncate(0); await output.write(JSON.stringify(audit, null, 2), 0, 'utf8'); await output.sync(); };
    await save();
    const approved = await approveHistoricalEventInvoiceRecovery({ db, candidate: plan.candidate, snapshot: plan.snapshot,
      evidence: { version: 1, kind: 'approved_repair_manifest', approvalReference: `sha256:${plan.reviewSha256}`,
        approvedBy: 'Operator presenting exact user-approved account manifest hash', approvedAt: new Date().toISOString(), environment: 'live',
        provenance: [plan.snapshot.historicalReview.approval, plan.snapshot.historicalReview.taxProvenance,
          plan.snapshot.historicalReview.dateProvenance, plan.snapshot.contact.provenance.evidence,
          `Pinned read-only evidence SHA256 ${plan.evidenceHash}; complete bounded invoice scan and existing adapter preflight; no immutable checkout snapshot.`] } });
    if (!['approved', 'already_approved'].includes(approved?.status)) fail('historical_admission_not_confirmed');
    audit.steps.push('historical_approved'); await save();
    if (Number(await resolveHistoricalEventInvoiceRecovery({ db, limit: 1, operationId: plan.candidate.operationId })) !== 1) fail('historical_hydration_deferred_stop_before_worker');
    audit.steps.push('historical_hydrated'); await save();
    const result = await runScopedWorker(db);
    audit.steps.push(`worker_${result.status}`); await save();
    if (result.status !== 'complete') fail('worker_not_complete_stop_and_review');
    audit.invoice = await verifyCompletedInvoice(plan);
    audit.steps.push('unpaid_invoice_and_protected_bookings_verified'); await save();
    console.log(JSON.stringify({ mode: audit.mode, status: result.status, reviewSha256: plan.reviewSha256,
      payable: 200, paymentWrites: 0, emails: 0, ticketPolicyStatus: audit.ticketPolicyStatus }));
  } finally { await output.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, blocker: /^[a-zA-Z0-9_]+$/.test(error.message || '') ? error.message : 'operation_failed_inspect_private_state_before_retry' }));
    process.exitCode = 1;
  });
}