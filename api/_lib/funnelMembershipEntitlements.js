// Event-funnel complimentary membership benefits (organisation or individual).
// Eligibility only: a confirmed funnel booking grants one base-fee waiver on
// the next created period of the exact tier. Proposal coverage takes
// precedence; only one complimentary benefit applies to a period.
// Pure helpers: the rollout flag lives in funnelMembershipRollout.js so this
// module stays free of environment reads (it is part of the preview graph).
export const complimentaryMembership = sim => sim?.proposalMembership || sim?.funnelMembership || null;

const recipientOf = (sim, scope) => scope === 'organization' ? sim.org?.id : sim.member?.id;

export async function pendingFunnelMembership(db, tenantId, scope, recipientId, scheduleId) {
  const { data, error } = await db.rpc('pending_event_funnel_membership', {
    p_tenant: tenantId, p_scope: scope, p_recipient: recipientId, p_schedule: scheduleId,
  });
  if (error) throw Object.assign(new Error(`Could not verify event booking membership eligibility: ${error.message}`), { code: 'FUNNEL_MEMBERSHIP_UNAVAILABLE' });
  return data || null;
}

export async function applyFunnelMembershipPreview(db, tenantId, sim, scope) {
  if (!sim?.success || sim.existingRecord || sim.previewOnly || sim.proposalMembership) return sim;
  const recipientId = recipientOf(sim, scope);
  if (!recipientId || !sim.config?.id) return sim;
  const entitlement = await pendingFunnelMembership(db, tenantId, scope, recipientId, sim.config.id);
  if (!entitlement) return sim;
  if (entitlement.scope !== scope || entitlement.schedule_id !== sim.config.id) {
    throw new Error('Event booking membership eligibility changed; recalculate before continuing.');
  }
  const agreements = await db.from('membership_billing_agreements').select('id')
    .eq('tenant_id', tenantId).eq(scope === 'organization' ? 'organization_id' : 'member_id', recipientId)
    .not('status', 'in', '(cancelled,expired,failed)').limit(1);
  if (agreements.error) throw agreements.error;
  if (agreements.data?.length) {
    throw Object.assign(new Error('A payment agreement already exists. Review it before applying the complimentary event booking membership; existing collections will not be changed automatically.'), { code: 'FUNNEL_MEMBERSHIP_AGREEMENT_REVIEW' });
  }
  const originalBaseNetMinor = Math.round(Number(sim.finalCost) * 100);
  const originalBaseVatMinor = Math.round(Number(sim.vatAmount || 0) * 100);
  if (!Number.isSafeInteger(originalBaseNetMinor) || originalBaseNetMinor < 0
    || !Number.isSafeInteger(originalBaseVatMinor) || originalBaseVatMinor < 0) {
    throw new Error('The membership fee could not be calculated for the complimentary benefit.');
  }
  return {
    ...sim, finalCost: 0, vatAmount: 0, totalWithVat: 0,
    funnelMembership: {
      entitlementId: entitlement.id, scheduleId: sim.config.id, scope,
      orderId: entitlement.order_id,
      scheduleName: entitlement.benefit_snapshot?.scheduleName || sim.config.name || null,
      originalBaseNetMinor, originalBaseVatMinor,
    },
    steps: [...(sim.steps || []), { step: 'Event booking membership', message: 'Complimentary base fee for one period from an event booking. Add-ons remain payable; subsequent periods use normal pricing.', type: 'info' }],
  };
}

export function funnelMembershipHistoryFields(sim) {
  return sim?.funnelMembership ? { funnel_membership: structuredClone(sim.funnelMembership) } : {};
}

// A complimentary base fee needs no invoice; any invoice is for add-ons only.
export async function assertFunnelMembershipInvoice(db, tenantId, source, finalCost) {
  const table = ['organisation_membership_history', 'member_membership_history'].includes(source?.sourceType) ? source.sourceType : null;
  if (!table) return;
  const { data, error } = await db.from(table).select('funnel_membership,total_with_vat,final_cost')
    .eq('tenant_id', tenantId).eq('id', source.sourceId).single();
  if (error) throw error;
  if (!data.funnel_membership) return;
  if (Number(data.total_with_vat ?? data.final_cost) === 0) throw new Error('No membership invoice is required: the base fee is covered by an event booking benefit.');
  if (Number(finalCost) !== 0) throw new Error('An event booking benefit covers the membership base fee. Invoice only the separately approved add-on lines.');
}

export async function listFunnelMemberships(db, tenantId, scope, recipientId, { enabled }) {
  if (!enabled) return { items: [], enabled: false };
  const { data, error } = await db.rpc('list_event_funnel_memberships', {
    p_tenant: tenantId, p_scope: scope, p_recipient: recipientId,
  });
  if (error) throw error;
  return { items: Array.isArray(data) ? data : [], enabled: true };
}
