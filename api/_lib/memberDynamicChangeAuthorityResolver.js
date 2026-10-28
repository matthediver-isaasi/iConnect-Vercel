import { normalizeAmendmentRequest } from './memberAmendments.js';
import { createMemberMonthlyPurchaseAuthority } from './memberMonthlyPurchaseAuthority.js';
import { resolveDynamicCollectionPrice } from './directDebitDynamicPipeline.js';
import { resolveMemberFixedChangeAuthority } from './memberFixedChangeAuthorityResolver.js';
import { reconcileAmendmentFunding } from './memberAmendmentCalculation.js';
import { resolveMembershipChangeBehaviour, validateMembershipChangePolicy,
  MEMBERSHIP_CHANGE_POLICY_DEFAULTS } from './membershipChangePolicy.js';

const fail = message => {
  throw Object.assign(new Error(message), { status: 422, code: 'monthly_quote_unavailable' });
};
// Variable monthly prices are prospective rates, never a guaranteed annual
// obligation. This resolver deliberately does not call the annual calculator.
export function createMemberDynamicChangeAuthorityResolver({
  db, purchases = createMemberMonthlyPurchaseAuthority({ db }),
  price = resolveDynamicCollectionPrice,
  authorizeMember=null,
}) {
  async function one(table, tenantId, filters) {
    let q = db.from(table).select('*').eq('tenant_id', tenantId);
    for (const [key, value] of Object.entries(filters)) q = q.eq(key, value);
    const { data, error } = await q.maybeSingle();
    if (error) fail('Monthly quote configuration could not be read.');
    return data;
  }
  async function rules(table, tenantId, configId) {
    const { data, error } = await db.from(table).select('id')
      .eq('tenant_id', tenantId).eq('config_id', configId).limit(1);
    if (error || !Array.isArray(data)) fail('Monthly pricing rules could not be checked.');
    if (data.length) fail('This structure has pricing overrides requiring separate financial reconciliation.');
  }
  return async (context, selection) => {
    const memberAllowed=context.actorKind==='member'&&context.actorId===context.memberId&&authorizeMember
      &&await authorizeMember(context,selection);
    if ((context.actorKind !== 'admin'&&!memberAllowed) || !context.actorId || !context.tenantId || !context.memberId) {
      fail('Authenticated finance-admin context is required.');
    }
    if (selection?.action && selection.action !== 'change') fail('This quote cannot cancel a membership.');
    const request = normalizeAmendmentRequest({ ...selection, memberId: context.memberId, settlementChoice: 'defer' });
    const base = await purchases.load({
      tenantId: context.tenantId, memberId: context.memberId,
      amendmentId: `preview:${context.memberId}`, effectiveDate: request.effectiveDate,
    });
    if(base.authority.pricingBasis==='annual_instalments'){
      return resolveMemberFixedChangeAuthority({db,purchases,context,selection,base});
    }
    if (base.authority.provider !== 'gocardless' || base.authority.pricingBasis !== 'monthly_price') {
      fail('This quote requires an existing variable-monthly Direct Debit agreement.');
    }
    const source = base.purchase;
    const governing = await one('membership_tier_config', context.tenantId, { id: source.config_id });
    if (resolveMembershipChangeBehaviour(source, governing) !== 'retain_term') {
      fail('Replacement terms require a separate settlement and consent flow.');
    }
    const target = await one('membership_tier_config', context.tenantId, { id: request.configId });
    if (!target || target.tenant_id !== context.tenantId || target.structure_scope_type !== 'member'
      || target.is_active === false || target.dd_enabled !== true
      || target.currency?.toUpperCase() !== base.authority.currency
      || target.start_mode !== governing.start_mode) fail('Target structure is not eligible for the existing agreement.');
    const band = request.bandId
      ? await one('membership_tier_band', context.tenantId, { id: request.bandId, config_id: target.id }) : null;
    if ((target.pricing_model === 'flat' && request.bandId)
      || (target.pricing_model !== 'flat' && !band)) fail('Select a valid target membership tier.');
    if (source.config_id === target.id && (source.band_id || null) === (band?.id || null)) {
      fail('Select a different membership structure or tier.');
    }
    await Promise.all([
      rules('membership_tier_discount', context.tenantId, target.id),
      rules('membership_tier_vat_override', context.tenantId, target.id),
    ]);
    // Project the proposed scope for a read only. Never update signed consent.
    const proposed = structuredClone(base.agreement);
    const terms = proposed.metadata.dd;
    terms.field_value = null;
    terms.commitment.commitment_snapshot = {
      ...terms.commitment.commitment_snapshot, config: target,
      pricing: { ...terms.commitment.commitment_snapshot?.pricing, field_value: null, band },
    };
    const targetPrice = await price(proposed, request.effectiveDate, { db, applyMembershipRevision: false });
    if (targetPrice.config_id !== target.id || (targetPrice.band_id || null) !== (band?.id || null)) {
      fail('The selected structure is not the effective target price.');
    }
    const providerTarget = { currency: base.authority.currency, amountMinor: targetPrice.monthly_amount_minor };
    const reconciled = await purchases.reconcileFunding({
      tenantId: context.tenantId, memberId: context.memberId,
      amendmentId: base.amendmentId, effectiveDate: request.effectiveDate, target: providerTarget,
    });
    // A concurrent source change invalidates the entire quote, not just its fee.
    if (JSON.stringify(reconciled.input.purchase) !== JSON.stringify(source)) {
      fail('The source membership changed during quotation.');
    }
    const original = reconciled.fundingEvidence.settledFunding.reduce((sum, payment) => ({
      netMinor: sum.netMinor + payment.netMinor, vatMinor: sum.vatMinor + payment.vatMinor,
    }), { netMinor: 0, vatMinor: 0 });
    const finance = reconcileAmendmentFunding({
      sourceRecordId: source.id, memberId: context.memberId, currency: base.authority.currency,
      frequency: 'monthly', pricingBasis: 'monthly_price', sourcePrice: original,
      term: { startDate: source.term_start_date, renewalDate: source.membership_renewal_date },
      effectiveDate: request.effectiveDate, evidence: reconciled.fundingEvidence,
    });
    if (finance.blockers.length || finance.available.grossMinor !== 0) {
      fail('Outstanding obligations or prepaid value must be settled before changing this collection schedule.');
    }
    const policySnapshot = await one('membership_change_policy', context.tenantId, {});
    validateMembershipChangePolicy(policySnapshot?.policy || { ...MEMBERSHIP_CHANGE_POLICY_DEFAULTS });
    const vatSetting = await one('system_settings', context.tenantId, {
      setting_key: `xero_vat_rates_${context.tenantId}`,
    });
    return {
      version: 1, tenantId: context.tenantId, memberId: context.memberId, action: 'change', request,
      sourceSnapshot: source, targetSnapshot: target, targetBandSnapshot: band, governingSnapshot: governing,
      pricingSnapshot: { config: target, band, vatSetting, dynamicPrice: targetPrice },
      policySnapshot, fundingEvidence: reconciled.fundingEvidence,
      calculation: {
        version: 3, action: 'change', behaviour: 'retain_term', sourceRecordId: source.id,
        currency: base.authority.currency, effectiveDate: request.effectiveDate,
        finance: { ...finance, original: null, originalValueBasis: 'no_fixed_term_total' },
        newTerm: { startDate: request.effectiveDate, renewalDate: source.membership_renewal_date },
        currentMonthlyPriceMinor: providerTarget.amountMinor,
        futureObligationMinor: null, paymentDueMinor: null, surplusMinor: 0,
        blockers: ['provider_schedule_coordination_required'], entitlementApplied: false,
        settlementStatus: 'not_started',
      },
      settlement: { requiresApproval: true, surplusHandling: 'none', moneyMoved: false, entitlementApplied: false },
      monthlyExecution: {
        version: 1, providerTarget, providerAuthority: reconciled.input.authority,
        providerFunding: reconciled.prepared.funding,
      },
      executionEnabled: false,
    };
  };
}
