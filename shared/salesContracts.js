/**
 * Shared Sales foundation contract.
 *
 * Money is always an integer number of minor units. A commercial document has
 * exactly one ISO-4217 currency; line values never carry an independent
 * currency. Issued versions are immutable and amendments create version + 1.
 */
export const SALES_CAPABILITIES = Object.freeze({
  VIEW: 'sales.view',
  MANAGE_OPPORTUNITIES: 'sales.opportunities.manage',
  MANAGE_QUOTES: 'sales.quotes.manage',
  MANAGE_CATALOGUE_PRICES: 'sales.catalogue-prices.manage',
  MANAGE_ACCOUNTING: 'sales.accounting.manage',
  MANAGE_ALLOCATIONS: 'sales.allocations.manage',
  VIEW_REPORTS: 'sales.reports.view',
  VIEW_ALL_OWNERS: 'sales.owners.view-all',
  MANAGE_SETTINGS: 'sales.settings.manage',
});

// Roles use an exclusion-list model, so new roles must explicitly exclude the
// module until an administrator grants Sales access.
export const SALES_DEFAULT_ROLE_EXCLUSIONS = Object.freeze(['sales']);

export const SALES_QUOTE_STATUSES = Object.freeze([
  'draft', 'issued', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'converted',
]);
export const IMMUTABLE_QUOTE_STATUSES = Object.freeze([
  'issued', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'converted',
]);
export const SALES_QUOTE_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['issued']),
  issued: Object.freeze(['sent', 'accepted', 'declined', 'expired']),
  sent: Object.freeze(['accepted', 'declined', 'expired']),
  accepted: Object.freeze(['converted']),
  declined: Object.freeze([]),
  expired: Object.freeze([]),
  superseded: Object.freeze([]),
  converted: Object.freeze([]),
});
export const SALES_SEQUENCE_KINDS = Object.freeze(['quote']);
export const SALES_ACTOR_TYPES = Object.freeze(['tenant_user', 'member', 'system']);
export const SALES_CATALOGUE_ENTITY_TYPES = Object.freeze(['category', 'product', 'bundle']);
export const SALES_TAX_TREATMENTS = Object.freeze(['standard', 'zero_rated', 'exempt', 'outside_scope']);
export const SALES_BUNDLE_PRESENTATION_MODES = Object.freeze(['bundle', 'itemised']);
export const SALES_EVENT_REFERENCE_KINDS = Object.freeze(['simple', 'complex']);

export const DEFAULT_SALES_SETTINGS = Object.freeze({
  quotePrefix: 'Q',
  quoteNumberPadding: 6,
  defaultCurrency: 'GBP',
  defaultTaxRateBps: 0,
  defaultTerms: '',
  moduleEnabled: true,
  version: 1,
});

const CURRENCY_RE = /^[A-Z]{3}$/;
const PREFIX_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

export function isMinorUnitAmount(value) {
  return Number.isSafeInteger(value);
}

export function validateCurrency(value) {
  return typeof value === 'string' && CURRENCY_RE.test(value);
}

export function validateMoney(value, documentCurrency) {
  return Boolean(
    value && typeof value === 'object'
    && isMinorUnitAmount(value.amountMinor)
    && validateCurrency(value.currency)
    && (!documentCurrency || value.currency === documentCurrency),
  );
}

export function canTransitionQuote(from, to) {
  return Boolean(SALES_QUOTE_TRANSITIONS[from]?.includes(to));
}

export function nextQuoteVersion(currentVersion, currentStatus) {
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new TypeError('Quote version must be a positive integer');
  }
  if (!IMMUTABLE_QUOTE_STATUSES.includes(currentStatus)) {
    throw new TypeError('Only an immutable quote can be superseded');
  }
  return currentVersion + 1;
}

const DECIMAL_RE = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/**
 * Quantities cross the API as canonical decimal strings. Returning a scaled
 * integer keeps every multiplication outside IEEE-754 arithmetic.
 */
export function parseQuoteQuantity(value) {
  if (typeof value !== 'string') throw new TypeError('Quantity must be a decimal string');
  const match = DECIMAL_RE.exec(value);
  if (!match || value === '0' || /^0\.0*$/.test(value)) {
    throw new TypeError('Quantity must be a positive decimal with at most 6 decimal places');
  }
  const scale = 10 ** (match[2] ? match[2].length : 0);
  const units = BigInt(match[0].replace('.', ''));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Quantity is too large');
  return { units, scale: BigInt(scale), canonical: match[2] ? `${match[1]}.${match[2].replace(/0+$/, '')}`.replace(/\.$/, '') : match[0] };
}

function roundedDivide(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

export function calculateQuoteLine({ quantity, quotedUnitPriceMinor, discountBps = 0, taxRateBps = 0 }) {
  if (!isMinorUnitAmount(quotedUnitPriceMinor) || quotedUnitPriceMinor < 0) {
    throw new TypeError('quotedUnitPriceMinor must be a non-negative safe integer');
  }
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 100000) {
    throw new TypeError('taxRateBps must be an integer from 0 to 100000');
  }
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000) {
    throw new TypeError('discountBps must be an integer from 0 to 10000');
  }
  const parsed = parseQuoteQuantity(quantity);
  const discountedUnit = roundedDivide(BigInt(quotedUnitPriceMinor) * BigInt(10000 - discountBps), 10000n);
  const net = roundedDivide(parsed.units * discountedUnit, parsed.scale);
  const tax = roundedDivide(net * BigInt(taxRateBps), 10000n);
  const gross = net + tax;
  for (const amount of [net, tax, gross]) {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Calculated quote amount exceeds safe integer range');
  }
  return { quantity: parsed.canonical, discountedUnitPriceMinor: Number(discountedUnit), netMinor: Number(net), taxMinor: Number(tax), grossMinor: Number(gross) };
}

export function calculateQuoteTotals(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new TypeError('At least one quote line is required');
  const totals = lines.reduce((sum, line) => {
    const calculated = calculateQuoteLine(line);
    return {
      netMinor: sum.netMinor + BigInt(calculated.netMinor),
      taxMinor: sum.taxMinor + BigInt(calculated.taxMinor),
      grossMinor: sum.grossMinor + BigInt(calculated.grossMinor),
    };
  }, { netMinor: 0n, taxMinor: 0n, grossMinor: 0n });
  if (Object.values(totals).some((amount) => amount > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new RangeError('Calculated quote total exceeds safe integer range');
  }
  return Object.fromEntries(Object.entries(totals).map(([key, amount]) => [key, Number(amount)]));
}

export function validateQuoteDraft(value, { existing = false } = {}) {
  if (!isObject(value)) return { ok: false, errors: ['Body must be an object'] };
  const allowed = new Set([
    'expectedVersion', 'currency', 'opportunityId', 'organisationId', 'customerContactId', 'billingContactId',
    'address', 'event', 'eventId', 'terms', 'paymentTerms', 'salesperson', 'salespersonId',
    'validUntil', 'issueDate', 'purchaseOrderReference', 'customerReference', 'taxTreatment', 'notes', 'lines',
  ]);
  const errors = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `Unknown quote field: ${key}`);
  if (existing && (!Number.isInteger(value.expectedVersion) || value.expectedVersion < 1)) errors.push('expectedVersion must be a positive integer');
  if (!existing && 'expectedVersion' in value) errors.push('expectedVersion is not valid when creating a quote');
  if (!validateCurrency(value.currency)) errors.push('currency must be a three-letter uppercase ISO-4217 code');
  for (const key of ['opportunityId', 'organisationId', 'customerContactId', 'billingContactId', 'eventId', 'salespersonId']) {
    if (value[key] != null && !UUID_RE.test(value[key])) errors.push(`${key} must be a UUID or null`);
  }
  for (const key of ['address', 'event', 'salesperson']) {
    if (value[key] != null && !isObject(value[key])) errors.push(`${key} must be an object or null`);
  }
  optionalText(errors, value.terms, 'terms', 20000);
  optionalText(errors, value.notes, 'notes', 20000);
  if (!Array.isArray(value.lines) || value.lines.length === 0) errors.push('lines must be a non-empty array');
  else value.lines.forEach((line, index) => {
    if (!isObject(line)) return errors.push(`lines[${index}] must be an object`);
    const lineAllowed = new Set(['kind', 'catalogueId', 'quantity', 'standardUnitPriceMinor', 'quotedUnitPriceMinor', 'discountBps', 'description', 'taxRateBps']);
    for (const key of Object.keys(line)) if (!lineAllowed.has(key)) errors.push(`Unknown lines[${index}] field: ${key}`);
    if (!['product', 'bundle', 'free_text'].includes(line.kind) || (line.kind !== 'free_text' && !UUID_RE.test(line.catalogueId || '')) || (line.kind === 'free_text' && line.catalogueId != null)) errors.push(`lines[${index}] must identify a product, bundle, or free_text item`);
    try { parseQuoteQuantity(line.quantity); } catch (error) { errors.push(`lines[${index}].quantity: ${error.message}`); }
    for (const price of ['standardUnitPriceMinor', 'quotedUnitPriceMinor']) if ((line.kind === 'free_text' || price in line) && (!isMinorUnitAmount(line[price]) || line[price] < 0)) errors.push(`lines[${index}].${price} must be a non-negative safe integer`);
    if ('discountBps' in line && (!Number.isInteger(line.discountBps) || line.discountBps < 0 || line.discountBps > 10000)) errors.push(`lines[${index}].discountBps is invalid`);
    if ('taxRateBps' in line && (!Number.isInteger(line.taxRateBps) || line.taxRateBps < 0 || line.taxRateBps > 100000)) errors.push(`lines[${index}].taxRateBps is invalid`);
    optionalText(errors, line.description, `lines[${index}].description`, 20000);
  });
  return { ok: errors.length === 0, errors };
}

export function normaliseQuoteInput(input) {
  const value = { ...input };
  const take = (camel, snake) => value[camel] ?? value[snake];
  const canonical = {
    ...value, organisationId: take('organisationId', 'organization_id') ?? value.organizationId,
    customerContactId: take('customerContactId', 'customer_contact_id'), billingContactId: take('billingContactId', 'billing_contact_id'),
    issueDate: take('issueDate', 'issue_date'), validUntil: take('validUntil', 'valid_until'),
    purchaseOrderReference: take('purchaseOrderReference', 'purchase_order_reference'), customerReference: take('customerReference', 'customer_reference'),
    taxTreatment: take('taxTreatment', 'tax_treatment'), paymentTerms: take('paymentTerms', 'payment_terms'), salespersonId: take('salespersonId', 'salesperson_id'),
    lines: (value.lines ?? value.lineItems ?? value.line_items ?? []).map((line) => {
      const kind = line.kind ?? line.type ?? line.line_type ?? (line.bundleId ?? line.bundle_id ? 'bundle' : line.productId ?? line.product_id ? 'product' : 'free_text');
      const normalized = { kind, catalogueId: line.catalogueId ?? line.catalogue_id ?? (kind === 'bundle' ? line.bundleId ?? line.bundle_id : line.productId ?? line.product_id) ?? null,
        quantity: typeof line.quantity === 'number' ? String(line.quantity) : line.quantity, standardUnitPriceMinor: line.standardUnitPriceMinor ?? line.standard_unit_price_minor,
        quotedUnitPriceMinor: line.quotedUnitPriceMinor ?? line.quoted_unit_price_minor, discountBps: line.discountBps ?? line.discount_bps ?? 0,
        taxRateBps: line.taxRateBps ?? line.tax_rate_bps, description: line.description };
      return Object.fromEntries(Object.entries(normalized).filter(([, fieldValue]) => fieldValue !== undefined));
    }),
  };
  ['organizationId', 'organization_id', 'customer_contact_id', 'billing_contact_id', 'issue_date', 'valid_until',
    'purchase_order_reference', 'customer_reference', 'tax_treatment', 'payment_terms',
    'salesperson_id', 'lineItems', 'line_items'].forEach((key) => delete canonical[key]);
  return canonical;
}

export function validateQuoteTransition(value) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['Body must be an object'] };
  if (!SALES_QUOTE_STATUSES.includes(value.status) || value.status === 'draft' || value.status === 'superseded') errors.push('status is not a client-transitionable quote status');
  if (!Number.isInteger(value.expectedVersion) || value.expectedVersion < 1) errors.push('expectedVersion must be a positive integer');
  if (Object.keys(value).some((key) => !['status', 'expectedVersion', 'note'].includes(key))) errors.push('Unknown status transition field');
  optionalText(errors, value.note, 'note', 2000);
  return { ok: errors.length === 0, errors };
}

export function validateSalesSettingsPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['Body must be an object'] };
  }
  const allowed = new Set([
    'quotePrefix', 'quoteNumberPadding', 'defaultCurrency',
    'defaultTaxRateBps', 'defaultTerms', 'moduleEnabled', 'expectedVersion',
  ]);
  const errors = [];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`Unknown setting: ${key}`);
  }
  if ('quotePrefix' in value && (
    typeof value.quotePrefix !== 'string' || !PREFIX_RE.test(value.quotePrefix)
  )) errors.push('quotePrefix must be 1-16 uppercase letters, numbers, or hyphens');
  if ('quoteNumberPadding' in value && (
    !Number.isInteger(value.quoteNumberPadding)
    || value.quoteNumberPadding < 1 || value.quoteNumberPadding > 12
  )) errors.push('quoteNumberPadding must be an integer from 1 to 12');
  if ('defaultCurrency' in value && !validateCurrency(value.defaultCurrency)) {
    errors.push('defaultCurrency must be a three-letter uppercase ISO-4217 code');
  }
  if ('defaultTaxRateBps' in value && (
    !Number.isInteger(value.defaultTaxRateBps)
    || value.defaultTaxRateBps < 0 || value.defaultTaxRateBps > 100000
  )) errors.push('defaultTaxRateBps must be an integer from 0 to 100000');
  if ('defaultTerms' in value && (
    typeof value.defaultTerms !== 'string' || value.defaultTerms.length > 20000
  )) errors.push('defaultTerms must be a string of at most 20000 characters');
  if ('moduleEnabled' in value && typeof value.moduleEnabled !== 'boolean') {
    errors.push('moduleEnabled must be boolean');
  }
  if (!Number.isInteger(value.expectedVersion) || value.expectedVersion < 1) {
    errors.push('expectedVersion is required and must be a positive integer');
  }
  if (Object.keys(value).every((key) => key === 'expectedVersion')) {
    errors.push('At least one setting must be supplied');
  }
  return { ok: errors.length === 0, errors };
}

export function mapSalesSettingsRow(row) {
  return {
    quotePrefix: row.quote_prefix,
    quoteNumberPadding: row.quote_number_padding,
    defaultCurrency: row.default_currency,
    defaultTaxRateBps: row.default_tax_rate_bps,
    defaultTerms: row.default_terms,
    moduleEnabled: row.module_enabled,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

const CATALOGUE_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalText = (errors, value, key, maximum) => {
  if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > maximum)) {
    errors.push(`${key} must be a string of at most ${maximum} characters`);
  }
};
const validDate = (value) => value === null || (
  typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
);

export function validateCatalogueCategory(value, { patch = false } = {}) {
  if (!isObject(value)) return { ok: false, errors: ['Body must be an object'] };
  const allowed = new Set(['code', 'name', 'description', 'displayOrder']);
  const errors = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `Unknown category field: ${key}`);
  if ((!patch || 'code' in value) && (typeof value.code !== 'string' || !CATALOGUE_CODE_RE.test(value.code))) {
    errors.push('code must be 1-64 uppercase letters, numbers, underscores, or hyphens');
  }
  if ((!patch || 'name' in value) && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255)) {
    errors.push('name must be a non-empty string of at most 255 characters');
  }
  optionalText(errors, value.description, 'description', 5000);
  if ('displayOrder' in value && (!Number.isInteger(value.displayOrder) || value.displayOrder < 0)) {
    errors.push('displayOrder must be a non-negative integer');
  }
  if (patch && Object.keys(value).length === 0) errors.push('At least one category field must be supplied');
  return { ok: errors.length === 0, errors };
}

export function validateCatalogueProduct(value, { patch = false } = {}) {
  if (!isObject(value)) return { ok: false, errors: ['Body must be an object'] };
  const allowed = new Set([
    'code', 'sku', 'name', 'shortDescription', 'description', 'categoryId', 'currency', 'standardPriceMinor',
    'minimumPriceMinor', 'costMinor', 'taxTreatment', 'taxRateBps', 'availableFrom',
    'availableTo', 'capacityMetadata', 'eventReference', 'displayOrder',
  ]);
  const errors = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `Unknown product field: ${key}`);
  if ((!patch || 'code' in value) && (typeof value.code !== 'string' || !CATALOGUE_CODE_RE.test(value.code))) {
    errors.push('code must be 1-64 uppercase letters, numbers, underscores, or hyphens');
  }
  if ((!patch || 'name' in value) && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255)) {
    errors.push('name must be a non-empty string of at most 255 characters');
  }
  optionalText(errors, value.sku, 'sku', 100);
  optionalText(errors, value.shortDescription, 'shortDescription', 500);
  optionalText(errors, value.description, 'description', 20000);
  if ('categoryId' in value && value.categoryId !== null && !UUID_RE.test(value.categoryId || '')) errors.push('categoryId must be a UUID or null');
  if ((!patch || 'currency' in value) && !validateCurrency(value.currency)) errors.push('currency must be a three-letter uppercase ISO-4217 code');
  for (const key of ['standardPriceMinor', 'minimumPriceMinor', 'costMinor']) {
    if ((!patch && key === 'standardPriceMinor' || key in value)
      && (key === 'standardPriceMinor' && value[key] === null
        || value[key] !== null && (!isMinorUnitAmount(value[key]) || value[key] < 0))) {
      errors.push(`${key} must be a non-negative safe integer${key === 'standardPriceMinor' ? '' : ' or null'}`);
    }
  }
  if ((!patch || 'taxTreatment' in value) && !SALES_TAX_TREATMENTS.includes(value.taxTreatment)) errors.push('taxTreatment is invalid');
  if ('taxRateBps' in value && (!Number.isInteger(value.taxRateBps) || value.taxRateBps < 0 || value.taxRateBps > 100000)) errors.push('taxRateBps must be an integer from 0 to 100000');
  if ('availableFrom' in value && !validDate(value.availableFrom)) errors.push('availableFrom must be an ISO date/time or null');
  if ('availableTo' in value && !validDate(value.availableTo)) errors.push('availableTo must be an ISO date/time or null');
  if (value.availableFrom && value.availableTo && Date.parse(value.availableFrom) > Date.parse(value.availableTo)) errors.push('availableFrom must not be after availableTo');
  if ('capacityMetadata' in value && !isObject(value.capacityMetadata)) errors.push('capacityMetadata must be an object');
  if ('displayOrder' in value && (!Number.isInteger(value.displayOrder) || value.displayOrder < 0)) errors.push('displayOrder must be a non-negative integer');
  if ('eventReference' in value && value.eventReference !== null) {
    const ref = value.eventReference;
    if (!isObject(ref) || !SALES_EVENT_REFERENCE_KINDS.includes(ref.kind)
      || !UUID_RE.test(ref.eventId || '') || typeof ref.ticketTypeId !== 'string' || !ref.ticketTypeId) {
      errors.push('eventReference must contain kind, eventId, and ticketTypeId');
    }
  }
  if (value.minimumPriceMinor != null && value.standardPriceMinor != null
    && value.minimumPriceMinor > value.standardPriceMinor) errors.push('minimumPriceMinor must not exceed standardPriceMinor');
  if (patch && Object.keys(value).length === 0) errors.push('At least one product field must be supplied');
  return { ok: errors.length === 0, errors };
}

export function validateCatalogueBundle(value, { patch = false } = {}) {
  if (!isObject(value)) return { ok: false, errors: ['Body must be an object'] };
  const allowed = new Set(['code', 'name', 'description', 'currency', 'sellingPriceMinor', 'minimumPriceMinor', 'presentationMode', 'availableFrom', 'availableTo', 'displayOrder', 'items']);
  const errors = Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `Unknown bundle field: ${key}`);
  if ((!patch || 'code' in value) && (typeof value.code !== 'string' || !CATALOGUE_CODE_RE.test(value.code))) errors.push('code must be a valid stable catalogue code');
  if ((!patch || 'name' in value) && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255)) errors.push('name must be a non-empty string of at most 255 characters');
  optionalText(errors, value.description, 'description', 20000);
  if ((!patch || 'currency' in value) && !validateCurrency(value.currency)) errors.push('currency must be a three-letter uppercase ISO-4217 code');
  for (const key of ['sellingPriceMinor', 'minimumPriceMinor']) {
    if ((!patch && key === 'sellingPriceMinor' || key in value)
      && (key === 'sellingPriceMinor' && value[key] === null
        || value[key] !== null && (!isMinorUnitAmount(value[key]) || value[key] < 0))) {
      errors.push(`${key} must be a non-negative safe integer${key === 'sellingPriceMinor' ? '' : ' or null'}`);
    }
  }
  if ((!patch || 'presentationMode' in value) && !SALES_BUNDLE_PRESENTATION_MODES.includes(value.presentationMode)) errors.push('presentationMode must be bundle or itemised');
  if ('availableFrom' in value && !validDate(value.availableFrom)) errors.push('availableFrom must be an ISO date/time or null');
  if ('availableTo' in value && !validDate(value.availableTo)) errors.push('availableTo must be an ISO date/time or null');
  if ('displayOrder' in value && (!Number.isInteger(value.displayOrder) || value.displayOrder < 0)) errors.push('displayOrder must be a non-negative integer');
  if (value.availableFrom && value.availableTo && Date.parse(value.availableFrom) > Date.parse(value.availableTo)) errors.push('availableFrom must not be after availableTo');
  if ((!patch || 'items' in value) && (!Array.isArray(value.items) || value.items.length === 0)) errors.push('items must be a non-empty array');
  if (Array.isArray(value.items)) {
    const ids = new Set();
    value.items.forEach((item, index) => {
      if (!isObject(item) || !UUID_RE.test(item.productId || '') || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000) errors.push(`items[${index}] must contain a productId UUID and positive integer quantity`);
      else if (ids.has(item.productId)) errors.push(`items[${index}] duplicates productId`);
      else ids.add(item.productId);
    });
  }
  if (value.minimumPriceMinor != null && value.sellingPriceMinor != null && value.minimumPriceMinor > value.sellingPriceMinor) errors.push('minimumPriceMinor must not exceed sellingPriceMinor');
  if (patch && Object.keys(value).length === 0) errors.push('At least one bundle field must be supplied');
  return { ok: errors.length === 0, errors };
}

export function validateCatalogueReorder(value) {
  const errors = [];
  if (!isObject(value) || !Array.isArray(value.ids) || value.ids.length === 0) errors.push('ids must be a non-empty array');
  else if (new Set(value.ids).size !== value.ids.length || value.ids.some((id) => !UUID_RE.test(id || ''))) errors.push('ids must contain unique UUIDs');
  return { ok: errors.length === 0, errors };
}