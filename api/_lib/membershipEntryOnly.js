import { applyRenewalJourney } from './membershipRenewalJourney.js';

// Members lacking billing-history permission may still follow an eligible
// questionnaire. Never return the simulation, dates, amounts or history here.
export async function loadMembershipEntryOnly(db, { tenantId, owner, now, loadContext, simulate }) {
  if (!owner?.id || owner.tenant_id !== tenantId || owner.membership_paused || owner.membership_cancelled) return null;
  try {
    const result = await loadContext(db, { tenantId, memberId: owner.id, now, simulate });
    if (!result.renewal?.eligible) return null;
    const routed = await applyRenewalJourney(db, tenantId, {
      eligible: true, ...(result.renewal.state === 'post_grace_renewal' ? { state: 'post_grace_renewal' } : {}),
    },owner.id);
    if (!routed.eligible || !['questionnaire','same_schedule'].includes(routed.journeyMode)) return null;
    return { membership: { state: 'unavailable' }, payment: { state: 'unavailable' },
      renewal: routed };
  } catch { return null; }
}
