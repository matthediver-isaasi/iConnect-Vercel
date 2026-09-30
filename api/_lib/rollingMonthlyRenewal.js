import { createMembershipConfigResolver } from './membershipConfigResolverCore.js';
const { resolveRollingSuccessorConfig } = createMembershipConfigResolver(null);
import { buildRollingTerm, billingPeriodMonths } from '../../shared/rollingMembershipTerm.js';
import { buildRollingCommitment } from './rollingMembershipCommitment.js';
import { calculateMembershipYearWindow } from './membershipYear.js';
import { monthlySnapshotCommitment, monthlyRenewalIdentity, assertTrustedMonthlyTerm } from './monthlyRenewalTerms.js';
import { isDryRunEffectBoundary } from './directDebitDryRunRuntime.js';
export { monthlySnapshotCommitment, monthlyRenewalIdentity, assertTrustedMonthlyTerm } from './monthlyRenewalTerms.js';

export function monthlyCommitmentFields({ offer, simResult, paymentMethod }) {
  const fixedDd = paymentMethod === 'direct_debit'
    && simResult?.config?.start_mode !== 'immediate' && simResult?.membershipYear?.end;
  if (simResult?.config?.start_mode !== 'immediate' && !fixedDd) return {};
  const dynamic = paymentMethod === 'direct_debit' && offer.collectionPolicy?.pricing_policy === 'dynamic';
  const validationTotal = dynamic ? offer.monthlyAmount * offer.instalmentCount : offer.planTotal;
  // Provider instalments are gross collections. Derive the agreed net/VAT
  // from that total, not from a potentially different upfront annual quote.
  const rate = Number(simResult.vatRatePercent || 0);
  if (!Number.isFinite(rate) || rate < 0) throw new Error('Invalid membership VAT rate.');
  const net = Math.round((validationTotal / (1 + rate / 100)) * 100) / 100;
  const vat = Math.round((validationTotal - net) * 100) / 100;
  const fields = buildRollingCommitment({
    config: fixedDd ? { ...simResult.config, start_mode: 'immediate' } : simResult.config,
    startDate: simResult.membershipYear?.start,
    previousTerm: fixedDd ? null : simResult.previousTerm || null,
    paymentMethod,
    paymentFrequency: 'monthly',
    amounts: {
      annual_cost: simResult.annualCost,
      final_cost: net,
      total_with_vat: validationTotal,
      vat_amount: vat,
      currency: offer.currency,
      monthly_amount: offer.monthlyAmount,
      instalment_count: offer.instalmentCount,
    },
    pricingSnapshot: { band: simResult.matchedBand || null, tier_label: simResult.tierLabel, field_value: simResult.fieldValue ?? null },
  });
  if (fixedDd) {
    const end = new Date(simResult.membershipYear.end);
    fields.term_end_date = end.toISOString().slice(0, 10);
    fields.membership_renewal_date = new Date(end.getTime() + 86_400_000).toISOString().slice(0, 10);
    fields.term_key = `fixed:${fields.term_start_date}`;
    fields.previous_term_id = simResult.previousTerm?.id || null;
    // A successor remains in the original dated commitment chain. Changing
    // its anchor would violate the predecessor guard even at an exact boundary.
    fields.term_anchor_date = simResult.previousTerm?.term_anchor_date || fields.term_anchor_date;
    fields.commitment_snapshot.start_mode = 'fixed_date';
    fields.commitment_snapshot.config = JSON.parse(JSON.stringify(simResult.config));
  }
  if (paymentMethod === 'direct_debit' && offer.collectionPolicy) {
    fields.commitment_snapshot.collection_policy = { ...offer.collectionPolicy };
  }
  if (dynamic) {
    // An initial monthly quote is not a promise about the term's final total.
    Object.assign(fields.commitment_snapshot.amounts, {
      final_cost: null, vat_amount: null, total_with_vat: null,
    });
  }
  return fields;
}

export function monthlyInstalmentCount(config) {
  const configured = Math.min(12, Math.max(1, parseInt(config.dd_instalment_count, 10) || 12));
  return config.start_mode === 'immediate'
    ? Math.min(configured, billingPeriodMonths(config.billing_period))
    : configured;
}

async function resolveFixedSuccessorConfig(db, { tenantId, previousTerm }) {
  const prior = previousTerm.commitment_snapshot?.config;
  if (!prior) throw new Error('Saved structure scope is missing; review renewal before collecting.');
  const boundary = previousTerm.membership_renewal_date;
  const { data, error } = await db.from('membership_tier_config').select('*').eq('tenant_id', tenantId)
    .or(`effective_from.is.null,effective_from.lte.${boundary}`)
    .or(`effective_to.is.null,effective_to.gte.${boundary}`);
  if (error) throw new Error(`Could not resolve renewal structure: ${error.message}`);
  const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const matches = (data || []).filter((c) => c.is_active !== false && c.start_mode !== 'immediate'
    && equal(c.structure_scope_type || 'organization', prior.structure_scope_type || 'organization')
    && equal(c.structure_field_id, prior.structure_field_id)
    && equal(c.structure_match_value, prior.structure_match_value));
  if (matches.length !== 1) throw new Error(`Renewal on ${boundary} requires exactly one applicable structure.`);
  return matches[0];
}

/** Never resolve a rolling successor from cron time or reuse the expired tier. */
export async function simulateMonthlySuccessor({
  tenantId, memberId, organizationId, snapshot, simulate, source, resolveConfig = resolveRollingSuccessorConfig, db, provider,
}) {
  const ownerColumn = organizationId ? 'organization_id' : 'member_id';
  const ownerId = organizationId || memberId;
  let previousTerm = monthlySnapshotCommitment(snapshot);
  if (!previousTerm && provider === 'gocardless' && db) {
    await assertTrustedMonthlyTerm(db, tenantId, snapshot);
    // Pre-policy fixed-date agreements contain the purchased year start and
    // structure ID. Read that structure only for scope/dates, never authority.
    const start = snapshot?.membership_year_start;
    if (!start || !snapshot?.config_id) throw new Error('Legacy Direct Debit term requires review: saved start or structure is missing.');
    const { data: priorConfig, error } = await db.from('membership_tier_config').select('*')
      .eq('tenant_id', tenantId).eq('id', snapshot.config_id).maybeSingle();
    if (error || !priorConfig || priorConfig.start_mode === 'immediate') {
      throw new Error('Legacy Direct Debit structure cannot be verified for renewal.');
    }
    const startDate = new Date(`${String(start).slice(0, 10)}T00:00:00.000Z`);
    const window = calculateMembershipYearWindow(priorConfig, startDate);
    if (window.start.toISOString().slice(0, 10) !== String(start).slice(0, 10)) {
      throw new Error('Legacy membership year start conflicts with its saved structure; review is required.');
    }
    const end = window.end.toISOString().slice(0, 10);
    previousTerm = {
      term_key: `fixed:${String(start).slice(0, 10)}`, term_start_date: String(start).slice(0, 10),
      term_end_date: end, membership_renewal_date: new Date(window.end.getTime() + 86_400_000).toISOString().slice(0, 10),
      term_duration_months: 12, term_anchor_date: String(start).slice(0, 10),
      commitment_snapshot: { start_mode: 'fixed_date', config: priorConfig },
    };
  }
  if (!previousTerm) {
    if (db) await assertTrustedMonthlyTerm(db, tenantId, snapshot);
    if (snapshot?.start_mode === 'immediate') {
      throw new Error('Rolling membership commitment is missing; review its original agreed dates before renewal.');
    }
    return simulate(tenantId, ownerId, { source, mode: 'automatic' });
  }
  const boundary = previousTerm.membership_renewal_date;
  const fixedDd = provider === 'gocardless' && previousTerm.commitment_snapshot?.start_mode === 'fixed_date';
  if (db && provider) {
    const { data: reserved, error } = await db.from('membership_billing_agreements')
      .select('*').eq('tenant_id', tenantId).eq(ownerColumn, ownerId)
       .eq('provider', provider).eq('term_key', `${fixedDd ? 'fixed' : 'rolling'}:${boundary}`).maybeSingle();
    if (error) throw new Error(`Could not load reserved renewal terms: ${error.message}`);
    if (reserved) {
      const saved = reserved.metadata?.[provider === 'stripe' ? 'card' : 'dd'];
      const commitment = monthlySnapshotCommitment(saved);
      if (!commitment) throw new Error('Reserved renewal has no immutable commitment; review before collecting.');
      const terms = commitment.commitment_snapshot;
      return {
        success: true, config: terms.config, previousTerm,
        annualCost: terms.amounts.annual_cost, finalCost: terms.amounts.final_cost,
        vatAmount: terms.amounts.vat_amount, totalWithVat: terms.amounts.total_with_vat,
        vatRatePercent: saved.vat_rate_percent, currency: terms.amounts.currency,
        matchedBand: terms.pricing?.band, tierLabel: saved.tier_label,
        membershipYear: {
          label: fixedDd ? saved.membership_year : commitment.term_key,
          start: new Date(`${commitment.term_start_date}T00:00:00.000Z`),
          end: new Date(`${commitment.term_end_date}T00:00:00.000Z`),
        },
      };
    }
  }
  const config = await (fixedDd ? resolveFixedSuccessorConfig : resolveConfig)(db, { tenantId, previousTerm });
  if (!config || (config.structure_scope_type || 'organization') !== (organizationId ? 'organization' : 'member')
      || (!fixedDd && config.start_mode !== 'immediate')) {
    throw new Error(`No eligible rolling member structure is effective on ${boundary}; review the renewal before collecting payment.`);
  }
  const result = await simulate(tenantId, ownerId, {
    source, mode: 'automatic', configId: config.id, asOfDate: boundary,
    termStartDate: boundary, previousTerm,
  });
  if (!result?.success) return result;
  if (fixedDd) {
    if (new Date(result.membershipYear?.start).toISOString().slice(0, 10) !== boundary) {
      throw new Error('The successor membership period does not start at the saved renewal boundary.');
    }
    return { ...result, config, previousTerm };
  }
  const term = buildRollingTerm({
    startDate: boundary, billingPeriod: config.billing_period,
    anchorDate: previousTerm.term_anchor_date, previousTerm,
  });
  return {
    ...result, config, previousTerm,
    membershipYear: {
      label: term.term_key,
      start: new Date(`${term.term_start_date}T00:00:00.000Z`),
      end: new Date(`${term.term_end_date}T00:00:00.000Z`),
    },
  };
}

/** Refuse a shifted monthly schedule instead of silently charging after expiry. */
export function assertMonthlyCollectionsWithinTerm(snapshot, firstDate, count) {
  const commitment = monthlySnapshotCommitment(snapshot)
    || (snapshot?.membership_renewal_date ? {
      term_start_date: snapshot.membership_year_start,
      membership_renewal_date: snapshot.membership_renewal_date,
    } : null);
  if (!commitment || count <= 0) return;
  const first = new Date(firstDate);
  if (!Number.isFinite(first.getTime())) throw new Error('Monthly collection start date is invalid.');
  const last = new Date(first);
  const day = last.getUTCDate();
  last.setUTCDate(1);
  last.setUTCMonth(last.getUTCMonth() + count - 1);
  const maxDay = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
  last.setUTCDate(Math.min(day, maxDay));
  if (first.toISOString().slice(0, 10) < commitment.term_start_date
      || last.toISOString().slice(0, 10) >= commitment.membership_renewal_date) {
    throw new Error('Monthly collections would fall outside the agreed membership term; review the payment schedule.');
  }
}

/**
 * Reserve both local identities before any money-moving operation. A retry
 * adopts ONLY its own agreement/history; a cross-provider/history conflict
 * is an error, never permission to proceed with an orphan subscription.
 */
export async function reserveRollingMonthlyRenewal({
  db, tenantId, memberId, organizationId, previousAgreement, snapshot, provider, idempotencyKey, confirmedCheckout = false,
}) {
  const ownerColumn = organizationId ? 'organization_id' : 'member_id';
  const ownerId = organizationId || memberId;
  const historyTable = organizationId ? 'organisation_membership_history' : 'member_membership_history';
  const rail = provider === 'stripe' ? 'card' : 'dd';
  const commitment = monthlySnapshotCommitment(snapshot);
  if (!commitment) throw new Error('A complete rolling commitment is required for renewal.');
  let predecessorId = commitment.previous_term_id;
  if (!confirmedCheckout) {
    const { data: previousHistory, error: previousError } = await db.from(historyTable)
      .select('id').eq('tenant_id', tenantId).eq('billing_agreement_id', previousAgreement.id).maybeSingle();
    if (previousError || !previousHistory) {
      throw new Error(`Cannot verify predecessor membership: ${previousError?.message || 'history missing'}`);
    }
    predecessorId = previousHistory.id;
  }
  snapshot = {
    ...snapshot,
    commitment: { ...commitment, previous_term_id: predecessorId },
    renewal_of_agreement_id: previousAgreement.id,
    renewal_mode: confirmedCheckout ? 'confirmed' : 'auto',
  };
  const { data: found, error: findError } = await db.from('membership_billing_agreements')
    .select('*').eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (findError) throw new Error(`Could not check renewal reservation: ${findError.message}`);
  let agreement = found;
  if (!agreement) {
    const { data, error } = await db.from('membership_billing_agreements').insert({
      ...snapshot.commitment,
      tenant_id: tenantId, [ownerColumn]: ownerId, agreement_type: organizationId ? 'organization' : 'member', provider,
      ...(organizationId ? {
        dd_payer: previousAgreement.dd_payer,
        billing_contact_name: previousAgreement.billing_contact_name,
        billing_contact_email: previousAgreement.billing_contact_email,
        primary_contact_member_id: previousAgreement.primary_contact_member_id,
        mandate_completed_by: previousAgreement.mandate_completed_by,
      } : {}),
      status: 'payment_setup_required', idempotency_key: idempotencyKey,
      environment: previousAgreement.environment || (provider === 'stripe' ? 'live' : 'sandbox'),
      metadata: {
        [rail]: snapshot, commitment: snapshot.commitment, renewal_setup_pending: true,
      },
    }).select().single();
    if (error && error.code !== '23505') throw new Error(`Could not reserve renewal agreement: ${error.message}`);
    agreement = data;
    if (!agreement) {
      const { data: raced, error: raceError } = await db.from('membership_billing_agreements')
        .select('*').eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (raceError || !raced) throw new Error('Renewal reservation conflict requires review.');
      agreement = raced;
    }
  }
  if (agreement.provider !== provider || agreement[ownerColumn] !== ownerId
      || agreement.metadata?.[rail]?.renewal_of_agreement_id !== previousAgreement.id) {
    throw new Error('The next term is already reserved by a different payment agreement.');
  }
  // The persisted quote wins on re-entry, even after later pricing edits.
  snapshot = agreement.metadata[rail];
  const { data: existing, error: existingError } = await db.from(historyTable)
    .select('id, billing_agreement_id').eq('tenant_id', tenantId).eq(ownerColumn, ownerId)
    .eq('membership_year', snapshot.membership_year || snapshot.commitment.term_key).maybeSingle();
  if (existingError) throw new Error(`Cannot check next membership term: ${existingError.message}`);
  if (existing && existing.billing_agreement_id !== agreement.id) {
    throw new Error('The next membership term already belongs to another payment agreement.');
  }
  if (!existing) {
    const { error } = await db.from(historyTable).insert({
      ...snapshot.commitment,
      tenant_id: tenantId, [ownerColumn]: ownerId,
      membership_year: snapshot.membership_year || snapshot.commitment.term_key,
      config_id: snapshot.config_id, band_id: snapshot.band_id,
      tier_label: snapshot.tier_label, annual_cost: snapshot.annual_cost,
      final_cost: snapshot.commitment.commitment_snapshot.amounts.final_cost,
      total_with_vat: snapshot.plan_total,
      currency: snapshot.currency,
      vat_amount: snapshot.commitment.commitment_snapshot.amounts.vat_amount,
      billing_period: snapshot.kind,
      payment_method: provider === 'stripe' ? 'card_monthly' : 'direct_debit',
      status: 'pending_payment_setup', payment_status: 'unpaid', billing_agreement_id: agreement.id,
    });
    if (error) {
      if (error.code !== '23505') throw new Error(`Could not reserve next membership term: ${error.message}`);
        const { data: raced, error: raceError } = await db.from(historyTable)
          .select('id, billing_agreement_id').eq('tenant_id', tenantId).eq(ownerColumn, ownerId)
          .eq('membership_year', snapshot.membership_year || snapshot.commitment.term_key).maybeSingle();
      if (raceError || raced?.billing_agreement_id !== agreement.id) {
        throw new Error('Concurrent next-term membership conflict; no payment was started.');
      }
    }
  }
  return { agreement, snapshot };
}

export async function completeRollingMonthlySetup(db, agreement, fields = {}) {
  const { data: fresh, error: readError } = await db.from('membership_billing_agreements')
    .select('metadata').eq('id', agreement.id).eq('tenant_id', agreement.tenant_id).maybeSingle();
  if (readError || !fresh) throw new Error(`Could not reload renewal setup: ${readError?.message || 'agreement missing'}`);
  const { error } = await db.from('membership_billing_agreements').update({
    ...fields,
    metadata: { ...fresh.metadata, renewal_setup_pending: false },
    updated_at: new Date().toISOString(),
  }).eq('id', agreement.id).eq('tenant_id', agreement.tenant_id);
  if (error) throw new Error(`Could not complete renewal payment setup: ${error.message}`);
}

export function monthlyActivationSchedule(snapshot, activate, now = new Date()) {
  const commitment = monthlySnapshotCommitment(snapshot);
  if (activate && commitment && now.toISOString().slice(0, 10) < commitment.term_start_date) {
    return { status: 'scheduled', scheduled_activation_date: commitment.term_start_date };
  }
  return { status: activate ? 'active' : (snapshot.activation_rule === 'manual' ? 'pending_activation' : null) };
}

/** Existing renewal ledger doubles as a lease/outbox for rolling notices. */
export async function sendRollingMonthlyNotice({
  db, tenantId, agreement, renewalYear, mode, eventKey, sendEmail, extraContext, now = new Date(),
}) {
  const claimedAt = now.toISOString();
  const identity = {
    tenant_id: tenantId,
    ...(agreement.organization_id ? { organization_id: agreement.organization_id } : { member_id: agreement.member_id }),
    previous_agreement_id: agreement.id, renewal_year: renewalYear,
  };
  const readPrior = async () => {
    const { data: prior, error } = await db.from('membership_dd_renewals').select('*')
      .eq('tenant_id', tenantId).eq('previous_agreement_id', agreement.id).eq('renewal_year', renewalYear).maybeSingle();
    if (error) throw new Error(`Could not inspect renewal notice: ${error.message}`);
    return prior;
  };
  const reclaim = async prior => {
    if (!prior || !['notice_processing', 'notice_error'].includes(prior.status)
        || (prior.status === 'notice_processing' && now - new Date(prior.updated_at) < 15 * 60 * 1000)) {
      return null;
    }
    const { data, error: claimError } = await db.from('membership_dd_renewals')
      .update({ status: 'notice_processing', updated_at: claimedAt, failure_reason: null })
      .eq('id', prior.id).eq('tenant_id', tenantId).eq('status', prior.status).eq('updated_at', prior.updated_at)
      .select().maybeSingle();
    if (claimError) throw new Error(`Could not reclaim renewal notice: ${claimError.message}`);
    return data;
  };
  // Read existing duplicate/in-flight evidence without taking a reservation.
  // The insert uniqueness and reclaim CAS still arbitrate races afterward.
  const prior = await readPrior();
  let claim;
  if (prior) {
    claim = await reclaim(prior);
  } else {
    const { data: inserted, error: insertError } = await db.from('membership_dd_renewals').insert({
      ...identity, mode, status: 'notice_processing', updated_at: claimedAt,
    }).select().maybeSingle();
    if (insertError && insertError.code !== '23505') throw new Error(`Could not claim renewal notice: ${insertError.message}`);
    claim = insertError ? await reclaim(await readPrior()) : inserted;
  }
  if (!claim) return { sent: false, claimedElsewhere: true };
  let result;
  try {
    result = await sendEmail(eventKey, agreement, { db, extraContext });
    if (!result?.sent) throw new Error(result?.reason || 'Renewal notice was not delivered');
  } catch (error) {
    if (isDryRunEffectBoundary(error)) throw error;
    const { error: persistError } = await db.from('membership_dd_renewals')
      .update({ status: 'notice_error', failure_reason: error.message, updated_at: claimedAt })
      .eq('id', claim.id).eq('tenant_id', tenantId).eq('status', 'notice_processing').eq('updated_at', claimedAt);
    if (persistError) throw new Error(`Could not record renewal notice failure: ${persistError.message}`);
    throw error;
  }
  const { error } = await db.from('membership_dd_renewals')
    .update({ status: 'notice_sent', notice_sent_at: claimedAt, updated_at: claimedAt })
    .eq('id', claim.id).eq('tenant_id', tenantId).eq('status', 'notice_processing').eq('updated_at', claimedAt);
  if (error) throw new Error(`Could not complete renewal notice: ${error.message}`);
  return result;
}