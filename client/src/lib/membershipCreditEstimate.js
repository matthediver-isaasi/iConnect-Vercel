import { variableMembershipCollectionFunding } from "../../../api/_lib/membershipVariableVoucherAllocation.js";

const minor = value => Number.isSafeInteger(value) && value >= 0;
const currencyCode = value => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const countValid = value => Number.isSafeInteger(value) && value > 0 && value <= 120;

// Display only. Never use these estimates to create or confirm a payment.
export function membershipCreditEstimate({ funding, quote, offer, currency, instalmentCount, now = Date.now() }) {
  const reserved = !!funding;
  const source = funding || quote;
  if (!source || !currencyCode(currency)) return null;
  if (!reserved && (!source.id || !Number.isFinite(Date.parse(source.expiresAt)) || Date.parse(source.expiresAt) <= now)) return null;
  if ((!reserved || source.currency != null) && source.currency !== currency) return null;
  if (!Array.isArray(source.allocations) || !source.allocations.length ||
      source.allocations.some(row => !minor(row?.amountMinor))) return null;
  const selectedMinor = source.allocations.reduce((sum, row) => sum + row.amountMinor, 0);
  if (!minor(selectedMinor) || selectedMinor === 0) return null;
  const variable = source.variableCredit === true ||
    source.monthlySnapshot?.collection_policy?.pricing_policy === "dynamic";
  if (!variable) {
    const cashMinor = reserved ? source.remainingMinor : source.cashMinor;
    const grossMinor = reserved ? source.payableMinor : source.grossMinor;
    if (!minor(cashMinor) || !minor(grossMinor) || cashMinor > grossMinor ||
        grossMinor - cashMinor !== selectedMinor) return null;
    const count = reserved ? instalmentCount : source.monthlySnapshot?.instalment_count;
    if (count != null && !countValid(count)) return null;
    return { reserved, variable, selectedMinor, cashMinor, grossMinor, currency,
      count: count ?? null, monthlyMinor: count ? cashMinor / count : null };
  }
  const count = reserved ? instalmentCount : source.monthlySnapshot?.instalment_count;
  const schedule = source.creditSchedule;
  if (!countValid(count) || !Array.isArray(schedule) || schedule.length !== count ||
      !offer || offer.currency !== currency ||
      !["number", "string"].includes(typeof offer.monthlyAmount) ||
      String(offer.monthlyAmount).trim() === "") return null;
  const monthly = Number(offer.monthlyAmount);
  const grossMinor = Math.round(monthly * 100);
  if (!Number.isFinite(monthly) || monthly <= 0 || !minor(grossMinor) ||
      Math.abs(monthly * 100 - grossMinor) > 0.000001) return null;
  const ordinals = new Set();
  let allocated = 0;
  for (const row of schedule) {
    if (!row || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > count ||
        ordinals.has(row.ordinal) || !minor(row.allocatedCreditMinor)) return null;
    ordinals.add(row.ordinal);
    allocated += row.allocatedCreditMinor;
  }
  if (allocated !== selectedMinor) return null;
  try {
    // Same pure allocator and minimum as gocardlessDynamicCollections. Each
    // month is priced separately: annualCost may exclude VAT or cover a year
    // rather than the purchased period, and unused credit cannot be moved.
    const periods = [...schedule].sort((a, b) => a.ordinal - b.ordinal).map(row => ({
      ...row,
      ...variableMembershipCollectionFunding({
        grossMinor, allocatedCreditMinor: row.allocatedCreditMinor, minimumCashMinor: 100,
      }),
    }));
    const cashMinor = periods.reduce((sum, row) => sum + row.cashMinor, 0);
    const unusedCreditMinor = periods.reduce((sum, row) => sum + row.unusedCreditMinor, 0);
    if (!minor(cashMinor) || !minor(unusedCreditMinor) || !minor(grossMinor * count)) return null;
    return { reserved, variable, selectedMinor, cashMinor, unusedCreditMinor,
      grossMinor: grossMinor * count, firstCashMinor: periods[0].cashMinor, periods, count, currency };
  } catch {
    // An incomplete or sub-minimum collection is not a usable forecast.
    return null;
  }
}
