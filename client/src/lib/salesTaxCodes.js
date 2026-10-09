// Provider identity is authoritative; rates are display/calculation data only.
export function persistedQuoteLineId(line) {
  const id = line?.id || line?._id;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function quoteLineIdentityForSaving(line) {
  // Only normalization of a saved server line sets persistedLineId. Never
  // serialize local React keys, even though those are also generated UUIDs.
  const id = persistedQuoteLineId({ id: line?.persistedLineId });
  return id ? { id } : {};
}

export function taxCodeKey(code) {
  return code?.provider && code?.id != null ? JSON.stringify([code.provider, String(code.id)]) : "";
}

export function providerTaxOptions(payload) {
  const provider = typeof payload?.provider === "string" ? payload.provider : payload?.provider?.key || payload?.provider?.id;
  return (payload?.items || []).map((code) => ({ ...code, provider: code.provider || provider }));
}

export function savedLineTaxCode(line) {
  const snapshot = line?.catalogueSnapshot || line?.catalogue_snapshot;
  return snapshot?.tax_code || snapshot?.taxCode || line?.taxCode || null;
}

export function taxCodeLabel(code) {
  return code ? `${code.name || code.id} · ${code.provider} (${code.id})` : "";
}

export function selectedProviderTaxCode(key, items, available = true) {
  const code = available && items.find((item) => taxCodeKey(item) === key && item.selectable);
  if (!code || !taxCodeKey(code)) throw new Error("Select a synced provider VAT code. Sync tax codes in your accounting integration settings if none are available.");
  return code;
}

export function quoteLineTaxForSaving(line, items, available = true) {
  // Products resolve their tax code from the catalogue on the server.
  if (line.type === "product") return line.legacyTax ? { taxRateBps: line.taxRateBps } : {};
  if (line.taxChanged) {
    const code = selectedProviderTaxCode(taxCodeKey(line.taxCode), items, available);
    return { taxCode: { provider: code.provider, id: code.id } };
  }
  if (taxCodeKey(line.taxCode)) return { taxCode: { provider: line.taxCode.provider, id: line.taxCode.id } };
  if (line.legacyTax) return { taxRateBps: line.taxRateBps };
  throw new Error("Choose a provider VAT code for each new free-text or bundle line.");
}
