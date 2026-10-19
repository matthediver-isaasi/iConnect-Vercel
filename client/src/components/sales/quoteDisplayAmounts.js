// Snapshot display only: never reprice an issued document or infer VAT from a rate.
const amount = (source, kind) => {
  const value = source?.[`${kind}Minor`] ?? source?.[`${kind}_minor`]
    ?? source?.[`${kind}TotalMinor`] ?? source?.[`${kind}_total_minor`]
    ?? (kind === "gross" ? source?.totalMinor ?? source?.total_minor : undefined);
  if (value == null || value === "") return null;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
};

export function persistedLineAmounts(line) {
  return Object.fromEntries(["net", "tax", "gross"].map(kind => [kind, amount(line, kind)]));
}

export function persistedQuoteAmounts(quote, lines = quote?.lines || []) {
  return Object.fromEntries(["net", "tax", "gross"].map(kind => {
    const saved = amount(quote?.totals, kind) ?? amount(quote, kind);
    const values = lines.map(line => amount(line, kind));
    // Missing amounts are unknown, not zero. A complete set of saved line
    // amounts can supply a missing document total without recalculation.
    return [kind, saved ?? (values.length && values.every(value => value !== null)
      ? values.reduce((sum, value) => sum + value, 0) : null)];
  }));
}
