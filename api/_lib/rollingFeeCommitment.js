import { buildRollingCommitment, commitmentFromQuote } from './rollingMembershipCommitment.js';
import { upfrontRollingCommitment } from './upfrontRollingRenewal.js';

export function workflowRollingCommitment(simResult, { zeroDue = false, addonTotals } = {}) {
  const commitment = upfrontRollingCommitment(simResult, {
    paymentMethod: zeroDue ? 'none' : 'invoice',
    ...(addonTotals ? { addonTotals } : {}),
  });
  if (!commitment.term_key) return {};
  const future = commitment.term_start_date > new Date().toISOString().slice(0, 10);
  return {
    ...commitment,
    ...commitment.commitment_snapshot.amounts,
    membership_year: commitment.term_key,
    payment_method: commitment.commitment_snapshot.payment_method,
    status: zeroDue ? (future ? 'scheduled' : 'active') : 'pending_payment_setup',
    ...(future && zeroDue ? { scheduled_activation_date: commitment.term_start_date } : {}),
  };
}

export async function hasRollingMonthlyArrangement(client, { tenantId, memberId, organizationId, simResult }) {
  if (simResult.config?.start_mode !== 'immediate') return false;
  if (simResult.previousTerm?.commitment_snapshot?.payment_frequency === 'monthly') return true;
  const { data, error } = await client.from('membership_billing_agreements').select('id')
    .eq('tenant_id', tenantId).eq(memberId ? 'member_id' : 'organization_id', memberId || organizationId)
    .in('status', ['payment_setup_required', 'mandate_pending', 'first_payment_pending', 'active', 'payment_grace_period', 'payment_overdue'])
    .limit(1);
  if (error) throw new Error(`Could not verify the existing membership payment arrangement: ${error.message}`);
  return !!data?.length;
}

// A fee link is a quote, not permission to re-price the member when it is opened.
export function feeTokenCommitment(token) {
  const commitment = commitmentFromQuote({ commitment: token?.cost_breakdown?.commitment });
  if (!commitment && (token?.cost_breakdown?.commitment || String(token?.membership_year).startsWith('rolling:'))) {
    throw new Error('This fee quote has no complete verified membership commitment; administrator review is required');
  }
  if (commitment?.term_key && commitment.term_key !== token.membership_year) {
    throw new Error('The fee quote does not match its membership term');
  }
  return commitment?.term_key ? commitment : null;
}

export function simulationFromFeeCommitment(token) {
  const commitment = feeTokenCommitment(token);
  if (!commitment) return null;
  const snapshot = commitment.commitment_snapshot;
  const amounts = snapshot.amounts;
  const pricing = snapshot.pricing || {};
  return {
    success: true,
    config: snapshot.config,
    membershipYear: {
      label: commitment.term_key,
      start: new Date(`${commitment.term_start_date}T00:00:00Z`),
      end: new Date(`${commitment.term_end_date}T00:00:00Z`),
    },
    commitment,
    rollingCommitment: commitment,
    previousTerm: token.cost_breakdown?.previousTerm || null,
    billingPeriod: snapshot.billing_period,
    currency: amounts.currency,
    annualCost: amounts.annual_cost,
    finalCost: amounts.final_cost,
    vatAmount: amounts.vat_amount,
    totalWithVat: amounts.total_with_vat,
    vatRatePercent: pricing.vat_rate_percent ?? null,
    tierLabel: pricing.tier_label || token.tier_label,
    matchedBand: pricing.band || null,
    fieldValue: pricing.field_value ?? null,
    existingRecord: !!token.history_record_id,
  };
}

export async function snapshotRollingFeeQuote(client, {
  tenantId, memberId, organizationId, membershipYear, tierConfig,
  historyRecordId, costBreakdown = {}, finalCost, currency, tierLabel,
}) {
  if (costBreakdown.commitment) {
    feeTokenCommitment({ membership_year: membershipYear, cost_breakdown: costBreakdown });
    return costBreakdown;
  }
  const table = memberId ? 'member_membership_history' : 'organisation_membership_history';
  const column = memberId ? 'member_id' : 'organization_id';
  if (historyRecordId) {
    const { data, error } = await client.from(table).select('*')
      .eq('tenant_id', tenantId).eq(column, memberId || organizationId)
      .eq('id', historyRecordId).maybeSingle();
    if (error) throw new Error(`Could not load the agreed membership term: ${error.message}`);
    if (data?.term_key) {
      const commitment = commitmentFromQuote({ commitment: data });
      if (commitment.term_key !== membershipYear) throw new Error('Fee quote history belongs to a different term');
      let previousTerm = null;
      if (data.previous_term_id) {
        const result = await client.from(table).select('*')
          .eq('tenant_id', tenantId).eq(column, memberId || organizationId)
          .eq('id', data.previous_term_id).maybeSingle();
        if (result.error || !result.data) throw new Error('Could not verify the preceding quoted membership term');
        previousTerm = result.data;
      }
      return { ...costBreakdown, commitment, ...(previousTerm ? { previousTerm } : {}) };
    }
  }
  if (tierConfig?.start_mode !== 'immediate') return costBreakdown;
  const match = /^rolling:(\d{4}-\d{2}-\d{2})$/.exec(membershipYear || '');
  if (!match) throw new Error('Rolling membership fees need a verified commencement date before they can be emailed');
  const { data: previous, error } = await client.from(table).select('*')
    .eq('tenant_id', tenantId).eq(column, memberId || organizationId)
    .eq('membership_renewal_date', match[1]).maybeSingle();
  if (error) throw new Error(`Could not verify the preceding membership term: ${error.message}`);
  const commitment = buildRollingCommitment({
    config: tierConfig,
    startDate: match[1],
    previousTerm: previous || null,
    paymentMethod: 'stripe',
    paymentFrequency: 'upfront',
    amounts: {
      annual_cost: costBreakdown.annualCost ?? finalCost,
      final_cost: finalCost,
      vat_amount: costBreakdown.vatAmount ?? 0,
      total_with_vat: costBreakdown.totalWithVat ?? finalCost,
      currency,
    },
    pricingSnapshot: {
      tier_label: tierLabel,
      vat_rate_percent: costBreakdown.vatRatePercent ?? null,
      band: costBreakdown.matchedBand || null,
    },
  });
  return { ...costBreakdown, commitment, ...(previous ? { previousTerm: previous } : {}) };
}

// The INSERT's database overlap/ownership guard is the financial reservation.
// It must succeed before any chargeable Stripe object is created.
export async function reserveRollingFeePayment(client, token) {
  const commitment = feeTokenCommitment(token);
  if (!commitment) {
    if (String(token.membership_year).startsWith('rolling:')) {
      throw new Error('This fee link has no verified pricing commitment; please ask an administrator to reissue it');
    }
    return null;
  }
  const table = token.member_id ? 'member_membership_history' : 'organisation_membership_history';
  const column = token.member_id ? 'member_id' : 'organization_id';
  const amounts = commitment.commitment_snapshot.amounts;
  const record = {
    ...commitment,
    tenant_id: token.tenant_id,
    [column]: token.member_id || token.organization_id,
    membership_year: commitment.term_key,
    config_id: commitment.commitment_snapshot.config_id,
    ...amounts,
    tier_label: token.tier_label,
    billing_period: commitment.commitment_snapshot.billing_period,
    payment_method: commitment.commitment_snapshot.payment_method,
    status: 'pending_payment_setup',
    payment_status: 'unpaid',
    notes: `Rolling fee quote: ${token.id}`,
  };
  // Collection-only snapshot properties are not history columns.
  delete record.monthly_amount;
  delete record.instalment_count;
  const { data, error } = await client.from(table).insert(record).select('*').maybeSingle();
  if (!error && data) return data;
  if (!['23505', '23P01'].includes(error?.code)) {
    throw new Error(`Could not reserve membership payment: ${error?.message || 'no row returned'}`);
  }
  const { data: existing, error: lookupError } = await client.from(table).select('*')
    .eq('tenant_id', token.tenant_id).eq(column, token.member_id || token.organization_id)
    .eq('term_key', commitment.term_key).maybeSingle();
  if (lookupError) throw new Error(`Could not verify the membership reservation: ${lookupError.message}`);
  if (!existing || existing.billing_agreement_id
      || !['stripe', 'invoice', 'upfront'].includes(existing.payment_method)
      || existing.payment_status === 'paid'
      || (existing.notes !== record.notes && existing.id !== token.history_record_id)
      || Number(existing.total_with_vat) !== Number(amounts.total_with_vat)
      || existing.membership_renewal_date !== commitment.membership_renewal_date) {
    throw new Error('A membership payment or different pricing commitment already exists for this term');
  }
  return existing;
}

export async function reserveRollingMonthlyHistory(client, agreement, snapshot, simResult) {
  const commitment = commitmentFromQuote(snapshot);
  if (!commitment) return null;
  const table = agreement.member_id ? 'member_membership_history' : 'organisation_membership_history';
  const column = agreement.member_id ? 'member_id' : 'organization_id';
  const method = commitment.commitment_snapshot.payment_method;
  const amounts = commitment.commitment_snapshot.amounts;
  const pricing = commitment.commitment_snapshot.pricing || {};
  if (agreement.tenant_id == null || (!!agreement.member_id === !!agreement.organization_id)) {
    throw new Error('A monthly commitment requires exactly one saved owner');
  }
  const row = {
    ...commitment,
    tenant_id: agreement.tenant_id,
    [column]: agreement.member_id || agreement.organization_id,
    membership_year: commitment.term_key,
    config_id: commitment.commitment_snapshot.config_id,
    band_id: pricing.band?.id || pricing.matchedBand?.id || null,
    tier_label: pricing.tier_label || snapshot.tier_label || null,
    field_value: pricing.field_value ?? snapshot.field_value ?? null,
    annual_cost: amounts.annual_cost,
    final_cost: amounts.final_cost,
    vat_amount: amounts.vat_amount,
    total_with_vat: amounts.total_with_vat,
    currency: amounts.currency,
    vat_rate_percent: pricing.vat_rate_percent ?? snapshot.vat_rate_percent
      ?? (amounts.final_cost ? Math.round(amounts.vat_amount / amounts.final_cost * 10000) / 100 : 0),
    payment_method: method,
    billing_period: method === 'card_monthly' ? 'monthly_card' : 'monthly_direct_debit',
    billing_agreement_id: agreement.id,
    status: 'pending_payment_setup',
    payment_status: 'unpaid',
  };
  const { data, error } = await client.from(table).insert(row).select('*').maybeSingle();
  if (!error && data) return data;
  if (['23505', '23P01'].includes(error?.code)) {
    const { data: existing, error: lookupError } = await client.from(table).select('*')
      .eq('tenant_id', agreement.tenant_id).eq(column, row[column])
      .eq('billing_agreement_id', agreement.id).maybeSingle();
    if (!lookupError && existing?.term_key === commitment.term_key) return existing;
  }
  throw new Error(`Could not reserve the monthly membership term: ${error?.message || 'another payment owns this term'}`);
}