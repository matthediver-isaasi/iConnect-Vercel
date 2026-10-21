import { START_CAPABILITIES, normalizeStart, buildStartQuote, startFingerprint, startError } from './memberStartQuote.js';
import { getAccountingProvider } from './accountingProvider.js';
import { accountingMembershipQueueEnabled, queueMembershipInvoice } from './accountingQueueIntegration.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';
import { resolveMembershipNominalCode } from './membershipNominalCode.js';
import { fireNewZeroDueMembershipPaidWorkflow } from './zeroDueMembership.js';

function checked(result) {
  if (result.error) {
    const { code } = result.error;
    if (['42P01', 'PGRST202', 'PGRST205', '42883'].includes(code)) throw startError('The reviewed member-start database migration is required.', 503, 'migration_required');
    if (['40001', '23505', '23P01', 'P0001'].includes(code)) throw startError(result.error.message, 409, 'start_conflict');
    throw startError('Membership start data could not be read or persisted.', 500, 'database_error');
  }
  return result.data;
}
export function createMemberStartService({
  db, now = () => new Date(), getProvider = getAccountingProvider,
  queueEnabled = () => accountingMembershipQueueEnabled('member_membership_history'),
  invoice = queueMembershipInvoice, fireFree = fireNewZeroDueMembershipPaidWorkflow,
  address = resolveInvoiceAddress, nominal = resolveMembershipNominalCode,
} = {}) {
  const today = () => now().toISOString().slice(0, 10);
  const one = async (table, tenantId, id) => checked(await db.from(table).select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle());
  async function rows(table, tenantId, column, value) {
    const output = [];
    for (let offset = 0; ; offset += 500) {
      const page = checked(await db.from(table).select('*').eq('tenant_id', tenantId).eq(column, value).order('id').range(offset, offset + 499));
      output.push(...page);
      if (page.length < 500) return output;
    }
  }
  async function state(tenantId, memberId) {
    return checked(await db.rpc('member_start_state', { p_tenant_id: tenantId, p_member_id: memberId }));
  }
  async function describe(saved) {
    const record = await one('member_membership_history', saved.tenant_id, saved.record_id);
    let status = record?.payment_status === 'paid' ? 'completed' : 'pending_invoice';
    let accounting = null;
    if (saved.request.paymentMode === 'invoice') {
      accounting = checked(await db.from('accounting_request_queue').select('id,state,last_error')
        .eq('tenant_id', saved.tenant_id).eq('source_type', 'member_membership_history')
        .eq('source_id', saved.record_id).eq('operation', 'invoice').maybeSingle());
      if (record?.payment_status !== 'paid') status = accounting?.state === 'complete' ? 'pending_payment'
        : accounting?.state === 'review' ? 'reconciliation_required' : accounting ? 'accounting_pending' : 'pending_invoice';
    }
    return { id: saved.id, record_id: saved.record_id, created_at: saved.created_at, quote: saved.quote,
      reason: saved.request.reason, status, payment_status: record?.payment_status || null,
      accounting_request_id: accounting?.id || null, canResume: true,
      accounting_pending: !!accounting && accounting.state !== 'complete', reconciliation_required: status === 'reconciliation_required' };
  }
  async function list(tenantId, memberId) {
    const s = await state(tenantId, memberId);
    if (!s.member) throw startError('Member not found in tenant.', 404, 'member_not_found');
    const configs = await rows('membership_tier_config', tenantId, 'structure_scope_type', 'member');
    const bands = [];
    for (const config of configs) bands.push(...await rows('membership_tier_band', tenantId, 'config_id', config.id));
    const requests = await rows('member_membership_start', tenantId, 'member_id', memberId);
    return { member: { id: s.member.id, first_name: s.member.first_name, last_name: s.member.last_name, email: s.member.email },
      structures: configs.filter(c => c.is_active).map(c => ({ ...c, bands: bands.filter(b => b.config_id === c.id) })),
      blockers: s.blockers, requests: await Promise.all(requests.map(describe)),
      capabilities: { ...START_CAPABILITIES, invoiceAvailable: queueEnabled() } };
  }
  async function preview(tenantId, input) {
    const request = normalizeStart(input);
    const s = await state(tenantId, request.memberId);
    if (!s.member) throw startError('Member not found in tenant.', 404, 'member_not_found');
    if (s.blockers.length) return { canCreate: false, quote: null, expectedQuote: null, blockers: s.blockers };
    try {
      const config = await one('membership_tier_config', tenantId, request.configId);
      const band = request.bandId ? await one('membership_tier_band', tenantId, request.bandId) : null;
      const discounts = await rows('membership_tier_discount', tenantId, 'config_id', request.configId);
      const vatOverrides = await rows('membership_tier_vat_override', tenantId, 'config_id', request.configId);
      const overrides = await rows('member_membership_override', tenantId, 'member_id', request.memberId);
      const vatSetting = checked(await db.from('system_settings').select('*').eq('tenant_id', tenantId)
        .eq('setting_key', `xero_vat_rates_${tenantId}`).maybeSingle());
      const quote = buildStartQuote({ request, config, band, discounts, vatOverrides, overrides, vatSetting, today: today() });
      if (request.paymentMode === 'invoice') {
        if (!queueEnabled()) throw startError('Safe invoice creation requires the membership accounting request queue to be enabled.', 503, 'accounting_queue_required');
        const provider = await getProvider(tenantId);
        if (!['xero', 'quickbooks'].includes(provider?.name)) throw startError('A connected accounting provider is required.', 503, 'accounting_provider_required');
        // Finish all local, fallible preparation before accepting a durable purchase.
        quote.invoice = { provider: provider.name, organizationName: `${s.member.first_name || ''} ${s.member.last_name || ''}`.trim() || s.member.email,
          invoicingEmail: s.member.email || null, invoicingAddress: await address(db, config, request.memberId, 'member'),
          membershipYear: quote.membershipYear, tierLabel: quote.tierLabel, finalCost: quote.finalCost, currency: quote.currency,
          reference: 'TBC', vatRate: quote.taxType, nominalCode: await nominal(db, tenantId, { config, matchedBand: band }),
          invoiceDescription: config.invoice_description || null };
      }
      // Membership state as well as prices is part of the confirmation authority.
      quote.ownerState = s.fingerprint;
      return { canCreate: true, quote, expectedQuote: startFingerprint({ request, quote }), blockers: [] };
    } catch (error) {
      if (error.status === 422) return { canCreate: false, quote: null, expectedQuote: null, blockers: [error.message] };
      throw error;
    }
  }
  async function complete(saved, replayed) {
    let record = await one('member_membership_history', saved.tenant_id, saved.record_id);
    if (!record) throw startError('Saved membership history is missing; reconciliation is required.', 409, 'history_missing');
    if (saved.request.paymentMode === 'free') {
      try {
        await fireFree({ table: 'member_membership_history', row: record, paidAt: record.paid_at, client: db, source: 'admin_member_start_free' });
        return { request: { ...saved, status: 'completed' }, record, replayed };
      } catch {
        return { request: { ...saved, status: 'notification_pending' }, record, replayed, reconciliation_required: true,
          message: 'The zero-due purchase is saved. Retry this same confirmation to resume workflow delivery.' };
      }
    }
    try {
      // Never fall through to legacy non-durable invoicing. The queue resumes its
      // persisted source/provider identity before preparing any new external effect.
      const result = await invoice({ db, provider: saved.quote.invoice.provider, args: {
        ...saved.quote.invoice, appTenantId: saved.tenant_id,
        accountingSource: { sourceType: 'member_membership_history', sourceId: record.id,
          totalMinor: Math.round(saved.quote.totalWithVat * 100), linkage: { recordId: record.id, ownerId: saved.member_id },
          notification: { memberId: saved.member_id, memberName: saved.quote.invoice.organizationName,
            memberEmail: saved.quote.invoice.invoicingEmail, membershipYear: saved.quote.membershipYear,
            finalCost: saved.quote.finalCost, totalWithVat: saved.quote.totalWithVat, vatAmount: saved.quote.vatAmount,
            currency: saved.quote.currency, tierLabel: saved.quote.tierLabel, createdBy: saved.actor_id,
            note: `[Membership Start] ${saved.request.reason}` } },
      } });
      if (!result?.accounting_request_id) throw startError('Accounting queue is unavailable.');
      record = await one('member_membership_history', saved.tenant_id, saved.record_id);
      const review = result.accounting_state === 'review';
      return { request: { ...saved, status: review ? 'reconciliation_required' : result.accounting_pending ? 'accounting_pending' : 'pending_payment' },
        record, replayed, accounting_pending: !!result.accounting_pending, reconciliation_required: review,
        accounting_request_id: result.accounting_request_id };
    } catch {
      // History and request deliberately survive any ambiguity. A same-key retry
      // resumes the queue; it cannot insert a second purchase or blindly reissue.
      return { request: { ...saved, status: 'reconciliation_required' }, record, replayed, reconciliation_required: true,
        message: 'Purchase saved but invoice acceptance is unconfirmed. Retry the same confirmation to resume the durable accounting request; do not create another purchase.' };
    }
  }
  async function create(tenantId, actorId, input) {
    const request = { ...normalizeStart(input, true), expectedQuote: input.expectedQuote };
    const existing = checked(await db.from('member_membership_start').select('*').eq('tenant_id', tenantId)
      .eq('member_id', request.memberId).eq('idempotency_key', input.idempotencyKey).maybeSingle());
    if (existing) {
      if (startFingerprint(existing.request) !== startFingerprint(request)) throw startError('Idempotency key belongs to another request.', 409, 'idempotency_conflict');
      return complete(existing, true);
    }
    const result = await preview(tenantId, input);
    if (!result.canCreate || result.expectedQuote !== input.expectedQuote) throw startError('The quote or membership state changed. Preview again before confirming.', 409, 'quote_changed');
    const saved = checked(await db.rpc('create_member_start', { p_tenant_id: tenantId, p_member_id: request.memberId,
      p_actor_id: actorId, p_idempotency_key: input.idempotencyKey, p_request: request, p_quote: result.quote }));
    return complete(saved.request, saved.replayed);
  }
  async function resume(tenantId, input) {
    const saved = await one('member_membership_start', tenantId, input.requestId);
    if (!saved || saved.member_id !== input.memberId) throw startError('Start request not found for this tenant/member.', 404, 'request_not_found');
    // Resume from immutable server authority. Current pricing, blockers and
    // lost browser confirmation state must not reconstruct another purchase.
    return complete(saved, true);
  }
  return { list, preview, create, resume };
}
