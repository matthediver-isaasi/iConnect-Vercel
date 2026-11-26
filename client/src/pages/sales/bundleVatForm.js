import { taxCodeKey } from "../../lib/salesTaxCodes.js";

export function bundleTaxForSaving(existing, value, options, ready) {
  if (existing && taxCodeKey(existing.taxOverride) === taxCodeKey(value)) return {};
  if (!value) return { taxOverride: null };
  const code = ready && options.find(item => item.selectable && taxCodeKey(item) === taxCodeKey(value));
  if (!code) throw new Error("Choose an available synced VAT code for the bundle override.");
  return { taxOverride: { provider: code.provider, id: code.id } };
}
