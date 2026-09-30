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