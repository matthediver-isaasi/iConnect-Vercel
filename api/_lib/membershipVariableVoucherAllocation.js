// Allocation arithmetic only. This module never quotes a fixed future fee,
// mutates a voucher, creates a provider payment, or marks membership as paid.
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
};

/**
 * Spread the accepted credit over the purchased membership period. A penny
 * remainder goes to the earliest instalments. Later renewals get no implicit
 * entitlement to the same credit.
 */
export function variableMembershipCreditSchedule({ creditMinor, instalmentCount }) {
  integer(creditMinor, 'credit amount');
  integer(instalmentCount, 'instalment count', 1);
  if (instalmentCount > 120) throw new Error('Invalid instalment count');
  const base = Math.floor(creditMinor / instalmentCount);
  const remainder = creditMinor % instalmentCount;
  return Array.from({ length: instalmentCount }, (_, i) => ({
    ordinal: i + 1,
    allocatedCreditMinor: base + (i < remainder ? 1 : 0),
  }));
}

/**
 * Resolve only one actual collection, after its authoritative price is known.
 * An unused portion is reported explicitly: callers must release it back to
 * the original voucher, not transfer it into another period or consume it.
 * No non-zero provider collection may fall below its minimum.
 */
export function variableMembershipCollectionFunding({
  grossMinor, allocatedCreditMinor, minimumCashMinor,
}) {
  integer(grossMinor, 'collection price');
  integer(allocatedCreditMinor, 'allocated credit');
  integer(minimumCashMinor, 'provider minimum', 1);
  let creditMinor = Math.min(grossMinor, allocatedCreditMinor);
  let cashMinor = grossMinor - creditMinor;
  if (cashMinor > 0 && cashMinor < minimumCashMinor) {
    if (grossMinor < minimumCashMinor) {
      // A partial credit cannot make an already sub-minimum gross charge
      // payable. Fail before any debit/reservation/provider operation.
      throw new Error('The collection is below the provider minimum and is not fully covered by credit');
    }
    cashMinor = minimumCashMinor;
    creditMinor = grossMinor - cashMinor;
  }
  return {
    grossMinor, creditMinor, cashMinor,
    unusedCreditMinor: allocatedCreditMinor - creditMinor,
    creditOnly: grossMinor > 0 && cashMinor === 0,
  };
}

/**
 * Keep source-voucher identity for every penny of the schedule. Do not use a
 * mutable current balance to reconstruct a previously accepted allocation.
 */
export function variableMembershipCreditSlices({ allocations, instalmentCount }) {
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('Credit allocations are required');
  const seen = new Set();
  let total = 0;
  for (const allocation of allocations) {
    if (!allocation.voucherId || seen.has(allocation.voucherId)) throw new Error('Distinct source vouchers are required');
    seen.add(allocation.voucherId);
    total += integer(allocation.amountMinor, 'voucher allocation', 1);
    integer(total, 'total credit');
  }
  const schedule = variableMembershipCreditSchedule({ creditMinor: total, instalmentCount });
  let source = 0;
  let used = 0;
  return schedule.map(row => {
    let remaining = row.allocatedCreditMinor;
    const portions = [];
    while (remaining > 0) {
      const allocation = allocations[source];
      const amountMinor = Math.min(remaining, allocation.amountMinor - used);
      portions.push({ voucherId: allocation.voucherId, amountMinor });
      used += amountMinor;
      remaining -= amountMinor;
      if (used === allocation.amountMinor) { source += 1; used = 0; }
    }
    return { ...row, allocations: portions };
  });
}
