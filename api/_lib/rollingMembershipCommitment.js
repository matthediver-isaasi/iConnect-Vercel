import { buildRollingTerm, isRollingCommitment, rollingDateString } from '../../shared/rollingMembershipTerm.js';

export const ROLLING_COMMITMENT_FIELDS = Object.freeze([
  'term_start_date', 'term_end_date', 'membership_renewal_date', 'term_duration_months',
  'term_anchor_date', 'term_key', 'previous_term_id', 'commitment_snapshot',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function money(value, name) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`An agreed ${name} is required for the membership commitment`);
  }
  return Math.round(Number(value) * 100) / 100;
}

/** Capture ONLY at the authoritative quote/consent boundary, not at callback time. */
export function buildRollingCommitment({
  config, startDate, previousTerm = null, paymentMethod, paymentFrequency, amounts, pricingSnapshot = {},
}) {
  if (config?.start_mode !== 'immediate') return {};
  if (!config.id) throw new Error('A membership structure identifier is required');
  if (!paymentMethod || !paymentFrequency) throw new Error('Membership payment method and frequency are required');
  const currency = amounts?.currency || config.currency;
  if (!/^[A-Z]{3}$/.test(currency || '')) throw new Error('A valid commitment currency is required');
  const agreed = { ...clone(amounts || {}), currency };
  for (const field of ['annual_cost', 'final_cost', 'vat_amount', 'total_with_vat']) {
    agreed[field] = money(amounts?.[field], field);
  }
  if (Math.abs(agreed.final_cost + agreed.vat_amount - agreed.total_with_vat) > 0.011) {
    throw new Error('Membership commitment total does not match net amount plus VAT');
  }
  if (agreed.monthly_amount != null) agreed.monthly_amount = money(agreed.monthly_amount, 'monthly amount');
  if (agreed.instalment_count != null && (!Number.isInteger(agreed.instalment_count) || agreed.instalment_count <= 0)) {
    throw new Error('A positive instalment count is required');
  }
  const term = buildRollingTerm({ startDate, billingPeriod: config.billing_period, previousTerm });
  return {
    ...term,
    commitment_snapshot: {
      version: 1,
      start_mode: 'immediate',
      config_id: config.id,
      billing_period: config.billing_period,
      config: clone(config),
      pricing: clone(pricingSnapshot),
      payment_method: paymentMethod,
      payment_frequency: paymentFrequency,
      amounts: agreed,
    },
  };
}

export function commitmentFromQuote(quote) {
  const source = quote?.commitment || quote;
  if (!isRollingCommitment(source) || !source.commitment_snapshot) return null;
  return Object.fromEntries(ROLLING_COMMITMENT_FIELDS.map((key) => [key, clone(source[key] ?? null)]));
}

export function commitmentFromAgreement(agreement) {
  return commitmentFromQuote(agreement)
    || commitmentFromQuote(agreement?.metadata?.commitment)
    || commitmentFromQuote(agreement?.metadata?.card?.commitment)
    || commitmentFromQuote(agreement?.metadata?.dd?.commitment);
}

function entityScope({ tenantId, memberId, organizationId }) {
  if (!tenantId || (!!memberId === !!organizationId)) {
    throw new Error('A tenant and exactly one membership owner are required');
  }
  return {
    table: memberId ? 'member_membership_history' : 'organisation_membership_history',
    column: memberId ? 'member_id' : 'organization_id',
    id: memberId || organizationId,
  };
}

export async function loadCurrentRollingCommitment(client, options) {
  const scope = entityScope(options);
  const onDate = rollingDateString(options.onDate || new Date());
  const { data, error } = await client.from(scope.table).select('*')
    .eq('tenant_id', options.tenantId).eq(scope.column, scope.id)
    .not('term_key', 'is', null)
    .lte('term_start_date', onDate).gt('membership_renewal_date', onDate)
    .order('term_start_date', { ascending: false }).limit(2);
  if (error) throw new Error(`Could not load membership commitment: ${error.message}`);
  if (data?.length > 1) throw new Error('Overlapping membership commitments require administrator review');
  return data?.[0] || null;
}

export async function persistRollingCommitment(client, { tenantId, memberId, organizationId, record }) {
  entityScope({ tenantId, memberId, organizationId });
  if (!commitmentFromQuote(record)) throw new Error('A complete rolling membership commitment is required');
  const { data, error } = await client.rpc('insert_rolling_membership_commitment', {
    p_tenant_id: tenantId,
    p_member_id: memberId || null,
    p_organization_id: organizationId || null,
    p_record: record,
  });
  if (error) throw new Error(`Could not persist membership commitment: ${error.message}`);
  return data;
}

/**
 * Conservative recovery: only original dated immutable consent/quotes are evidence.
 * created_at, paid_at, year labels and today's edited config are NOT evidence.
 */
export function reconstructLegacyRollingCommitment({ history, agreement = null, quote = null }) {
  const evidence = agreement?.metadata?.card || agreement?.metadata?.dd || quote;
  const config = evidence?.config_snapshot || evidence?.config;
  // Old references to an editable config ID are not configuration snapshots.
  if (!config || config.start_mode !== 'immediate' || config.id !== evidence.config_id) return null;
  const startDate = evidence.term_start_date || evidence.membership_start_date || evidence.membership_year_start;
  if (!startDate) return null;
  const datedEvidence = [evidence.term_start_date, evidence.membership_start_date, evidence.membership_year_start]
    .filter(Boolean).map(rollingDateString);
  if (datedEvidence.some((date) => date !== datedEvidence[0])) throw new Error('Conflicting legacy commencement dates');
  if ((agreement?.metadata?.previous_agreement_id || evidence.previous_term_id || evidence.renewal_of_agreement_id)
    && !evidence.term_anchor_date) return null;
  if (!agreement && (quote?.tenant_id !== history?.tenant_id
    || (history?.member_id && quote?.member_id !== history.member_id)
    || (history?.organization_id && quote?.organization_id !== history.organization_id))) return null;
  // Preserve proven financial data only; do not calculate a historic VAT rate
  // from the current tier, infer duration from instalment count, or use paid_at.
  const amounts = evidence.amounts || evidence;
  const commitment = buildRollingCommitment({
    config,
    startDate,
    paymentMethod: evidence.payment_method || (agreement?.provider === 'stripe' ? 'card_monthly' : agreement ? 'direct_debit' : null),
    paymentFrequency: evidence.payment_frequency || (agreement ? 'monthly' : null),
    amounts: {
      annual_cost: amounts.annual_cost,
      final_cost: amounts.final_cost,
      vat_amount: amounts.vat_amount,
      total_with_vat: amounts.total_with_vat ?? amounts.plan_total,
      currency: amounts.currency,
      ...(amounts.monthly_amount != null ? { monthly_amount: amounts.monthly_amount } : {}),
      ...(amounts.instalment_count != null ? { instalment_count: amounts.instalment_count } : {}),
    },
    pricingSnapshot: evidence.pricing_snapshot || {
      band_id: evidence.band_id || null,
      tier_label: evidence.tier_label || null,
      provenance: 'legacy_immutable_consent_or_payment_quote',
    },
  });
  // A legacy anchor different from commencement needs a proven predecessor.
  // Do not silently rewrite it to the current purchase's date.
  if (evidence.term_anchor_date && evidence.term_anchor_date !== commitment.term_anchor_date) return null;
  return commitment;
}

export function recoverRollingCommitment({ history, agreement = null, quote = null }) {
  // A DB-exported payment quote carries its payload under quote; retain the
  // database ownership alongside the payload rather than trusting payload IDs.
  if (quote?.quote) {
    const payload = quote.quote;
    quote = {
      ...payload,
      ...(payload.simResult?.commitment ? { commitment: payload.simResult.commitment } : {}),
      id: quote.id, tenant_id: quote.tenant_id, member_id: quote.member_id, organization_id: quote.organization_id,
    };
  }
  if (!history?.id || !history.tenant_id) return { status: 'review', id: history?.id, reason: 'History identifier and tenant are required' };
  if (quote && (quote.tenant_id !== history.tenant_id
    || (history.member_id && quote.member_id !== history.member_id)
    || (history.organization_id && quote.organization_id !== history.organization_id))) {
    return { status: 'review', id: history.id, reason: 'Payment quote ownership cannot be verified against this history row' };
  }
  const candidates = [commitmentFromQuote(history), commitmentFromAgreement(agreement), commitmentFromQuote(quote)].filter(Boolean);
  if (!candidates.length) {
    try {
      const recovered = reconstructLegacyRollingCommitment({ history, agreement, quote });
      if (recovered) candidates.push(recovered);
    } catch (error) {
      return { status: 'review', id: history.id, reason: `Legacy evidence is incomplete: ${error.message}` };
    }
  }
  if (!candidates.length) return { status: 'review', id: history?.id, reason: 'No complete dated quote or consent snapshot; anniversary cannot be inferred safely' };
  const candidate = candidates[0];
  if (candidates.some((item) => JSON.stringify(item) !== JSON.stringify(candidate))) {
    return { status: 'review', id: history?.id, reason: 'Conflicting dated commitment evidence' };
  }
  const snapshot = candidate.commitment_snapshot;
  const mismatch = (agreement && (
    agreement.tenant_id !== history.tenant_id
    || history.billing_agreement_id !== agreement.id
    || (history.member_id && history.member_id !== agreement.member_id)
    || (history.organization_id && history.organization_id !== agreement.organization_id)
  )) || history.config_id !== snapshot.config_id
    || ['annual_cost', 'final_cost', 'vat_amount', 'total_with_vat'].some((key) => (
      history[key] == null || Number(history[key]) !== Number(snapshot.amounts?.[key])
    )) || history.currency !== snapshot.amounts?.currency
    || ['term_start_date', 'term_end_date', 'membership_renewal_date'].some((key) => history[key] && history[key] !== candidate[key]);
  if (mismatch) return { status: 'review', id: history?.id, reason: 'Snapshot ownership, dates or agreed amounts do not match the history row' };
  try {
    const expected = buildRollingTerm({ startDate: candidate.term_start_date, billingPeriod: snapshot.billing_period, anchorDate: candidate.term_anchor_date });
    if (['term_start_date', 'term_end_date', 'membership_renewal_date', 'term_duration_months', 'term_anchor_date', 'term_key'].some((key) => expected[key] !== candidate[key])) {
      throw new Error('Inconsistent term boundaries');
    }
  } catch (error) {
    return { status: 'review', id: history?.id, reason: error.message };
  }
  return {
    status: isRollingCommitment(history) ? 'already_recorded' : 'recoverable',
    id: history.id,
    patch: candidate,
    ...(agreement && !isRollingCommitment(agreement) ? { agreement_patch: { id: agreement.id, ...candidate } } : {}),
  };
}

/** Apply only a reviewed recoverable candidate; the RPC re-reads and locks all
 * evidence, compares the export and validates original prices independently. */
export async function applyRecoveredRollingCommitment(client, { tenantId, evidence }) {
  if (!tenantId || evidence?.history?.tenant_id !== tenantId) {
    throw new Error('Recovery requires the explicitly selected matching tenant');
  }
  const candidate = recoverRollingCommitment(evidence);
  if (candidate.status !== 'recoverable') return candidate;
  const { data, error } = await client.rpc('recover_rolling_membership_commitment', {
    p_tenant_id: tenantId,
    p_history_type: evidence.history.member_id ? 'member' : 'organisation',
    p_history_id: evidence.history.id,
    p_expected_history: evidence.history,
    p_expected_agreement: evidence.agreement || null,
    p_expected_quote: evidence.quote || null,
    p_commitment: candidate.patch,
  });
  if (error) throw new Error(`Recovery was not applied: ${error.message}`);
  return data;
}