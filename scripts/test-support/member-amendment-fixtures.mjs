import { buildRollingCommitment } from '../../api/_lib/rollingMembershipCommitment.js';

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function amendmentFixture(today = '2026-07-02') {
  const tenantId = uuid(1);
  const memberId = uuid(2);
  const originalConfig = {
    id: uuid(3), tenant_id: tenantId, name: 'Original', structure_scope_type: 'member',
    start_mode: 'immediate', billing_period: 'annual', currency: 'GBP', is_active: true,
    effective_from: '2020-01-01', effective_to: null, pricing_model: 'flat',
    flat_cost: 100, flat_vat_rate: null, free_period_amount: null, rollover_enabled: false,
  };
  const config = { ...originalConfig, id: uuid(4), name: 'Target', flat_cost: 200 };
  const amounts = { annual_cost: 100, final_cost: 100, vat_amount: 0, total_with_vat: 100, currency: 'GBP' };
  const current = {
    id: uuid(5), tenant_id: tenantId, member_id: memberId, config_id: originalConfig.id, band_id: null,
    ...amounts, payment_method: 'stripe', billing_period: 'annual', billing_agreement_id: null,
    status: 'active', payment_status: 'paid',
    ...buildRollingCommitment({ config: originalConfig, startDate: `${today.slice(0, 4)}-01-01`,
      paymentMethod: 'stripe', paymentFrequency: 'upfront', amounts }),
  };
  const request = { memberId, configId: config.id, bandId: null, effectiveDate: today, reason: 'Change structure', settlementChoice: 'defer' };
  return { tenantId, memberId, current, config, request, today, quotedAt: `${today}T12:00:00.000Z` };
}
