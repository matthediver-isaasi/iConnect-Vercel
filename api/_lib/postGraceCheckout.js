import { assessPostGraceRenewal } from './postGraceRenewal.js';
import { toDateString } from './annualRenewalPolicy.js';

async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query.order('id', { ascending: true }).range(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error('Post-grace eligibility evidence is unavailable');
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function loadPostGraceSimulationAuthority(db, {
  tenantId, memberId, config, predecessorId, start, now,
}) {
  if (!memberId || config?.start_mode !== 'immediate' || start !== toDateString(now)) {
    throw new Error('Post-grace simulation requires a current payment-dated annual term');
  }
  const [members, histories, agreements, elections, policies] = await Promise.all([
    allRows(db.from('member').select('*').eq('tenant_id', tenantId).eq('id', memberId)),
    allRows(db.from('member_membership_history').select('*').eq('tenant_id', tenantId).eq('member_id', memberId)),
    allRows(db.from('membership_billing_agreements').select('*').eq('tenant_id', tenantId).eq('member_id', memberId)),
    allRows(db.from('membership_successor_election').select('*').eq('tenant_id', tenantId).eq('member_id', memberId)),
    db.from('membership_post_grace_policy').select('enabled').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (policies.error || members.length !== 1) throw new Error('Post-grace policy or owner is unavailable');
  const renewal = assessPostGraceRenewal({
    tenantId, member: members[0], histories, agreements,
    elections: elections.filter(election => !histories.some(history =>
      history.membership_successor_election_id === election.id && history.payment_status === 'paid')),
    configs: [config], selectedConfigId: config.id, enabled: policies.data?.enabled === true, today: now,
  });
  if (!renewal.eligible || renewal.predecessorId !== predecessorId
      || renewal.term_start_date !== start) {
    throw new Error('Post-grace simulation evidence changed or requires review');
  }
  return renewal;
}

/** Server-loaded evidence only; never accept a client-supplied class or term. */
export async function quotePostGraceRenewal(db, {
  tenantId, member, histories, agreements, elections, configs, selectedConfigId = null,
  simulate, now = new Date(),
}) {
  const { data: policy, error } = await db.from('membership_post_grace_policy').select('enabled')
    .eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error('Post-grace policy could not be checked');
  const pending = elections.filter(election => election.status !== 'released'
    && !histories.some(history => history.membership_successor_election_id === election.id
      && history.payment_status === 'paid'));
  const renewal = assessPostGraceRenewal({
    tenantId, member, histories, agreements, elections: pending, configs,
    selectedConfigId, today: now, enabled: policy?.enabled === true,
  });
  if (!renewal.eligible) return { renewal, simulation: null };
  const config = configs.find(row => row.id === renewal.configId);
  // A fixed-cycle purchase needs an explicit restart contract; never pretend
  // its saved fixed-date consent was an immediate annual commitment.
  if (config.start_mode !== 'immediate') return {
    renewal: { ...renewal, eligible: false, reason: 'fixed_cycle_restart_requires_review' }, simulation: null,
  };
  const simulation = await simulate(tenantId, member.id, {
    source: 'post-grace-renewal', mode: 'manual', configId: config.id,
    asOfDate: renewal.term_start_date, termStartDate: renewal.term_start_date,
    postGracePredecessorId: renewal.predecessorId,
    ...(config.structure_field_id ? {
      fieldOverrides: { [config.structure_field_id]: config.structure_match_value },
    } : {}),
  });
  if (!simulation?.success || simulation.existingRecord
      || simulation.config?.id !== config.id
      || toDateString(simulation.membershipYear?.start) !== renewal.term_start_date
      || toDateString(simulation.membershipYear?.end) !== renewal.term_end_date) {
    throw new Error('Post-grace simulation does not match the payment-dated annual term');
  }
  const result = { ...renewal, currentStart: histories.find(row => row.id === renewal.predecessorId).term_start_date,
    currentEnd: histories.find(row => row.id === renewal.predecessorId).term_end_date,
    successorStart: renewal.term_start_date, successorEnd: renewal.term_end_date };
  simulation.previousTerm = null;
  simulation.paymentSchedule = {
    term_start_date: result.successorStart, term_end_date: result.successorEnd,
    status: 'pending_payment_setup', scheduled_activation_date: null,
  };
  simulation.formRenewal = result;
  return { renewal: result, simulation };
}
