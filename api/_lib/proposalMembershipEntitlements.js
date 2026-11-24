import { previewProposalMembershipBenefit } from '../../shared/proposalMembershipEntitlements.js';

export async function pendingProposalMembership(db, tenantId, organizationId, scheduleId) {
  const { data, error } = await db.rpc('pending_proposal_membership_entitlement', {
    p_tenant: tenantId, p_organization: organizationId, p_schedule: scheduleId,
  });
  if (error) throw Object.assign(new Error(`Could not verify proposal membership eligibility: ${error.message}`), { code: 'PROPOSAL_MEMBERSHIP_UNAVAILABLE' });
  return data || null;
}

export async function applyProposalMembershipPreview(db, tenantId, sim) {
  if (!sim.success || sim.existingRecord || sim.previewOnly) return sim;
  const entitlement = await pendingProposalMembership(db, tenantId, sim.org.id, sim.config.id);
  if (!entitlement) return sim;
  const agreements = await db.from('membership_billing_agreements').select('id')
    .eq('tenant_id', tenantId).eq('organization_id', sim.org.id)
    .not('status', 'in', '(cancelled,expired,failed)').limit(1);
  if (agreements.error) throw agreements.error;
  if (agreements.data?.length) throw Object.assign(new Error('A payment agreement already exists. Review it before applying proposal coverage; existing collections will not be changed automatically.'), { code: 'PROPOSAL_MEMBERSHIP_AGREEMENT_REVIEW' });
  const amounts = previewProposalMembershipBenefit({
    entitlement: { ...entitlement, consumed_history_id: null },
    tenantId, organisationId: sim.org.id, scheduleId: sim.config.id,
    baseNetMinor: Math.round(Number(sim.finalCost) * 100),
    baseVatMinor: Math.round(Number(sim.vatAmount || 0) * 100),
  });
  if (!amounts.eligible) throw new Error('Proposal membership eligibility changed; recalculate before continuing.');
  return {
    ...sim, finalCost: 0, vatAmount: 0, totalWithVat: 0,
    proposalMembership: {
      entitlementId: entitlement.id, scheduleId: sim.config.id,
      quoteId: entitlement.quote_id, quoteVersionId: entitlement.quote_version_id,
      scheduleName: entitlement.benefit_snapshot.scheduleName,
      originalBaseNetMinor: amounts.originalBaseNetMinor,
      originalBaseVatMinor: amounts.originalBaseVatMinor,
    },
    steps: [...(sim.steps || []), { step: 'Proposal membership', message: 'Complimentary base fee for one period. Add-ons remain payable; subsequent periods use normal pricing.', type: 'info' }],
  };
}

export function proposalMembershipHistoryFields(sim) {
  return sim?.proposalMembership ? { proposal_membership: structuredClone(sim.proposalMembership) } : {};
}

export async function assertProposalMembershipInvoice(db, tenantId, source, finalCost) {
  if (source?.sourceType !== 'organisation_membership_history') return;
  const { data, error } = await db.from('organisation_membership_history')
    .select('proposal_membership,total_with_vat,final_cost').eq('tenant_id', tenantId).eq('id', source.sourceId).single();
  if (error) throw error;
  if (!data.proposal_membership) return;
  if (Number(data.total_with_vat ?? data.final_cost) === 0) throw new Error('No membership invoice is required: the base fee is covered by the proposal.');
  if (Number(finalCost) !== 0) throw new Error('The proposal covers the membership base fee. Invoice only the separately approved add-on lines.');
}

export async function listOrganisationProposalMemberships(db, tenantId, organizationId, canViewSales = false) {
  const result = await db.from('proposal_membership_entitlement')
    .select('id,schedule_id,quote_id,quote_version_id,benefit_snapshot,granted_at')
    .eq('tenant_id', tenantId).eq('organization_id', organizationId).order('granted_at').order('id');
  if (result.error) throw result.error;
  const items = [];
  // Bound each lookup by immutable identity; no unbounded URL in(...) filters.
  for (const row of result.data || []) {
    const consumption = await db.from('proposal_membership_consumption')
      .select('history_id,membership_year,original_base_net_minor,original_base_vat_minor,consumed_at')
      .eq('tenant_id', tenantId).eq('entitlement_id', row.id).maybeSingle();
    if (consumption.error) throw consumption.error;
    let history = null;
    if (consumption.data) {
      const result = await db.from('organisation_membership_history').select('currency,final_cost,total_with_vat')
        .eq('tenant_id', tenantId).eq('organization_id', organizationId).eq('id', consumption.data.history_id).single();
      if (result.error) throw result.error;
      history = result.data;
    }
    let invoices = null;
    if (canViewSales) {
      const links = await db.from('sales_accounting_invoice_link')
        .select('id,provider,provider_invoice_id,provider_invoice_number,provider_status,provider_invoice_url')
        .eq('tenant_id', tenantId).eq('quote_version_id', row.quote_version_id).order('created_at');
      if (links.error) throw links.error;
      invoices = (links.data || []).map(link => ({
        id: link.id, provider: link.provider, number: link.provider_invoice_number || link.provider_invoice_id,
        status: link.provider_status,
        url: /^https:\/\//i.test(link.provider_invoice_url || '') ? link.provider_invoice_url : null,
      }));
    }
    items.push({
      id: row.id, scheduleId: row.schedule_id, scheduleName: row.benefit_snapshot.scheduleName,
      grantedAt: row.granted_at, state: consumption.data ? 'consumed' : 'available',
      consumption: consumption.data || null, invoices,
      history,
      sourceProposalId: canViewSales ? row.quote_id : null,
      invoiceState: !canViewSales ? 'restricted' : invoices.length ? 'issued' : 'not_issued',
    });
  }
  return { items };
}
