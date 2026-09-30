import { matchBand } from './tierBandMatcher.js';
import { calculateMembershipYearWindow } from './membershipYear.js';
import { matchesSelections } from './selectionMatcher.js';

const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const valid = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) && Number(value) >= 0;

// Reporting only: never creates quotes, commitments, invoices or collections.
// Uses the member simulator's band/year/override/VAT basis. Where incentive
// history or tax evidence is insufficient, deliberately report review, not zero.
export function projectUpfrontRenewalAmount({ row, member, tenantId, configs, preferences,
  bands = [], overrides = [], vatRules = [], settings = [] }) {
  const review = reason => ({ nextRenewalAmount: null, nextRenewalCurrency: null,
    nextRenewalAmountState: `Review required — ${reason}` });
  const config = configs.find(c => c.id === row.nextStructureId && c.tenant_id === tenantId);
  if (!config || !row.renewalDate || row.nextStructureState?.startsWith('Review required')) {
    return review('next structure unresolved');
  }
  if (config.billing_period && !['annual', 'yearly'].includes(config.billing_period)) {
    return review('non-annual renewal needs pricing review');
  }
  const currency = config.currency;
  if (!/^[A-Z]{3}$/.test(currency || '')) return review('currency missing');
  const valueFor = field => {
    if (field?.startsWith('core:')) return member[field.slice(5)];
    const values = preferences.filter(p => p.tenant_id === tenantId && p.member_id === member.id && p.field_id === field);
    return values.length === 1 ? values[0].value : null;
  };
  let band;
  if (config.pricing_model !== 'flat') {
    const value = valueFor(config.field_source === 'core' ? `core:${config.field_name}` : config.field_id);
    const candidates = bands.filter(b => b.tenant_id === tenantId && b.config_id === config.id);
    if (value === '' || (candidates.every(b => !b.match_value) && !valid(value))) {
      return review('pricing field missing or invalid');
    }
    const matching = candidates.filter(b => matchBand(value, [b]));
    if (matching.length !== 1) return review('pricing band missing or ambiguous');
    band = matching[0];
  }
  const raw = band ? band.annual_cost : config.flat_cost;
  if (!valid(raw)) return review('price missing');
  let amount = Number(raw);
  const year = calculateMembershipYearWindow(config, new Date(`${row.renewalDate}T12:00:00Z`)).label;
  const applicable = overrides.filter(o => o.tenant_id === tenantId && o.member_id === member.id);
  const yearly = applicable.filter(o => o.membership_year === year);
  const selected = yearly.length ? yearly : applicable.filter(o => !o.membership_year);
  if (selected.length > 1) return review('conflicting price overrides');
  const override = selected[0];
  if (override?.override_type === 'structure') return review('structure override requires pricing review');
  if (override?.override_type === 'price') {
    if (!valid(override.manual_price)) return review('manual price missing');
    amount = Number(override.manual_price);
  } else {
    // Incentives can depend on original year-one evidence, not the next config.
    // Do not guess commencement or roll forward an imported historical amount.
    if (Number(config.free_period_amount) > 0 || config.rollover_enabled) return review('incentive history needs review');
    if (override) {
      if (override.override_type !== 'discount' || !valid(override.discount_value)
        || !['percentage', 'fixed'].includes(override.discount_type)) return review('discount override invalid');
      const discount = override.discount_type === 'percentage'
        ? money(amount * Number(override.discount_value) / 100) : Number(override.discount_value);
      amount = Math.max(0, amount - discount);
    }
  }
  let vat = band ? band.vat_rate : config.flat_vat_rate;
  const rules = vatRules.filter(r => r.tenant_id === tenantId && r.config_id === config.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const rule of rules) {
    const value = valueFor(rule.field_id);
    if (value == null) return review('VAT selector missing');
    if (matchesSelections(value, rule.match_value, rule.match_condition)) {
      vat = rule.vat_rate;
      break;
    }
  }
  let rate = 0;
  if (vat) {
    let parsed;
    try { parsed = JSON.parse(vat); } catch { parsed = { taxType: vat, name: vat }; }
    const cache = settings.find(s => s.tenant_id === tenantId && s.setting_key === `xero_vat_rates_${tenantId}`);
    let rates = [];
    try { rates = JSON.parse(cache?.setting_value || '{}').rates || []; } catch { /* label evidence below */ }
    if (!parsed || typeof parsed !== 'object') return review('VAT rate unresolved');
    const cached = rates.find(r => r.taxType === parsed.taxType);
    const labelRate = String(parsed.name || '').match(/(\d+(?:\.\d+)?)\s*%/);
    const numeric = cached?.effectiveRate ?? labelRate?.[1];
    if (!valid(numeric)) return review('VAT rate unresolved');
    rate = Number(numeric);
  }
  amount = money(amount);
  if (!Number.isSafeInteger(Math.round(amount * 100)) || !Number.isFinite(amount * rate / 100)) return review('price out of range');
  return { nextRenewalAmount: money(amount + money(amount * rate / 100)), nextRenewalCurrency: currency,
    nextRenewalAmountState: 'Projected renewal amount including applicable VAT — not a commitment' };
}