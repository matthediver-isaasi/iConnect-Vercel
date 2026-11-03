// Display-only estimates. Never use these as payment/settlement authority.
export function renewalCreditPreview(data, vouchers) {
  const minor = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value) * 100)) : 0;
  const gross = minor(data.totalWithVat ?? data.finalCost);
  const selected = [...new Map(vouchers.map(v => [v.id, v])).values()]
    .reduce((sum, v) => sum + minor(v.value), 0);
  const credit = Math.min(gross, selected);
  const monthly = offer => {
    const count = Number(offer?.instalmentCount);
    if (!Number.isInteger(count) || count < 1) return null;
    // First-month estimate; rounding can vary between instalments.
    return Math.max(0, minor(offer.monthlyAmount) - Math.ceil(credit / count)) / 100;
  };
  return { credit: credit / 100, upfront: (gross - credit) / 100,
    monthly_card: monthly(data.cardMonthly), direct_debit: monthly(data.directDebit) };
}
