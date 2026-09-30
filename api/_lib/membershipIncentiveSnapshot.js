import { isDeepStrictEqual } from 'node:util';

// Freeze joining incentive evidence separately from dated commitment metadata.
// Only the rolling/DD commitment builder may populate commitment_snapshot.
// Renewal schedules
// must never be used to reconstruct an original new-member entitlement.
export function membershipIncentiveSnapshot(sim) {
  const incentiveConfig = sim.incentiveConfig || sim.config;
  if (sim.previewOnly || sim.yearNumber !== 1 || !incentiveConfig) return {};
  return {
    incentive_snapshot: {
      config: structuredClone(incentiveConfig),
      amounts: { annual_cost: sim.annualCost },
    },
  };
}

// Compatibility at the frozen quote -> history boundary only. Never reconstruct
// original evidence from a current tier, or reinterpret incomplete dated terms.
export function incentiveFieldsFromSavedQuote(quote) {
  const review = () => { throw new Error('Saved membership incentive evidence is ambiguous; administrator review required'); };
  const saved = quote?.incentive_snapshot;
  const legacy = quote?.commitment_snapshot;
  const fields = saved == null ? {} : { incentive_snapshot: structuredClone(saved) };
  if (legacy == null) return fields;
  if (legacy?.start_mode === 'immediate' || legacy?.start_mode === 'fixed_date') {
    const term = quote.term_key ? quote : quote.commitment;
    const prefix = legacy.start_mode === 'immediate' ? 'rolling:' : 'fixed:';
    if (!term?.term_key?.startsWith(prefix) || !term.term_start_date || !term.term_end_date
        || !term.membership_renewal_date || !term.term_anchor_date
        || ![1, 3, 12].includes(Number(term.term_duration_months))
        || !legacy.config?.id || !legacy.amounts || !legacy.payment_method || !legacy.payment_frequency
        || !['annual_cost', 'final_cost', 'vat_amount', 'total_with_vat'].every(key =>
          typeof legacy.amounts[key] === 'number' && Number.isFinite(legacy.amounts[key]) && legacy.amounts[key] >= 0)
        || (legacy.start_mode === 'fixed_date' && legacy.payment_method !== 'direct_debit')
        || (term.commitment_snapshot && !isDeepStrictEqual(term.commitment_snapshot, legacy))) review();
    return { ...fields, commitment_snapshot: structuredClone(legacy) };
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, keys) => object(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const termKeys = ['term_key', 'term_start_date', 'term_end_date', 'membership_renewal_date',
    'term_duration_months', 'term_anchor_date', 'previous_term_id'];
  const hasTerms = value => value && termKeys.some(key => value[key] != null);
  if (!exactKeys(legacy, ['config', 'amounts']) || !object(legacy.config)
      || !legacy.config.id || legacy.config.start_mode !== 'fixed_date'
      || !exactKeys(legacy.amounts, ['annual_cost'])
      || typeof legacy.amounts.annual_cost !== 'number'
      || !Number.isFinite(legacy.amounts.annual_cost) || legacy.amounts.annual_cost < 0
      || hasTerms(quote) || hasTerms(quote.commitment) || hasTerms(quote.paymentSchedule)
      || (quote.commitment && Object.keys(quote.commitment).length)
      || (quote.config_id && quote.config_id !== legacy.config.id)
      || (quote.config?.id && quote.config.id !== legacy.config.id)
      || (quote.currency && legacy.config.currency && quote.currency !== legacy.config.currency)
      || (quote.annual_cost != null && Number(quote.annual_cost) !== legacy.amounts.annual_cost)
      || (quote.annualCost != null && Number(quote.annualCost) !== legacy.amounts.annual_cost)
      || (saved != null && !isDeepStrictEqual(saved, legacy))) {
    review();
  }
  return { incentive_snapshot: structuredClone(legacy) };
}