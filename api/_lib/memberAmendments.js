import { createHash } from 'node:crypto';
import {
  AMENDMENT_CAPABILITIES, AmendmentError, buildMemberAmendmentQuote, currentAmendmentBlockers,
} from './memberAmendmentQuote.js';

export const AMENDMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 500;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function memberAmendmentQuoteFingerprint(quote) {
  const { quotedAt, ...stable } = quote;
  return createHash('sha256').update(JSON.stringify(canonical(stable))).digest('hex');
}

async function allPages(query) {
  const result = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = checkResult(await query().order('id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1));
    if (!Array.isArray(page)) throw new AmendmentError('Membership amendment query returned an invalid page.', 500, 'database_error');
    result.push(...page);
    if (page.length < PAGE_SIZE) return result;
  }
}

function checkResult(result) {
  if (result.error) {
    const error = result.error;
    if (['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code)) {
      throw new AmendmentError('Membership amendment migration is not available. Apply the reviewed migration before using this endpoint.', 503, 'migration_required');
    }
    if (error.code === '40001' || error.code === '23505') {
      throw new AmendmentError(error.message, 409, 'amendment_conflict');
    }
    throw new AmendmentError('Membership amendment data could not be read or persisted.', 500, 'database_error');
  }
  return result.data;
}

export function normalizeAmendmentRequest(input) {
  if (!AMENDMENT_UUID.test(input?.memberId || '') || !AMENDMENT_UUID.test(input?.configId || '')
      || (input.bandId != null && !AMENDMENT_UUID.test(input.bandId))) {
    throw new AmendmentError('Valid memberId, configId and optional bandId UUIDs are required.', 400, 'invalid_request');
  }
  if (input.settlementChoice !== 'defer') throw new AmendmentError('Only settlementChoice "defer" is supported. No settlement integration is enabled.', 400, 'unsupported_settlement');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 2000) {
    throw new AmendmentError('A reason between 1 and 2000 characters is required.', 400, 'invalid_reason');
  }
  return {
    memberId: input.memberId.toLowerCase(), configId: input.configId.toLowerCase(),
    bandId: input.bandId?.toLowerCase() || null, effectiveDate: input.effectiveDate,
    reason: input.reason.trim(), settlementChoice: 'defer',
  };
}

export function createMemberAmendmentsService({ db, now = () => new Date() }) {
  const rows = async (table, tenantId, memberId) => allPages(() => db.from(table).select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId));
  const one = async (table, tenantId, id) => checkResult(await db.from(table).select('*')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle());
  async function context(tenantId, memberId) {
    const member = await one('member', tenantId, memberId);
    if (!member) throw new AmendmentError('Member not found in this tenant.', 404, 'member_not_found');
    const today = now().toISOString().slice(0, 10);
    const purchases = await rows('member_membership_history', tenantId, memberId);
    const candidates = purchases.filter((row) => row.status === 'active'
      && row.term_start_date <= today && (row.membership_renewal_date ? today < row.membership_renewal_date : today <= row.term_end_date));
    const current = candidates.length === 1 ? candidates[0] : null;
    return { current, today, blockers: candidates.length > 1
      ? ['Overlapping current personal purchases require review.'] : currentAmendmentBlockers(current, today) };
  }
  async function list(tenantId, memberId) {
    const state = await context(tenantId, memberId);
    const configs = await allPages(() => db.from('membership_tier_config').select('*')
      .eq('tenant_id', tenantId).eq('structure_scope_type', 'member').eq('is_active', true)
      .lte('effective_from', state.today));
    const bands = await allPages(() => db.from('membership_tier_band').select('*').eq('tenant_id', tenantId));
    const history = (await rows('member_membership_amendment', tenantId, memberId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return {
      current: state.current,
      structures: configs.filter((config) => !config.effective_to || config.effective_to >= state.today)
        .map((config) => ({ ...config, bands: bands.filter((band) => band.config_id === config.id) })),
      history, currentTermHistory: history.filter((row) => row.source_record_id === state.current?.id),
      capabilities: AMENDMENT_CAPABILITIES, blockers: state.blockers,
    };
  }
  async function preview(tenantId, request) {
    const state = await context(tenantId, request.memberId);
    if (state.blockers.length) return { quote: null, canCreate: false, blockers: state.blockers };
    const config = await one('membership_tier_config', tenantId, request.configId);
    const band = request.bandId ? await one('membership_tier_band', tenantId, request.bandId) : null;
    const rules = async (table) => allPages(() => db.from(table).select('*')
      .eq('tenant_id', tenantId).eq('config_id', request.configId));
    const discounts = await rules('membership_tier_discount');
    const vatOverrides = await rules('membership_tier_vat_override');
    const vatSetting = checkResult(await db.from('system_settings').select('*')
      .eq('tenant_id', tenantId).eq('setting_key', `xero_vat_rates_${tenantId}`).maybeSingle());
    try {
      const quote = buildMemberAmendmentQuote({
        current: state.current, config, band, discounts, vatOverrides, vatSetting,
        effectiveDate: request.effectiveDate, today: state.today, quotedAt: now().toISOString(),
      });
      return { quote, expectedQuote: memberAmendmentQuoteFingerprint(quote), canCreate: true, blockers: quote.blockers };
    } catch (error) {
      if (error instanceof AmendmentError && error.status === 422) return { quote: null, canCreate: false, blockers: [error.message] };
      throw error;
    }
  }
  async function create(tenantId, actorId, input) {
    const normalized = normalizeAmendmentRequest(input);
    if (typeof input.expectedQuote !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedQuote)) {
      throw new AmendmentError('expectedQuote from the displayed preview is required before creating a proposal.', 400, 'expected_quote_required');
    }
    const request = { ...normalized, expectedQuote: input.expectedQuote };
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
      throw new AmendmentError('An idempotencyKey of 8–128 safe characters is required.', 400, 'invalid_idempotency_key');
    }
    const existing = checkResult(await db.from('member_membership_amendment').select('*')
      .eq('tenant_id', tenantId).eq('member_id', request.memberId).eq('idempotency_key', key).maybeSingle());
    if (existing) {
      if (Object.keys(request).some((field) => request[field] !== existing.request[field])) {
        throw new AmendmentError('This idempotency key belongs to a different request.', 409, 'idempotency_conflict');
      }
      return { amendment: existing, replayed: true };
    }
    const result = await preview(tenantId, request);
    if (!result.canCreate) {
      throw new AmendmentError(`The displayed quote is no longer eligible. Preview again: ${result.blockers.join(' ')}`, 409, 'quote_changed');
    }
    if (result.expectedQuote !== input.expectedQuote) {
      throw new AmendmentError('The quoted purchase, target pricing or term changed. Preview again before confirming.', 409, 'quote_changed');
    }
    return checkResult(await db.rpc('propose_member_membership_amendment', {
      p_tenant_id: tenantId, p_member_id: request.memberId, p_actor_id: actorId,
      p_idempotency_key: key, p_request: request, p_quote: result.quote,
    }));
  }
  return { list, preview: async (tenantId, input) => preview(tenantId, normalizeAmendmentRequest(input)), create };
}
