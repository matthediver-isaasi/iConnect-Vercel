export function currencyFractionDigits(currencyCode) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode || "GBP",
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

export function minorToMajor(value, currencyCode) {
  const digits = currencyFractionDigits(currencyCode);
  return Number(value || 0) / (10 ** digits);
}

export function formatSalesMoney(value, currencyCode = "GBP", { minorUnits = false } = {}) {
  const amount = minorUnits ? minorToMajor(value, currencyCode) : Number(value || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode || "GBP",
    }).format(amount);
  } catch {
    return `${currencyCode || ""} ${amount.toLocaleString()}`.trim();
  }
}