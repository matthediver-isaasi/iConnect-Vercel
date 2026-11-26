import { resolveStoredInvoicingAddress } from '../../shared/invoicingAddress.js';
import { loadTenantLogoDataUrl, quoteAddressLines } from './salesQuotePdf.js';

// Render-time presentation context for quote/proposal PDFs. Looked up when a
// PDF is produced (not frozen into the snapshot) so existing quotes and signed
// agreements pick up the tenant's terminology and the organisation's address.
// None of these values alter stored quote data, totals or signing evidence.

export function organisationAddressFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  try {
    const resolved = resolveStoredInvoicingAddress(record, 'organization');
    if (resolved?.source === 'structured') {
      const a = resolved.address;
      return { line1: a.invoicing_address_line1, line2: a.invoicing_address_line2, city: a.invoicing_city,
        region: a.invoicing_region, postalCode: a.invoicing_postal_code, country: a.invoicing_country };
    }
    if (resolved?.source === 'legacy') return { line1: resolved.address };
  } catch {
    // Malformed stored invoicing fields: fall through to the general address.
  }
  const general = { line1: record.address ?? record.address_line1 ?? record.address_line_1,
    line2: record.address_line2 ?? record.address_line_2, city: record.city,
    region: record.region ?? record.county ?? record.state,
    postalCode: record.postcode ?? record.postal_code ?? record.zip, country: record.country };
  return Object.values(general).some(v => typeof v === 'string' && v.trim()) ? general : null;
}

const optionalSchemaError = (error) => ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error?.code);

export async function loadSalesQuotePdfContext(db, tenantId, version, { tenant, includeLogo = false } = {}) {
  const context = {};
  const settings = await db.from('sales_settings').select('quote_singular_name').eq('tenant_id', tenantId).maybeSingle();
  if (settings.error && !optionalSchemaError(settings.error)) throw settings.error;
  if (typeof settings.data?.quote_singular_name === 'string' && settings.data.quote_singular_name.trim()) {
    context.quoteSingular = settings.data.quote_singular_name.trim();
  }
  // Only needed when the quote itself carries no address snapshot.
  const org = version?.organisation_snapshot;
  if (!quoteAddressLines(version).length && org && typeof org === 'object') {
    let record = null;
    if (org.id) {
      const found = await db.from('organization').select('*').eq('tenant_id', tenantId).eq('id', org.id).maybeSingle();
      if (found.error && !optionalSchemaError(found.error)) throw found.error;
      record = found.data || null;
    }
    const address = organisationAddressFromRecord(record) || organisationAddressFromRecord(org);
    if (address) context.organisationAddress = address;
  }
  if (includeLogo && tenant) {
    // Agreement renders are best-effort for branding: a missing or moved logo
    // must never block access to signed evidence.
    try {
      const logo = await loadTenantLogoDataUrl(tenant);
      if (logo) context.logoDataUrl = logo;
    } catch {}
  }
  return context;
}
