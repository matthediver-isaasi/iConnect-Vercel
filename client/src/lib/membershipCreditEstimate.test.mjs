import assert from "node:assert/strict";
import { test } from "node:test";
import { membershipCreditEstimate } from "./membershipCreditEstimate.js";
import { variableMembershipCreditSchedule, variableMembershipCollectionFunding } from "../../../api/_lib/membershipVariableVoucherAllocation.js";

const args = (monthlyAmount = 13, creditMinor = 1000, count = 12) => ({
  currency: "GBP", offer: { monthlyAmount, currency: "GBP" }, now: Date.parse("2027-01-01"),
  quote: {
    id: "accepted-quote", currency: "GBP", expiresAt: "2027-01-01T00:15:00Z",
    monthlySnapshot: { instalment_count: count, collection_policy: { pricing_policy: "dynamic" } },
    allocations: [{ voucherId: "reward", amountMinor: creditMinor }],
    creditSchedule: variableMembershipCreditSchedule({ creditMinor, instalmentCount: count }),
  },
});
test("£13 x12 and £10 accepted credit estimates £146 and a £12.16 first month with 84/83 pennies", () => {
  const input = args();
  input.quote.cashMinor = 0; // Legacy forecast must never override per-period funding.
  input.quote.creditSchedule.reverse();
  const estimate = membershipCreditEstimate(input);
  assert.equal(estimate.grossMinor, 15600);
  assert.equal(estimate.selectedMinor, 1000);
  assert.equal(estimate.cashMinor, 14600);
  assert.equal(estimate.firstCashMinor, 1216);
  assert.deepEqual(estimate.periods.map(row => row.allocatedCreditMinor), [84, 84, 84, 84, 83, 83, 83, 83, 83, 83, 83, 83]);
  assert.deepEqual(estimate.periods.map(row => row.cashMinor), [1216, 1216, 1216, 1216, 1217, 1217, 1217, 1217, 1217, 1217, 1217, 1217]);
});
test("minimum cash and per-month credit cap exactly match canonical funding", () => {
  for (const [monthly, credit] of [[1.5, 1200], [0.5, 1200], [13, 15600], [13, 19000]]) {
    const input = args(monthly, credit);
    const result = membershipCreditEstimate(input);
    const expected = input.quote.creditSchedule.map(row => variableMembershipCollectionFunding({
      grossMinor: Math.round(monthly * 100), allocatedCreditMinor: row.allocatedCreditMinor, minimumCashMinor: 100,
    }));
    assert.equal(result.cashMinor, expected.reduce((sum, row) => sum + row.cashMinor, 0));
    assert.equal(result.unusedCreditMinor, expected.reduce((sum, row) => sum + row.unusedCreditMinor, 0));
  }
  assert.equal(membershipCreditEstimate(args(1.5, 1200)).firstCashMinor, 100);
  assert.equal(membershipCreditEstimate(args(1.5, 1200)).unusedCreditMinor, 600);
  assert.equal(membershipCreditEstimate(args(0.5, 1200)).firstCashMinor, 0);
  assert.equal(membershipCreditEstimate(args(0.5, 1200)).unusedCreditMinor, 600);
  assert.equal(membershipCreditEstimate(args(0.5, 120)), null);
});
test("VAT and a seven-month period are based on current monthly gross, not annualCost", () => {
  const input = args(15.6, 1000, 7);
  input.annualCost = 156;
  input.finalCost = 130;
  assert.equal(membershipCreditEstimate(input).cashMinor, 9920);
  assert.equal(membershipCreditEstimate(input).firstCashMinor, 1417);
});
test("reserved funding takes precedence over quote and needs complete pricing and schedule", () => {
  const input = args();
  input.funding = { variableCredit: true, allocations: input.quote.allocations, creditSchedule: input.quote.creditSchedule };
  input.instalmentCount = 12;
  input.quote.expiresAt = "2001-01-01";
  assert.equal(membershipCreditEstimate(input).reserved, true);
  delete input.instalmentCount;
  assert.equal(membershipCreditEstimate(input), null);
});
test("missing, malformed, mismatched or expired inputs never invent net payments", () => {
  const mutations = [
    input => { delete input.quote; },
    input => { delete input.quote.expiresAt; },
    input => { input.quote.expiresAt = "2027-01-01"; },
    input => { input.quote.expiresAt = "invalid"; },
    input => { delete input.offer; },
    input => { delete input.offer.monthlyAmount; },
    input => { input.offer.monthlyAmount = ""; },
    input => { input.offer.monthlyAmount = "junk"; },
    input => { input.offer.monthlyAmount = -13; },
    input => { input.offer.monthlyAmount = 13.001; },
    input => { input.offer.currency = "EUR"; },
    input => { input.currency = ""; },
    input => { input.quote.currency = "EUR"; },
    input => { delete input.quote.creditSchedule; },
    input => { input.quote.creditSchedule = {}; },
    input => { input.quote.creditSchedule.pop(); },
    input => { input.quote.creditSchedule[0].ordinal = 2; },
    input => { input.quote.creditSchedule[0].allocatedCreditMinor = -1; },
    input => { input.quote.creditSchedule[0].allocatedCreditMinor = 1.5; },
    input => { input.quote.creditSchedule[0] = null; },
    input => { input.quote.allocations = {}; },
    input => { input.quote.allocations[0].amountMinor = 999; },
    input => { input.quote.monthlySnapshot.instalment_count = 0; },
    input => { input.quote.monthlySnapshot.instalment_count = 121; },
    input => { delete input.quote.monthlySnapshot.instalment_count; },
  ];
  for (const mutate of mutations) {
    const input = args();
    mutate(input);
    assert.equal(membershipCreditEstimate(input), null, mutate.toString());
  }
  assert.equal(membershipCreditEstimate({ ...args(), quote: null, creditSelection: ["reward"] }), null);
});
test("fixed upfront and monthly use trusted cash or remaining amounts, not variable forecasts", () => {
  const input = args();
  input.quote = { id: "fixed", currency: "GBP", expiresAt: "2027-01-01T00:15:00Z",
    grossMinor: 15600, cashMinor: 14600, allocations: [{ amountMinor: 1000 }] };
  assert.equal(membershipCreditEstimate(input).cashMinor, 14600);
  assert.equal(membershipCreditEstimate(input).monthlyMinor, null);
  input.quote.monthlySnapshot = { instalment_count: 12 };
  assert.equal(membershipCreditEstimate(input).monthlyMinor, 14600 / 12);
  input.funding = { payableMinor: 15600, remainingMinor: 14600, allocations: [{ amountMinor: 1000 }] };
  input.instalmentCount = 12;
  assert.equal(membershipCreditEstimate(input).reserved, true);
  input.funding.remainingMinor = null;
  assert.equal(membershipCreditEstimate(input), null);
});
