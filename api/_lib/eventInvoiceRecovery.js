import { createHash } from 'node:crypto';

export class EventInvoiceRecoveryError extends Error {
  constructor(code, { retry = false, retryAfter = null } = {}) {
    super(code);
    this.code = code;
    this.retry = retry;
    this.retryAfter = retryAfter;
  }
}

export const recoveryIdentity = (tenantId, source, group) =>
  `event-${createHash('sha256').update(JSON.stringify([tenantId, source, group])).digest('hex').slice(0, 48)}`;

export function recoveryLineAmount(line, currency) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return Number((line.UnitAmount * line.Quantity * (1 - Number(line.DiscountRate || 0) / 100)).toFixed(digits));
}

export function validRecoverySnapshot(s) {
  if (!s || s.version !== 1 || !s.provider?.connectionId || !s.provider?.xeroTenantId
    || s.provider.xeroTenantId === 'PENDING_SELECTION'
    || !['stripe', 'invoice'].includes(s.paymentMethod)
    || !/^[A-Z]{3}$/.test(s.currency || '') || !Number.isFinite(s.amount) || s.amount <= 0
    || !s.contact || typeof s.contact !== 'object'
    || s.invoice?.Type !== 'ACCREC' || s.invoice.InvoiceID || s.invoice.InvoiceNumber || s.invoice.Payments
    || !(s.paymentMethod === 'stripe' ? ['AUTHORISED'] : ['DRAFT', 'SUBMITTED', 'AUTHORISED']).includes(s.invoice?.Status)
    || s.invoice.CurrencyCode !== s.currency
    || !(s.invoice.Contact?.ContactID || s.invoice.Contact?.Name)
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.invoice.Date || '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.invoice.DueDate || '')
    || !Array.isArray(s.invoice.LineItems) || !s.invoice.LineItems.length
    || s.invoice.LineItems.some(line => !line.AccountCode || !Number.isFinite(line.UnitAmount)
      || !Number.isFinite(line.Quantity) || line.Quantity <= 0
      || !Number.isFinite(Number(line.DiscountRate || 0)) || Number(line.DiscountRate || 0) < 0
      || Number(line.DiscountRate || 0) > 100
      || typeof line.TaxType !== 'string' || !line.TaxType
      || typeof line.TaxAmount !== 'number' || !Number.isFinite(line.TaxAmount))
    || !['Exclusive', 'Inclusive', 'NoTax'].includes(s.invoice.LineAmountTypes)
    || Buffer.byteLength(JSON.stringify(s)) > 262144) return false;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: s.currency }).resolvedOptions().maximumFractionDigits;
  if (s.invoice.LineItems.some(line => line.LineAmount != null && line.LineAmount !== recoveryLineAmount(line, s.currency))
    || (s.invoice.LineAmountTypes === 'NoTax' && s.invoice.LineItems.some(line => line.TaxAmount !== 0))) return false;
  const expectedTotal = Number(s.invoice.LineItems.reduce((sum, line) =>
    sum + recoveryLineAmount(line, s.currency) + (s.invoice.LineAmountTypes === 'Exclusive' ? line.TaxAmount : 0), 0).toFixed(digits));
  if (expectedTotal !== s.amount) return false;
  if (s.paymentMethod === 'invoice') return s.settlement == null;
  const p = s.settlement;
  return Boolean(p && /^pi_[A-Za-z0-9]+$/.test(p.paymentIntentId || '')
    && p.livemode === true && p.status === 'succeeded' && p.amount === s.amount && p.currency === s.currency
    && Number.isFinite(Date.parse(p.paidAt)) && typeof p.accountCode === 'string' && p.accountCode.trim());
}

export async function recoveryRpc(db, name, args = {}, deadlineAt = Date.now() + 5000) {
  if (!db) throw new Error('Event invoice recovery database unavailable');
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Event invoice recovery persistence budget exhausted');
  const query = db.rpc(`event_invoice_recovery_${name}`, args);
  const { data, error } = await (typeof query.abortSignal === 'function'
    ? query.abortSignal(AbortSignal.timeout(Math.min(5000, remaining))) : query);
  if (error) throw new Error(`Event invoice recovery persistence failed (${name})`);
  return data;
}

export async function enqueueEventInvoiceRecovery({ db, tenantId, source, bookingGroupReference, snapshot = null }) {
  if (!tenantId || !['booking', 'complex_event_booking'].includes(source)
    || typeof bookingGroupReference !== 'string' || !bookingGroupReference.trim()
    || bookingGroupReference.length > 200) throw new Error('Invalid event invoice recovery scope');
  return recoveryRpc(db, 'enqueue', {
    p_tenant_id: tenantId, p_source: source, p_group: bookingGroupReference,
    p_snapshot: snapshot, p_valid: validRecoverySnapshot(snapshot) || validRecoveryTaxIntent(snapshot),
  });
}

// Validate the entire checkout envelope without pretending absent VAT is zero.
// The temporary projection is never persisted or sent to an accounting provider.
export function validRecoveryTaxIntent(s) {
  if (s?.taxResolution?.version !== 1 || s.taxResolution.kind !== 'future_checkout_provider_tax'
    || !Number.isFinite(Date.parse(s.taxResolution.capturedAt)) || s.legacyDiscovery
    || s.reviewReasons?.length || !s.invoice?.LineItems?.length) return false;
  const projected = structuredClone(s);
  for (const line of projected.invoice.LineItems) {
    if (line.TaxType != null && (typeof line.TaxType !== 'string' || !line.TaxType)) return false;
    if (line.TaxAmount != null && !Number.isFinite(line.TaxAmount)) return false;
    line.TaxType ||= '__unresolved__';
    line.TaxAmount = 0;
  }
  return validRecoverySnapshot(projected);
}

export function validHistoricalRecoveryEvidence(snapshot, evidence) {
  return validRecoverySnapshot(snapshot) && evidence?.version === 1
    && ['approved_repair_manifest', 'original_booking_verified_provider'].includes(evidence.kind)
    && evidence.environment === 'live'
    && ['approvalReference', 'approvedBy'].every(key => typeof evidence[key] === 'string' && evidence[key].trim())
    && Number.isFinite(Date.parse(evidence.approvedAt))
    && Array.isArray(evidence.provenance) && evidence.provenance.length > 0
    && evidence.provenance.every(item => typeof item === 'string' && item.trim())
    && (snapshot.paymentMethod !== 'stripe' || (snapshot.settlement.livemode === true
      && evidence.paymentIntentId === snapshot.settlement.paymentIntentId));
}

/** Persist reviewed original evidence; never reconstruct historical purchaser/VAT from current settings. */
export async function approveHistoricalEventInvoiceRecovery({ db, candidate, snapshot, evidence }) {
  if (!candidate?.operationId || !validHistoricalRecoveryEvidence(snapshot, evidence)) {
    throw new Error('Invalid approved historical event invoice evidence');
  }
  return recoveryRpc(db, 'approve_historical', { p_candidate: candidate, p_snapshot: snapshot, p_evidence: evidence });
}

export async function resolveHistoricalEventInvoiceRecovery({
  db, limit = 20, operationId = null, deadlineAt = Date.now() + 5000,
}) {
  const { reconstructHistoricalEventInvoices } = await import('./eventInvoiceReconstruction.js');
  await reconstructHistoricalEventInvoices({ db, limit, operationId, deadlineAt });
  return recoveryRpc(db, 'hydrate_historical', { p_limit: limit, p_id: operationId }, deadlineAt);
}

export function providerCooldown(retryAfter, now = Date.now(), random = Math.random) {
  const seconds = Number(retryAfter);
  const until = retryAfter != null && String(retryAfter).trim() !== '' && Number.isFinite(seconds)
    ? now + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);
  // No capped Retry-After: a long provider embargo must not be shortened.
  return new Date(Math.max(now, Number.isFinite(until) ? until : now) + 300_000 + Math.floor(random() * 30_000)).toISOString();
}

/** All immediate and cron work uses this same fenced claim, never an alternate checkout writer. */
export async function processEventInvoiceRecovery({
  db, tenantId = null, source = null, bookingGroupReference = null,
  providerFactory = null, now = Date.now, random = Math.random, deadlineAt = now() + 35_000,
} = {}) {
  const rpc = (name, args) => recoveryRpc(db, name, args, deadlineAt);
  const row = await rpc('claim', { p_tenant_id: tenantId, p_source: source, p_group: bookingGroupReference,
    p_tax_resolution: true });
  if (!row?.id) return { status: 'idle' };
  const identity = recoveryIdentity(row.tenant_id, row.source, row.booking_group_reference);
  const guard = async () => {
    if (now() >= deadlineAt) throw new EventInvoiceRecoveryError('time_budget', { retry: true });
    if (!await rpc('guard', { p_id: row.id, p_token: row.lease_token })) {
      throw new EventInvoiceRecoveryError('booking_or_lease_changed');
    }
  };
  let invoice = null;
  let activeWrite = null;
  try {
    if (row.snapshot?.paymentMethod === 'stripe' && row.snapshot?.settlement
      && row.snapshot.settlement.livemode !== true) {
      throw new EventInvoiceRecoveryError('settlement_live_mode_unverified');
    }
    const unresolved = validRecoveryTaxIntent(row.snapshot);
    if (!validRecoverySnapshot(row.snapshot) && !unresolved) throw new EventInvoiceRecoveryError('snapshot_unavailable');
    await guard();
    const factory = providerFactory || (await import('./eventInvoiceRecoveryXero.js')).createEventInvoiceRecoveryXero;
    let provider;
    if (unresolved) {
      const saved = await rpc('tax_authority', { p_id: row.id, p_token: row.lease_token });
      let resolved = saved;
      if (!resolved) {
        if (row.invoice_id || row.payment_id || row.invoice_write_started_at || row.payment_write_started_at) {
          throw new EventInvoiceRecoveryError('tax_resolution_after_write');
        }
        provider = await factory({ db, row, identity, guard, deadlineAt });
        resolved = await provider.resolveTaxIntent();
        if (!validRecoverySnapshot(resolved)) throw new EventInvoiceRecoveryError('tax_total_requires_review');
        await guard();
        resolved = await rpc('tax_authority', { p_id: row.id, p_token: row.lease_token, p_resolved: resolved });
      }
      if (!validRecoverySnapshot(resolved)) throw new EventInvoiceRecoveryError('tax_authority_unavailable');
      row.snapshot = resolved;
      provider = null;
    }
    provider ||= await factory({ db, row, identity, guard, deadlineAt });
    // Exact operation lookup always precedes writes, including after ambiguous timeouts.
    const invoices = await provider.findInvoices();
    if (!Array.isArray(invoices) || invoices.length > 1) throw new EventInvoiceRecoveryError('invoice_identity_ambiguous');
    invoice = invoices[0] || null;
    const payments = row.snapshot.paymentMethod === 'stripe' ? await provider.findPayments() : [];
    if (!Array.isArray(payments) || payments.length > 1) throw new EventInvoiceRecoveryError('payment_identity_ambiguous');
    if (!invoice && payments.length) throw new EventInvoiceRecoveryError('payment_without_invoice');
    if (!invoice) {
      if (row.invoice_id || row.invoice_write_started_at) throw new EventInvoiceRecoveryError('invoice_creation_ambiguous');
      await guard();
      if (!await rpc('start_write', { p_id: row.id, p_token: row.lease_token, p_kind: 'invoice' })) {
        throw new EventInvoiceRecoveryError('invoice_creation_ambiguous');
      }
      activeWrite = 'invoice';
      invoice = await provider.createInvoice();
      activeWrite = null;
    }
    provider.validateInvoice(invoice);
    if (!await rpc('record_invoice', {
      p_id: row.id, p_token: row.lease_token, p_invoice_id: invoice.InvoiceID,
      p_invoice_number: invoice.InvoiceNumber || null,
    })) throw new EventInvoiceRecoveryError('invoice_evidence_not_committed');
    let payment = payments[0] || null;
    if (row.snapshot.paymentMethod === 'stripe') {
      if (payment) provider.validatePayment(payment, invoice);
      else {
        if (row.payment_write_started_at) throw new EventInvoiceRecoveryError('payment_creation_ambiguous');
        // A paid/part-paid invoice without OUR exact settlement is not permission to pay again.
        if (invoice.Status === 'PAID' || Number(invoice.AmountPaid || 0) !== 0
          || Number(invoice.AmountDue) !== row.snapshot.amount) {
          throw new EventInvoiceRecoveryError('invoice_settlement_mismatch');
        }
        await guard();
        if (!await rpc('start_write', { p_id: row.id, p_token: row.lease_token, p_kind: 'payment' })) {
          throw new EventInvoiceRecoveryError('payment_creation_ambiguous');
        }
        activeWrite = 'payment';
        payment = await provider.createPayment(invoice);
        activeWrite = null;
        provider.validatePayment(payment, invoice);
      }
    }
    await guard();
    const completed = await rpc('finish', {
      p_id: row.id, p_token: row.lease_token, p_status: 'complete',
      p_invoice_id: invoice.InvoiceID, p_invoice_number: invoice.InvoiceNumber || null,
      p_payment_id: payment?.PaymentID || null,
    });
    if (!completed) throw new Error('Event invoice recovery lease lost before completion');
    return { status: 'complete' };
  } catch (error) {
    const known = error instanceof EventInvoiceRecoveryError;
    const retry = !known || error.retry;
    const cooldown = error.code === 'provider_rate_limited' ? providerCooldown(error.retryAfter, now(), random) : null;
    const next = cooldown || new Date(now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.attempts || 1, 6))
      + Math.floor(random() * 30_000)).toISOString();
    const retained = await recoveryRpc(db, 'finish', {
      p_id: row.id, p_token: row.lease_token, p_status: retry ? 'retry' : 'needs_review',
      p_next: retry ? next : null, p_cooldown: cooldown,
      p_rejected_write: error.code === 'provider_rate_limited' ? activeWrite : null,
      p_reason: known ? error.code : 'provider_or_transport_unavailable',
      p_invoice_id: invoice?.InvoiceID || null, p_invoice_number: invoice?.InvoiceNumber || null,
    }, deadlineAt + 5000);
    if (!retained) throw new Error('Event invoice recovery lease lost; result not committed');
    return { status: retry ? 'retry' : 'needs_review' };
  }
}

export async function reconcileEventInvoices({ db, providerFactory, now = Date.now, maxItems = 8, budgetMs = 45_000,
  includeHistorical = false } = {}) {
  const deadlineAt = now() + Math.min(45_000, Math.max(1000, budgetMs));
  await recoveryRpc(db, 'heartbeat', { p_success: false });
  // Current rollout is future checkout only. Historical discovery/reconstruction
  // remains an explicit administrative operation, never an implicit cron action.
  const swept = includeHistorical ? await recoveryRpc(db, 'sweep', { p_limit: 100 }) : 0;
  const hydrated = includeHistorical ? await resolveHistoricalEventInvoiceRecovery({ db, deadlineAt }) : 0;
  const counts = { complete: 0, retry: 0, needs_review: 0 };
  for (let i = 0; i < Math.min(8, maxItems) && now() < deadlineAt - 5000; i++) {
    const result = await processEventInvoiceRecovery({ db, providerFactory, now, deadlineAt: Math.min(deadlineAt, now() + 35_000) });
    if (result.status === 'idle') break;
    counts[result.status]++;
  }
  await recoveryRpc(db, 'heartbeat', { p_success: true });
  return { swept, hydrated, ...counts };
}