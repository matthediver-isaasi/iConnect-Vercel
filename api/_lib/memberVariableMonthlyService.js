import {
  AmendmentCalculationError, amendmentDay, amendmentMoneyParts, prorateAmendmentMoney,
} from './memberAmendmentMoney.js';

const fail = message => { throw new AmendmentCalculationError(message); };
const iso = date => date.toISOString().slice(0,10);
function anniversary(start, offset) {
  const date = new Date(`${start}T00:00:00Z`);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const lastDay=new Date(date);
  lastDay.setUTCMonth(lastDay.getUTCMonth()+1);lastDay.setUTCDate(0);
  date.setUTCDate(Math.min(originalDay,lastDay.getUTCDate()));
  return iso(date);
}
export { anniversary as membershipServiceAnniversary };

// This is service accounting, not a payment calendar. No collection date,
// payment status, current catalogue price or annual-price/12 enters this function.
// Callers supply reconciled historical period prices, including net/tax.
export function reconcileVariableMonthlyService({
  sourceRecordId,currency,term,throughExclusiveDate,evidence,
}) {
  if(!sourceRecordId || !/^[A-Z]{3}$/.test(currency||'')) fail('Purchase and currency are required.');
  const start=amendmentDay(term?.startDate),end=amendmentDay(term?.renewalDate);
  const through=amendmentDay(throughExclusiveDate);
  if(end<=start || through<start || through>end) fail('Service date must be inside the purchased term.');
  if(!evidence || evidence.sourceRecordId!==sourceRecordId || evidence.currency!==currency
    || evidence.throughExclusiveDate!==throughExclusiveDate || evidence.complete!==true
    || evidence.basis!=='membership_start_anniversaries' || !Array.isArray(evidence.periods)) {
    fail('Complete purchase-scoped anniversary-period prices are required.');
  }
  const prices=new Map(),ids=new Set();
  for(const period of evidence.periods) {
    if(!Number.isInteger(period.ordinal) || period.ordinal<1 || period.ordinal>1200
      || prices.has(period.ordinal) || !period.evidenceId || ids.has(period.evidenceId)
      || period.sourceRecordId!==sourceRecordId || period.currency!==currency || period.verified!==true) {
      fail('Period price identity, ownership or verification is ambiguous.');
    }
    amendmentMoneyParts(period);
    const expectedStart=anniversary(term.startDate,period.ordinal-1);
    const expectedEnd=anniversary(term.startDate,period.ordinal);
    if(expectedStart>=term.renewalDate || period.serviceStartDate!==expectedStart
      || period.serviceEndExclusiveDate!==(expectedEnd<term.renewalDate?expectedEnd:term.renewalDate)) {
      fail('Historical period prices must match membership-start anniversaries.');
    }
    prices.set(period.ordinal,period);ids.add(period.evidenceId);
  }
  let total=amendmentMoneyParts({netMinor:0,vatMinor:0});
  const periods=[];
  for(let ordinal=1;anniversary(term.startDate,ordinal-1)<throughExclusiveDate;ordinal++) {
    if(ordinal>1200) fail('Membership service period exceeds the supported evidence range.');
    const periodStart=anniversary(term.startDate,ordinal-1);
    const anniversaryEnd=anniversary(term.startDate,ordinal);
    const periodEnd=anniversaryEnd<term.renewalDate?anniversaryEnd:term.renewalDate;
    const price=prices.get(ordinal);
    if(!price) fail(`Historical price evidence is missing for service period ${ordinal}.`);
    const days=amendmentDay(periodEnd)-amendmentDay(periodStart);
    const elapsed=Math.min(through,amendmentDay(periodEnd))-amendmentDay(periodStart);
    const full=amendmentMoneyParts(price);
    // A shortened last period's evidence must already cover that exact period,
    // not an unadjusted full-month tariff.
    const remaining=prorateAmendmentMoney(full,days-elapsed,days);
    const consumed=amendmentMoneyParts({
      netMinor:full.netMinor-remaining.netMinor,vatMinor:full.vatMinor-remaining.vatMinor,
    });
    total=amendmentMoneyParts({netMinor:total.netMinor+consumed.netMinor,vatMinor:total.vatMinor+consumed.vatMinor});
    periods.push({ordinal,evidenceId:price.evidenceId,startDate:periodStart,endExclusiveDate:periodEnd,
      elapsedDays:elapsed,totalDays:days,full,consumed,remaining});
  }
  return {...total,sourceRecordId,throughExclusiveDate,verified:true,
    basis:'membership_start_anniversaries',periods};
}
