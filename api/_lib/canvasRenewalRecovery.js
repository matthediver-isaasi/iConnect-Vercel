import { loadFormMembershipRenewalContext } from './formMembershipRenewalContext.js';
import { applyRenewalJourney } from './membershipRenewalJourney.js';
import { isRetiredCanvasCheckout } from './canvasRenewalEligibility.js';

// Navigation only. Never release a reservation or grant purchase/activation
// eligibility here. The existing form reconciles and resumes its saved payment.
export async function loadCanvasRenewalRecovery(db, { selected, owner, today }, dependencies = {}) {
  const hidden = { available: false };
  if (!owner?.id || !owner.tenant_id || owner.membership_paused || owner.membership_cancelled) return hidden;
  let record = selected?.record;
  // Entry-only callers have no history permission. Read just enough internally
  // to prove a unique owned pending attempt; never return the underlying rows.
  if (selected === undefined) {
    try {
      const { data, error } = await db.from('member_membership_history')
        .select('id,tenant_id,member_id,status,payment_status,payment_method,billing_agreement_id,cancelled_for_switch_at,membership_successor_election_id,membership_payment_quote_id')
        .eq('tenant_id', owner.tenant_id).eq('member_id', owner.id)
        .eq('payment_status', 'unpaid').in('status', ['pending', 'pending_payment_setup'])
        .is('billing_agreement_id', null).is('cancelled_for_switch_at', null).limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return hidden;
      record = { ...data[0], membership_source: 'personal' };
    } catch { return hidden; }
  }
  if (!owner?.id || !owner.tenant_id || owner.membership_paused || owner.membership_cancelled
      || !record || record.membership_source !== 'personal'
      || record.tenant_id !== owner.tenant_id || record.member_id !== owner.id
      || record.billing_agreement_id || isRetiredCanvasCheckout(record)
      || record.payment_status !== 'unpaid'
      || !['pending', 'pending_payment_setup'].includes(record.status)
      || !['stripe', 'card', 'upfront'].includes(record.payment_method)
      || !record.membership_successor_election_id) return hidden;
  try {
    const result = await (dependencies.loadContext || loadFormMembershipRenewalContext)(db, {
      tenantId: owner.tenant_id, memberId: owner.id,
      now: new Date(`${today}T12:00:00Z`),
      // Recovery must use a saved election, never create a fresh quotation.
      simulate: async () => { throw new Error('Saved renewal required'); },
    });
    const { renewal, election, simulation } = result;
    if (renewal?.state !== 'renewal_pending' || renewal.electionId !== record.membership_successor_election_id
        || !election || election.id !== renewal.electionId || election.status !== 'reserved'
        || election.tenant_id !== owner.tenant_id || election.member_id !== owner.id || election.organization_id
        || election.payment_method !== 'upfront' || (election.switch_state && election.switch_state !== 'idle')
        || !record.membership_payment_quote_id || election.payment_quote_id !== record.membership_payment_quote_id
        || simulation?.success !== true) return hidden;
    const route = await (dependencies.routeJourney || applyRenewalJourney)(db, owner.tenant_id, {
      eligible: true,
      ...(simulation.formRenewal?.state === 'post_grace_renewal' ? { state: 'post_grace_renewal' } : {}),
    }, owner.id);
    // Only a server-validated authenticated form is a recovery destination.
    // No arbitrary author/client URL can be used to bypass the existing flow.
    if (!route.eligible || !route.entryHref || route.journeyMode !== 'questionnaire') return hidden;
    return { available: true, entryHref: route.entryHref };
  } catch {
    return hidden;
  }
}
