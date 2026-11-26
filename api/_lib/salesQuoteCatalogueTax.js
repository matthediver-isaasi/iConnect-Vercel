import { resolveSalesTaxCode } from './salesCatalogueTaxOptions.js';
import { SalesHttpError } from './salesAccess.js';

// Product/component tax is never consulted when a bundle has an override.
// Existing quote evidence is passed only when the caller has matched its
// persisted line identity and determined that its tax should be preserved.
export async function resolveCatalogueQuoteTax(db, tenantId, item, line, previous, dependencies = {}) {
  const choice = line.kind === 'product' ? item.tax_code : item.tax_override || line.taxCode;
  const taxCode = previous ? previous.catalogue_snapshot?.tax_code || null
    : choice ? await resolveSalesTaxCode(db, tenantId, choice, dependencies) : null;
  const taxRateBps = previous ? Number(previous.tax_rate_bps)
    : taxCode ? taxCode.rateBps : line.kind === 'product' ? Number(item.tax_rate_bps) : 0;
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 100000) {
    throw new SalesHttpError(400, 'Catalogue tax rate is invalid');
  }
  return { taxCode, taxRateBps };
}
