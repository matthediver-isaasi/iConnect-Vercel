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