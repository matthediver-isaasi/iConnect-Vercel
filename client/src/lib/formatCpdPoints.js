// Presentation only: never convert decimal strings to Number or round ledger
// values. Removing trailing fractional zeroes preserves every meaningful digit.
export function formatCpdPoints(value) {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  const decimal = /^([+-]?\d+)\.(\d+)$/.exec(text);
  if (!decimal) return text;
  const fraction = decimal[2].replace(/0+$/, "");
  return fraction ? `${decimal[1]}.${fraction}` : decimal[1];
}
