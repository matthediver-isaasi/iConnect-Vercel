// Only compare server-provided financial terms, never browser-derived totals.
export function renewalReviewSnapshot(data) {
  const renewal = data?.renewal;
  return JSON.stringify({
    membershipYear: data?.membershipYear, currency: data?.currency,
    finalCost: data?.finalCost, totalWithVat: data?.totalWithVat,
    costBreakdown: data?.costBreakdown, stripeEnabled: data?.stripeEnabled,
    zeroDue: data?.zeroDue, approvalPending: data?.approvalPending,
    directDebit: data?.directDebit, cardMonthly: data?.cardMonthly,
    voucherSetup: data?.voucherSetup,
    renewal: renewal && {
      quoteKey: renewal.quoteKey, state: renewal.state, eligible: renewal.eligible,
      selectedMethod: renewal.selectedMethod, switchState: renewal.switchState,
      currentEnd: renewal.currentEnd, successorStart: renewal.successorStart,
      successorEnd: renewal.successorEnd, commencementBasis: renewal.commencementBasis,
      provisional: renewal.provisional,
    },
    existingRecord: data?.existingRecord,
  });
}
