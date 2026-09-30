import { createHash } from 'node:crypto';
import { calculateQuoteLine, calculateQuoteTotals, normalizeSalesInvoiceStatus, validateCurrency } from '../../shared/salesContracts.js';
import {
  getAccountingProvider, getAccountingProviderByName, getActiveAccountingProvider, PROVIDER_NONE,
} from './accountingProvider.js';
import { SalesHttpError } from './salesAccess.js';

export function buildSalesProviderIdempotencyKey(tenantId, saleId, provider) {
  const digest = createHash('sha256').update(`${tenantId}:${saleId}:${provider}`).digest('hex');
  return `si_${digest.slice(0, 47)}`;
}

const one = async (query, message) => {
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new SalesHttpError(404, message);
  return data;
};
const customerFrom = (version) => {
  const org = version.organisation_snapshot || {};
  const contact = version.billing_contact_snapshot || version.customer_contact_snapshot || {};
  const addressValue = version.address_snapshot || org.address || org.address_line_1 || null;
  const address = addressValue && typeof addressValue === 'object'
    ? [
      addressValue.line1 || addressValue.addressLine1 || addressValue.address_line_1,
      addressValue.line2 || addressValue.addressLine2 || addressValue.address_line_2,
      addressValue.city, addressValue.postcode || addressValue.postalCode,
      addressValue.country,
    ].filter(Boolean).join('\n')
    : addressValue;
  return {
    organisationId: org.id,
    name: org.name || org.organization_name || org.organisation_name,
    email: contact.email || contact.email_address || org.email || null,
    address,
  };
};
const externalError = (error, provider) => {
  if (error instanceof SalesHttpError) return error;
  if (error?.code === 'ACCOUNTING_UNREPRESENTABLE') {
    const invalid = new SalesHttpError(422, error.message);
    invalid.code = error.code;
    return invalid;
  }
  if (error?.code === 'ACCOUNTING_TOTAL_MISMATCH') {
    const mismatch = new SalesHttpError(502, error.message);
    mismatch.code = error.code;
    mismatch.details = error.details || {};
    return mismatch;
  }
  const wrapped = new SalesHttpError(502, `${provider === 'quickbooks' ? 'QuickBooks' : 'Xero'} invoice operation failed`);
  wrapped.code = 'ACCOUNTING_PROVIDER_ERROR';
  wrapped.cause = error;
  return wrapped;
};
export const mapSalesInvoiceLink = (row) => ({
  id: row.id, saleId: row.sale_id, quoteVersionId: row.quote_version_id,
  provider: row.provider, invoiceId: row.provider_invoice_id,
  invoiceNumber: row.provider_invoice_number, invoiceUrl: row.provider_invoice_url,
  status: row.provider_status, statusRaw: row.provider_status_raw,
  providerCreatedAt: row.provider_created_at, statusRefreshedAt: row.status_refreshed_at,
  createdAt: row.created_at,
});

export function selectSalesInvoiceForProvider(links, activeProvider) {
  return (links || []).find((link) => link.provider === activeProvider) || null;
}

export function salesInvoicePermissions({ canManageAccounting, canView, saleId, activeProvider, invoice }) {
  const canUseActiveProvider = Boolean(canManageAccounting && saleId && activeProvider && activeProvider !== PROVIDER_NONE);
  return {
    canCreateInvoice: canUseActiveProvider && !invoice,
    // Retrying is the same idempotent conversion command; it is only useful
    // while the active provider has no completed linkage.
    canRetryInvoice: canUseActiveProvider && !invoice,
    canViewInvoice: Boolean(canView && saleId),
  };
}

export function invoiceClaimOutcome(claim) {
  if (!claim?.state) throw new SalesHttpError(503, 'Could not claim Sales invoice conversion');
  if (claim.state === 'in_progress') {
    const progress = new SalesHttpError(409, 'Sales invoice conversion is already in progress; retry shortly');
    progress.code = 'ACCOUNTING_INVOICE_IN_PROGRESS';
    progress.details = { retryable: true, attemptId: claim.attemptId };
    throw progress;
  }
  return claim;
}

export async function getSalesInvoicePresentation(db, tenantId, {
  saleId = null, quoteId = null, opportunityId = null, activeProvider = null,
} = {}, dependencies = {}) {
  const active = activeProvider || await (dependencies.getActiveAccountingProvider
    || (async (id) => (await getAccountingProvider(id)).name))(tenantId);
  let sale = null;
  if (saleId) {
    const { data, error } = await db.from('sales_commercial_sale').select('*')
      .eq('tenant_id', tenantId).eq('id', saleId).maybeSingle();
    if (error) throw error;
    sale = data;
  } else if (quoteId || opportunityId) {
    let query = db.from('sales_commercial_sale').select('*').eq('tenant_id', tenantId);
    query = quoteId ? query.eq('quote_id', quoteId) : query.eq('opportunity_id', opportunityId);
    // An opportunity can have amended/replaced quotes. Its invoice panel uses
    // the latest confirmed sale without making an older sale disappear from
    // that sale's own quote/accounting history.
    if (opportunityId && !quoteId) query = query.order('created_at', { ascending: false }).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    sale = data;
  }
  if (!sale) return { sale: null, saleId: null, activeProvider: active, invoice: null, invoices: [], acceptedQuote: null };
  const [{ data: links, error: linkError }, { data: version, error: versionError }] = await Promise.all([
    db.from('sales_accounting_invoice_link').select('*').eq('tenant_id', tenantId)
      .eq('sale_id', sale.id).order('created_at'),
    db.from('sales_quote_version').select('id,quote_id,version_number,status').eq('tenant_id', tenantId)
      .eq('id', sale.quote_version_id).maybeSingle(),
  ]);
  if (linkError) throw linkError;
  if (versionError) throw versionError;
  const invoices = (links || []).map(mapSalesInvoiceLink);
  return {
    sale, saleId: sale.id, activeProvider: active,
    invoice: selectSalesInvoiceForProvider(invoices, active),
    invoices, acceptedQuote: version ? {
      id: version.quote_id, versionId: version.id, versionNumber: version.version_number,
    } : null,
  };
}

export async function getSalesAccountingConfiguration(db, tenantId, dependencies = {}) {
  const activeProvider = await (dependencies.getActiveAccountingProvider || getActiveAccountingProvider)(tenantId);
  if (!['xero', 'quickbooks'].includes(activeProvider)) {
    const error = new SalesHttpError(409, 'No active accounting provider is configured');
    error.code = 'ACCOUNTING_PROVIDER_NONE';
    throw error;
  }
  const provider = (dependencies.getAccountingProviderByName || getAccountingProviderByName)(activeProvider);
  const [mappingResult, settingsResult, salesResult, saleResult, availableTaxCodes, availableItems] = await Promise.all([
    db.from('sales_accounting_tax_mapping').select('*').eq('tenant_id', tenantId)
      .eq('provider', activeProvider).eq('tax_treatment', 'standard'),
    db.from('system_settings').select('setting_value').eq('tenant_id', tenantId)
      .eq('setting_key', 'quickbooks_sales_item_id').maybeSingle(),
    db.from('sales_settings').select('default_tax_rate_bps').eq('tenant_id', tenantId).maybeSingle(),
    db.from('sales_commercial_sale').select('quote_version_id').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(500),
    provider.listSalesTaxCodes(tenantId),
    provider.listSalesItems(tenantId),
  ]);
  for (const result of [mappingResult, settingsResult, salesResult, saleResult]) if (result.error) throw result.error;
  const versionIds = [...new Set((saleResult.data || []).map((sale) => sale.quote_version_id).filter(Boolean))];
  let acceptedRates = [];
  if (versionIds.length) {
    const { data, error } = await db.from('sales_quote_line').select('tax_rate_bps')
      .eq('tenant_id', tenantId).in('quote_version_id', versionIds).limit(2000);
    if (error) throw error;
    acceptedRates = (data || []).map((line) => Number(line.tax_rate_bps));
  }
  const mappings = (mappingResult.data || []).map((row) => ({
    taxRateBps: Number(row.tax_rate_bps), providerTaxCodeId: row.provider_tax_code,
    providerTaxCodeName: row.provider_tax_name,
  }));
  const requiredTaxRates = [...new Set([
    0, Number(salesResult.data?.default_tax_rate_bps || 0),
    ...mappings.map((mapping) => mapping.taxRateBps), ...acceptedRates,
  ])].filter((rate) => Number.isInteger(rate) && rate >= 0 && rate <= 100000).sort((a, b) => a - b);
  const mappedRates = new Set(mappings.map((mapping) => mapping.taxRateBps));
  const quickbooksSalesItemId = settingsResult.data?.setting_value || null;
  const missing = requiredTaxRates.filter((rate) => !mappedRates.has(rate))
    .map((taxRateBps) => ({ code: 'MISSING_TAX_MAPPING', provider: activeProvider, taxRateBps }));
  if (activeProvider === 'quickbooks' && !quickbooksSalesItemId) {
    missing.push({ code: 'MISSING_SALES_ITEM', provider: activeProvider });
  }
  return {
    activeProvider, isReady: missing.length === 0, missing, requiredTaxRates, mappings,
    availableTaxCodes, quickbooksSalesItemId, availableItems,
  };
}

export async function saveSalesAccountingConfiguration(db, tenantId, input, dependencies = {}) {
  const current = await getSalesAccountingConfiguration(db, tenantId, dependencies);
  const taxCodes = new Map(current.availableTaxCodes.map((code) => [String(code.id), code]));
  const submittedRates = new Set();
  const mappings = input.mappings.map((mapping) => {
    const code = taxCodes.get(String(mapping.providerTaxCodeId));
    if (!code) {
      const error = new SalesHttpError(422, 'Selected tax code is not active in the connected provider');
      error.code = 'ACCOUNTING_TAX_CODE_INVALID';
      error.details = { provider: current.activeProvider, taxRateBps: mapping.taxRateBps };
      throw error;
    }
    submittedRates.add(mapping.taxRateBps);
    return { ...mapping, providerTaxCodeId: String(code.id), providerTaxCodeName: code.name };
  });
  const missingRate = current.requiredTaxRates.find((rate) => !submittedRates.has(rate));
  if (missingRate != null) {
    const error = new SalesHttpError(422, `A provider tax code is required for ${missingRate} basis points`);
    error.code = 'ACCOUNTING_TAX_MAPPING_REQUIRED';
    error.details = { provider: current.activeProvider, taxRateBps: missingRate };
    throw error;
  }
  let itemId = null;
  if (current.activeProvider === 'quickbooks') {
    itemId = String(input.quickbooksSalesItemId || '');
    if (!current.availableItems.some((item) => String(item.id) === itemId)) {
      const error = new SalesHttpError(422, 'Selected QuickBooks sales item is not active or supported');
      error.code = 'ACCOUNTING_SALES_ITEM_INVALID';
      error.details = { provider: current.activeProvider };
      throw error;
    }
  }
  const { error } = await db.rpc('save_sales_accounting_configuration', {
    p_tenant_id: tenantId, p_provider: current.activeProvider,
    p_mappings: mappings, p_quickbooks_sales_item_id: itemId,
  });
  if (error) throw error;
  return getSalesAccountingConfiguration(db, tenantId, dependencies);
}

async function existingLink(db, tenantId, saleId, provider) {
  const { data, error } = await db.from('sales_accounting_invoice_link').select('*')
    .eq('tenant_id', tenantId).eq('sale_id', saleId).eq('provider', provider).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function releaseCustomerMappingClaim(db, tenantId, mappingClaim) {
  if (!mappingClaim?.mappingId || !mappingClaim?.claimToken) {
    throw new SalesHttpError(503, 'Provider customer mapping claim is incomplete');
  }
  const { data, error } = await db.rpc('release_sales_accounting_customer_mapping_claim', {
    p_tenant_id: tenantId, p_mapping_id: mappingClaim.mappingId,
    p_claim_token: mappingClaim.claimToken,
  });
  if (error) throw error;
  // false means the exact token no longer owns a creating row (it was either
  // completed or reclaimed); ownership safety deliberately makes that a no-op.
  return data === true;
}

async function resolveCustomer(db, provider, tenantId, actor, customer, command) {
  if (!customer.organisationId || !customer.name) {
    throw new SalesHttpError(422, 'Accepted quote has no valid organisation snapshot');
  }
  const { data: mappingClaimData, error: mappingClaimError } = await db.rpc('claim_sales_accounting_customer_mapping', {
    p_tenant_id: tenantId, p_organisation_id: customer.organisationId,
    p_provider: provider.name, p_actor_id: actor.actorId,
  });
  if (mappingClaimError) throw mappingClaimError;
  const mappingClaim = Array.isArray(mappingClaimData) ? mappingClaimData[0] : mappingClaimData;
  if (mappingClaim?.state === 'mapped') return mappingClaim.customerId;
  if (mappingClaim?.state === 'in_progress') {
    const progress = new SalesHttpError(409, 'Provider customer creation is already in progress; retry shortly');
    progress.code = 'ACCOUNTING_CUSTOMER_IN_PROGRESS';
    progress.details = { retryable: true, mappingId: mappingClaim.mappingId };
    throw progress;
  }
  if (mappingClaim?.state !== 'claimed') throw new SalesHttpError(503, 'Could not claim provider customer mapping');
  try {
    const candidates = await provider.findSalesCustomers(tenantId, customer);
    let selected;
    let matchKind;
    if (command.providerCustomerId) {
      if (!command.confirmCustomerMatch) throw new SalesHttpError(400, 'Explicit customer confirmation is required');
      selected = candidates.find((item) => String(item.id) === String(command.providerCustomerId));
      if (!selected) throw new SalesHttpError(422, 'Selected provider customer was not found in this tenant connection');
      matchKind = 'confirmed';
    } else if (candidates.length === 0) {
      selected = { id: await provider.createSalesCustomer(tenantId, customer), name: customer.name };
      matchKind = 'created';
    } else if (candidates.length === 1
        && String(candidates[0].name).trim().toLowerCase() === customer.name.trim().toLowerCase()) {
      selected = candidates[0];
      matchKind = 'exact';
    } else {
      const conflict = new SalesHttpError(409, 'Provider customer match requires explicit confirmation');
      conflict.code = 'AMBIGUOUS_CUSTOMER_MATCH';
      conflict.details = { candidates };
      throw conflict;
    }
    const row = {
      tenant_id: tenantId, organisation_id: customer.organisationId, provider: provider.name,
      provider_customer_id: String(selected.id), provider_customer_name: selected.name || customer.name,
      match_kind: matchKind, claim_token: null,
      confirmed_by: matchKind === 'confirmed' ? actor.actorId : null,
      confirmed_at: matchKind === 'confirmed' ? new Date().toISOString() : null,
    };
    const { data, error: updateError } = await db.from('sales_accounting_customer_mapping')
      .update(row).eq('tenant_id', tenantId).eq('id', mappingClaim.mappingId)
      .eq('match_kind', 'creating').eq('claim_token', mappingClaim.claimToken).select('*').single();
    if (updateError) throw updateError;
    return data.provider_customer_id;
  } catch (error) {
    try {
      await releaseCustomerMappingClaim(db, tenantId, mappingClaim);
    } catch (releaseError) {
      const failure = new SalesHttpError(503, 'Provider customer operation failed and its claim could not be released');
      failure.code = 'ACCOUNTING_CUSTOMER_RELEASE_FAILED';
      failure.details = { originalCode: error?.code || null, originalMessage: error?.message || null };
      failure.cause = releaseError;
      throw failure;
    }
    throw error;
  }
}

export async function buildInvoice(db, tenantId, sale, version, lines, providerName, customerId) {
  if (!validateCurrency(version.currency)) throw new SalesHttpError(422, 'Accepted quote currency is invalid');
  if (!lines.length) throw new SalesHttpError(422, 'Accepted quote has no invoice lines');
  const validatedLines = lines.map((line, index) => {
    let expected;
    try {
      expected = calculateQuoteLine({
        quantity: String(line.quantity), quotedUnitPriceMinor: Number(line.quoted_unit_price_minor),
        discountBps: Number(line.discount_bps), taxRateBps: Number(line.tax_rate_bps),
      });
    } catch (error) {
      throw new SalesHttpError(422, `Accepted quote line ${index + 1} is invalid: ${error.message}`);
    }
    for (const [column, expectedValue] of [['net_minor', expected.netMinor], ['tax_minor', expected.taxMinor], ['gross_minor', expected.grossMinor]]) {
      if (!Number.isSafeInteger(Number(line[column])) || Number(line[column]) !== expectedValue) {
        throw new SalesHttpError(422, `Accepted quote line ${index + 1} ${column} does not match its immutable quantity, price, discount, and tax`);
      }
    }
    return { ...line, expected };
  });
  let expectedTotals;
  try {
    expectedTotals = calculateQuoteTotals(validatedLines.map((line) => ({
      quantity: String(line.quantity), quotedUnitPriceMinor: Number(line.quoted_unit_price_minor),
      discountBps: Number(line.discount_bps), taxRateBps: Number(line.tax_rate_bps),
    })));
  } catch (error) {
    throw new SalesHttpError(422, `Accepted quote totals are invalid: ${error.message}`);
  }
  for (const [column, expectedValue] of [['net_minor', expectedTotals.netMinor], ['tax_minor', expectedTotals.taxMinor], ['gross_minor', expectedTotals.grossMinor]]) {
    if (Number(version[column]) !== expectedValue) throw new SalesHttpError(422, `Accepted quote ${column} does not match immutable lines`);
  }
  const rates = [...new Set(validatedLines.map((line) => Number(line.tax_rate_bps)))];
  const { data: taxes, error } = await db.from('sales_accounting_tax_mapping').select('*')
    .eq('tenant_id', tenantId).eq('provider', providerName)
    // Configuration is rate-to-provider-code. Zero/non-tax treatment is an
    // explicit administrator-selected provider code, never inferred here.
    .eq('tax_treatment', 'standard').in('tax_rate_bps', rates);
  if (error) throw error;
  const taxCodes = new Map((taxes || []).map((row) => [Number(row.tax_rate_bps), row.provider_tax_code]));
  const missing = rates.filter((rate) => !Number.isInteger(rate) || rate < 0 || !taxCodes.has(rate));
  if (missing.length) {
    const invalid = new SalesHttpError(422, `No ${providerName} tax mapping for rate(s): ${missing.join(', ')}`);
    invalid.code = 'ACCOUNTING_TAX_MAPPING_REQUIRED';
    invalid.details = { provider: providerName, missingTaxRates: missing };
    throw invalid;
  }
  let itemId = null; let accountCode = null;
  const settingKey = providerName === 'quickbooks' ? 'quickbooks_sales_item_id' : 'xero_sales_account_code';
  const { data: setting, error: settingError } = await db.from('system_settings').select('setting_value')
    .eq('tenant_id', tenantId).eq('setting_key', settingKey).maybeSingle();
  if (settingError) throw settingError;
  if (providerName === 'quickbooks' && !setting?.setting_value) {
    const invalid = new SalesHttpError(422, `${settingKey} is not configured`);
    invalid.code = 'ACCOUNTING_SALES_ITEM_REQUIRED';
    invalid.details = { provider: providerName, settingKey };
    throw invalid;
  }
  if (providerName === 'quickbooks') itemId = String(setting.setting_value);
  else accountCode = String(setting?.setting_value || '200');
  return {
    customerId, currency: version.currency,
    netMinor: Number(version.net_minor), taxMinor: Number(version.tax_minor),
    grossMinor: Number(version.gross_minor),
    purchaseOrderReference: version.purchase_order_reference,
    customerReference: version.customer_reference,
    idempotencyKey: null,
    lines: validatedLines.map((line) => ({
      description: line.description, quantity: String(line.quantity),
      unitPriceMinor: Number(line.quoted_unit_price_minor), netMinor: Number(line.net_minor),
      taxMinor: Number(line.tax_minor), grossMinor: Number(line.gross_minor),
      discountBps: Number(line.discount_bps),
      taxRateBps: Number(line.tax_rate_bps), taxCode: taxCodes.get(Number(line.tax_rate_bps)),
      itemId, accountCode,
    })),
  };
}

export async function createSalesInvoice(db, tenantId, actor, saleId, command = {}, dependencies = {}) {
  const getProvider = dependencies.getAccountingProvider || getAccountingProvider;
  const provider = await getProvider(tenantId);
  if (!provider || provider.name === PROVIDER_NONE) throw new SalesHttpError(409, 'No active accounting provider is configured');
  const found = await existingLink(db, tenantId, saleId, provider.name);
  if (found) return { invoice: mapSalesInvoiceLink(found), existing: true };
  const sale = await one(db.from('sales_commercial_sale').select('*').eq('tenant_id', tenantId).eq('id', saleId),
    'Confirmed commercial sale not found');
  const version = await one(db.from('sales_quote_version').select('*').eq('tenant_id', tenantId).eq('id', sale.quote_version_id),
    'Accepted quote version not found');
  if (!['accepted', 'converted'].includes(version.status)) throw new SalesHttpError(409, 'Sale source quote version is not accepted');
  const { data: lines, error: lineError } = await db.from('sales_quote_line').select('*')
    .eq('tenant_id', tenantId).eq('quote_version_id', version.id).order('display_order');
  if (lineError) throw lineError;
  const { data: claimData, error: claimError } = await db.rpc('claim_sales_accounting_invoice_attempt', {
    p_tenant_id: tenantId, p_sale_id: sale.id, p_provider: provider.name, p_actor_id: actor.actorId,
  });
  if (claimError) throw claimError;
  const claim = Array.isArray(claimData) ? claimData[0] : claimData;
  invoiceClaimOutcome(claim);
  if (claim.state === 'linked') {
    const linked = await existingLink(db, tenantId, sale.id, provider.name);
    if (linked) return { invoice: mapSalesInvoiceLink(linked), existing: true };
    throw new SalesHttpError(503, 'Sales invoice linkage is being finalized');
  }
  const attempt = { id: claim.attemptId };
  try {
    const customer = customerFrom(version);
    const customerId = await resolveCustomer(db, provider, tenantId, actor, customer, command);
    const payload = await buildInvoice(db, tenantId, sale, version, lines || [], provider.name, customerId);
    // RPC owns the durable canonical key. This assignment deliberately
    // replaces the locally derived convenience key on retries/crash recovery.
    payload.idempotencyKey = claim.providerIdempotencyKey;
    const external = await provider.createSalesInvoice(tenantId, payload);
    const linkRow = {
      tenant_id: tenantId, sale_id: sale.id, quote_version_id: version.id, provider: provider.name,
      provider_invoice_id: String(external.id), provider_invoice_number: external.number || null,
      provider_invoice_url: external.url || null, provider_status: normalizeSalesInvoiceStatus(external.status),
      provider_status_raw: external.status || null, provider_created_at: external.createdAt || null,
      status_refreshed_at: new Date().toISOString(), created_by: actor.actorId,
    };
    let { data: link, error: linkError } = await db.from('sales_accounting_invoice_link').insert(linkRow).select('*').single();
    if (linkError?.code === '23505') {
      // A retry which lost the race to persist this sale/provider linkage is
      // successful. Do not, however, mistake the distinct unique constraint
      // on (tenant, provider, provider_invoice_id) for that benign race: that
      // means a provider document is already irreversibly linked to another
      // commercial sale and must never be silently associated here.
      link = await existingLink(db, tenantId, sale.id, provider.name);
      if (!link) {
        const conflict = new SalesHttpError(409,
          'Provider invoice is already linked to another commercial sale');
        conflict.code = 'ACCOUNTING_INVOICE_LINK_CONFLICT';
        conflict.details = { provider: provider.name, providerInvoiceId: String(external.id) };
        throw conflict;
      }
    }
    else if (linkError) throw linkError;
    await db.from('sales_accounting_invoice_attempt').update({
      state: 'succeeded', link_id: link.id, completed_at: new Date().toISOString(),
    }).eq('id', attempt.id).eq('tenant_id', tenantId);
    return { invoice: mapSalesInvoiceLink(link), existing: Boolean(linkError) };
  } catch (error) {
    await db.from('sales_accounting_invoice_attempt').update({
      state: 'failed', error_code: error.code || 'ACCOUNTING_ERROR',
      error_message: String(error.message || 'Accounting failure').slice(0, 2000),
      completed_at: new Date().toISOString(),
    }).eq('id', attempt.id).eq('tenant_id', tenantId);
    throw externalError(error, provider.name);
  }
}

export async function getSalesInvoices(db, tenantId, saleId) {
  await one(db.from('sales_commercial_sale').select('id').eq('tenant_id', tenantId).eq('id', saleId),
    'Confirmed commercial sale not found');
  const { data, error } = await db.from('sales_accounting_invoice_link').select('*')
    .eq('tenant_id', tenantId).eq('sale_id', saleId).order('created_at');
  if (error) throw error;
  return { items: (data || []).map(mapSalesInvoiceLink) };
}

export async function refreshSalesInvoiceStatus(db, tenantId, saleId, providerName, dependencies = {}) {
  const link = await existingLink(db, tenantId, saleId, providerName);
  if (!link) throw new SalesHttpError(404, 'Sales invoice linkage not found');
  const activeProvider = await (dependencies.getActiveAccountingProvider || getActiveAccountingProvider)(tenantId);
  if (activeProvider !== providerName) {
    const disconnected = new SalesHttpError(409,
      'This invoice belongs to a historical accounting provider that is no longer active; its stored status is retained');
    disconnected.code = 'ACCOUNTING_PROVIDER_HISTORICAL';
    disconnected.details = { invoice: mapSalesInvoiceLink(link), activeProvider, retryable: false };
    throw disconnected;
  }
  const provider = (dependencies.getAccountingProviderByName || getAccountingProviderByName)(providerName);
  try {
    const result = await provider.fetchInvoiceStatus(link.provider_invoice_id, tenantId);
    const raw = result?.status || result?.Status || result;
    const { data, error } = await db.from('sales_accounting_invoice_link').update({
      provider_status: normalizeSalesInvoiceStatus(raw), provider_status_raw: String(raw || ''),
      status_refreshed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('tenant_id', tenantId).eq('id', link.id).select('*').single();
    if (error) throw error;
    return { invoice: mapSalesInvoiceLink(data) };
  } catch (error) { throw externalError(error, providerName); }
}