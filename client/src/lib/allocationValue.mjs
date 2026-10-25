export function currencyDigits(currency) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
}

// Parse decimal text without floating-point multiplication or rounding.
export function allocationNetMinor(text, currency) {
  const digits = currencyDigits(currency);
  const value = String(text).trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits || 1}})?$`).test(value)
    || (!digits && value.includes("."))) return null;
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole + fraction.padEnd(digits, "0"));
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

export function allocationMoney(minor, currency) {
  if (!Number.isSafeInteger(minor)) return "Unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency })
    .format(minor / (10 ** currencyDigits(currency)));
}
