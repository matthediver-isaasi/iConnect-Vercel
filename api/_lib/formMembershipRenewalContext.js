import { assessFormMembershipRenewalEvidence } from './formMembershipRenewalEvidence.js';
import { addDays, toDateString } from './annualRenewalPolicy.js';
import { createHash } from 'node:crypto';
import { membershipSuccessorElectionsEnabled } from './membershipSuccessorElection.js';
import { loadExpiryOnlyRenewalPolicy } from './expiryOnlyRenewalPolicy.js';
import { hasFormExpiryOnlyProvenance } from './formExpiryOnlyRenewal.js';

async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query.order('id').range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error(`Membership evidence unavailable: ${error?.message || 'invalid response'}`);
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

/** Server-only discovery. No request-supplied structure, year or price is used. */
export async function loadFormMembershipRenewalContext(db, {
  tenantId, memberId, organizationId = null, simulate, now = new Date(),
}) {
  // Rollout is schema-gated. Before the reviewed migration is installed, keep
  // existing payment behavior; never enable elections without their DB fence.
  if (!await membershipSuccessorElectionsEnabled(db, tenantId)) {
    return { renewal: { state: 'joining', eligible: false, renewalChoicesUnavailable: true }, simulation: null };
  }
  const ownerColumn = organizationId ? 'organization_id' : 'member_id';
  const ownerId = organizationId || memberId;
  const historyTable = organizationId ? 'organisation_membership_history' : 'member_membership_history';
  const scope = { tenantId, ...(organizationId ? { organizationId } : { memberId }) };
  const [histories, agreements, owners] = await Promise.all([
    allRows(db.from(historyTable).select('*').eq('tenant_id', tenantId).eq(ownerColumn, ownerId)),
    allRows(db.from('membership_billing_agreements').select('*').eq('tenant_id', tenantId).eq(ownerColumn, ownerId)),
    allRows(db.from(organizationId ? 'organization' : 'member').select('*').eq('tenant_id', tenantId).eq('id', ownerId)),
  ]);
  if (owners.length !== 1) throw new Error('Membership owner cannot be verified');
  const evidence = { ...scope, histories, agreements, now, paused: owners[0].membership_paused === true };
  if (evidence.paused) return { renewal: { state: 'paused', eligible: false }, simulation: null };
  const retained = histories.filter(row => !['cancelled', 'canceled', 'void', 'expired_checkout'].includes(row.status));
  if (!retained.length) return { renewal: assessFormMembershipRenewalEvidence(evidence), simulation: null };
  evidence.expiryOnlyPolicies = {};
  if (!organizationId) {
    for (const history of retained.filter(row => row.term_start_date == null)) {
      if (!hasFormExpiryOnlyProvenance(history, tenantId)) continue;
      const policy = await loadExpiryOnlyRenewalPolicy(db, { tenantId, history });
      if (policy) evidence.expiryOnlyPolicies[history.id] = policy;
    }
  }
  const today = toDateString(now);
  const previous = retained.filter(row => row.term_start_date && row.term_start_date <= today)
    .sort((a, b) => b.term_start_date.localeCompare(a.term_start_date))[0]
    || retained.find(row => evidence.expiryOnlyPolicies[row.id]);
  const assigned = evidence.expiryOnlyPolicies[previous?.id];
  const priorConfig = previous?.renewal_policy_snapshot || previous?.commitment_snapshot?.config || previous?.incentive_snapshot?.config;
  let successorConfig = null;
  if (previous?.term_end_date && (priorConfig || assigned)) {
    const start = toDateString(addDays(previous.term_end_date, 1));
    const configs = await allRows(db.from('membership_tier_config').select('*').eq('tenant_id', tenantId));
    const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    const eligible = configs.filter(config => config.is_active !== false
      && (assigned ? config.id === assigned.configId : (
      equal(config.start_mode || 'fixed_date', priorConfig.start_mode || 'fixed_date')
      && equal(config.structure_scope_type || 'organization', priorConfig.structure_scope_type || 'organization')
      && equal(config.structure_field_id, priorConfig.structure_field_id)
      && equal(config.structure_match_value, priorConfig.structure_match_value)))
      && (!config.effective_from || config.effective_from <= start)
      && (!config.effective_to || config.effective_to >= start));
    if (eligible.length === 1) successorConfig = eligible[0];
  }
  const renewal = assessFormMembershipRenewalEvidence({ ...evidence, successorConfig });
  // Uncertain/missing migration must never enable a renewal payment.
  const elections = await allRows(db.from('membership_successor_election').select('*')
    .eq('tenant_id', tenantId).eq(ownerColumn, ownerId));
  // A pending successor becomes the latest started history at commencement.
  // Its election still belongs to the original predecessor. Discover through
  // persisted child identity, not through whichever history is newest today.
  const pending = elections.filter(row => {
    if (row.status === 'released' || !histories.some(history => history.id === row.previous_term_id)) return false;
    const ownedAgreements = agreements.filter(agreement => agreement.membership_successor_election_id === row.id);
    const children = histories.filter(history => history.membership_successor_election_id === row.id
      || (row.payment_quote_id && history.membership_payment_quote_id === row.payment_quote_id)
      || ownedAgreements.some(agreement => agreement.id === history.billing_agreement_id));
    if (children.some(history => history.payment_status === 'paid')) return false;
    return !children.length
      || children.some(history => ['pending_payment_setup', 'pending', 'scheduled'].includes(history.status))
      || ownedAgreements.some(agreement => ['payment_setup_required', 'mandate_pending', 'first_payment_pending'].includes(agreement.status));
  });
  if (pending.length > 1) return { renewal: { state: 'review_required', eligible: false,
    message: 'Multiple pending successor reservations require review.' }, simulation: null };
  const election = pending[0];
  const electionPredecessor = election && histories.find(history => history.id === election.previous_term_id);
  if (election) return {
    renewal: { ...renewal, ...election.quote?.simulation?.formRenewal,
      currentStart: electionPredecessor.term_start_date, currentEnd: electionPredecessor.term_end_date,
      currentPaymentStatus: electionPredecessor.payment_status || 'unknown',
      currentAgreementId: electionPredecessor.billing_agreement_id || null,
      successorStart: election.term_start_date || renewal.successorStart,
      successorEnd: election.term_end_date || renewal.successorEnd,
      eligible: false, state: 'renewal_pending', electionId: election.id,
      switchState: election.switch_state || 'idle',
      selectedMethod: election.payment_method, message: 'A next-term payment arrangement is already reserved. Do not pay again.' },
    election,
    simulation: election.quote?.simulation || null,
  };
  if (renewal.state === 'next_term_purchased') return { renewal, simulation: null };
  if (!renewal.eligible) return { renewal, simulation: null };
  if (assigned) {
    const { data, error } = await db.rpc('form_expiry_only_renewal_supported');
    if (error && !['42883', 'PGRST202'].includes(error.code)) throw new Error('Expiry-only reservation capability unavailable');
    if (error || data !== true) return { renewal: { ...renewal, eligible: false,
      state: 'review_required', reason: 'expiry_only_reservation_migration_required' }, simulation: null };
  }
  const simulation = await simulate(tenantId, ownerId, {
    source: 'form-renewal', mode: 'manual', configId: successorConfig.id,
    asOfDate: renewal.successorStart, termStartDate: renewal.successorStart,
    ...(assigned ? { expiryOnlyHistoryId: previous.id }
      : successorConfig.start_mode === 'immediate' ? { previousTerm: previous } : {}),
  });
  if (!simulation?.success || simulation.existingRecord) {
    return { renewal: { ...renewal, eligible: false, state: 'review_required',
      message: simulation?.error || 'The successor term cannot be quoted safely.' }, simulation: null };
  }
  // Fixed and rolling quotes must agree with the authoritative persisted boundary.
  if (toDateString(simulation.membershipYear?.start) !== renewal.successorStart
      || toDateString(simulation.membershipYear?.end) !== renewal.successorEnd) {
    return { renewal: { ...renewal, eligible: false, state: 'review_required',
      message: 'The successor structure does not produce the saved renewal boundary.' }, simulation: null };
  }
  // Election/formRenewal retain predecessor identity. Rolling builders must not
  // interpret an expiry-only predecessor as a complete historical commitment.
  simulation.previousTerm = assigned ? null : previous;
  simulation.paymentSchedule = {
    term_start_date: renewal.successorStart, term_end_date: renewal.successorEnd,
    // Fixed upfront histories are not monthly/rolling commitments. The
    // election stores their predecessor without violating completeness guards.
    status: renewal.successorStart > today ? 'scheduled' : 'active',
    scheduled_activation_date: renewal.successorStart > today ? renewal.successorStart : null,
    annual_renewal_state: 'open',
  };
  simulation.formRenewal = { ...renewal };
  renewal.quoteKey = createHash('sha256').update(JSON.stringify({
    ownerId, previous: previous.id, year: simulation.membershipYear,
    config: simulation.config, net: simulation.finalCost, gross: simulation.totalWithVat,
  })).digest('hex');
  return { renewal, simulation };
}