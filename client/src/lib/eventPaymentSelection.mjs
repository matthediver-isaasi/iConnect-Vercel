// Called only when the checkout has no remaining balance. Preserve legacy
// standard-event credit handling, but identify credit-free contact creation
// explicitly as free so the server can verify its zero-cost ticket evidence.
export function resolveCoveredEventPaymentMethod({
  isComplexEvent = false,
  memberCreationEnabled = false,
  voucherAmount = 0,
  trainingFundAmount = 0,
} = {}) {
  if (isComplexEvent) {
    return voucherAmount > 0 ? 'voucher' : trainingFundAmount > 0 ? 'training_fund' : 'free';
  }
  return memberCreationEnabled && voucherAmount === 0 && trainingFundAmount === 0
    ? 'free' : 'fully_covered';
}

export function resolveEffectiveEventPaymentSelection({
  policy,
  selectedVoucherIds = [],
  trainingFundAmount = 0,
  voucherEligible = true,
  trainingFundEligible = true,
} = {}) {
  const voucherEnabled = policy?.allowVoucherPayment === true && voucherEligible;
  const trainingFundEnabled = policy?.allowTrainingFundPayment === true && trainingFundEligible;
  const numericTrainingFundAmount = Number(trainingFundAmount);

  return {
    voucherEnabled,
    trainingFundEnabled,
    selectedVoucherIds: voucherEnabled && Array.isArray(selectedVoucherIds)
      ? selectedVoucherIds
      : [],
    trainingFundAmount: trainingFundEnabled
      && Number.isFinite(numericTrainingFundAmount)
      && numericTrainingFundAmount > 0
      ? numericTrainingFundAmount
      : 0,
  };
}

export function resolveSavedPaidEventPaymentSelection(savedPayload) {
  const selectedVoucherIds = Array.isArray(savedPayload?.selectedVoucherIds)
    ? savedPayload.selectedVoucherIds
    : [];
  const numericTrainingFundAmount = Number(savedPayload?.trainingFundAmount);

  return {
    selectedVoucherIds,
    voucherOrderManual: savedPayload?.voucherOrderManual === true && selectedVoucherIds.length > 1,
    trainingFundAmount: Number.isFinite(numericTrainingFundAmount) && numericTrainingFundAmount > 0
      ? numericTrainingFundAmount
      : 0,
  };
}