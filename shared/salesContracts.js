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
  'draft', 'issued', 'accepted', 'rejected', 'expired', 'cancelled',
]);
export const IMMUTABLE_QUOTE_STATUSES = Object.freeze([
  'issued', 'accepted', 'rejected', 'expired', 'cancelled',
]);
export const SALES_QUOTE_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['issued', 'cancelled']),
  issued: Object.freeze(['accepted', 'rejected', 'expired', 'cancelled']),
  accepted: Object.freeze([]),
  rejected: Object.freeze([]),
  expired: Object.freeze([]),
  cancelled: Object.freeze([]),
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