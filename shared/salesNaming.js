// Display terminology only. API, permission and financial identities never change.
export const DEFAULT_QUOTE_NAMING = Object.freeze({ singular: 'Quote', plural: 'Quotes', slug: 'quotes' });
export const RESERVED_SALES_SEGMENTS = Object.freeze([
  'dashboard', 'pipeline', 'opportunities', 'catalogue', 'products', 'bundles',
  'tasks', 'reports', 'settings', 'allocations',
]);
export function quoteNamingErrors(patch) {
  const errors = [];
  for (const [key, label] of [['quoteSingularName', 'Singular name'], ['quotePluralName', 'Plural name']]) {
    if (Object.hasOwn(patch, key) && (typeof patch[key] !== 'string'
      || [...patch[key].trim()].length < 1 || [...patch[key].trim()].length > 100)) {
      errors.push(`${label} must contain 1–100 characters.`);
    }
  }
  if (Object.hasOwn(patch, 'quoteUrlSegment')) {
    const slug = patch.quoteUrlSegment;
    if (typeof slug !== 'string' || slug.length > 100
      || /[^a-z0-9-]/.test(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      errors.push('URL segment must contain 1–100 lowercase letters, digits or single hyphens, with no leading or trailing hyphen.');
    } else if (RESERVED_SALES_SEGMENTS.includes(slug)) {
      errors.push(`“${slug}” is reserved for another Sales page. Choose a different URL segment.`);
    }
  }
  return errors;
}
export function resolveQuoteNaming(settings) {
  return {
    singular: settings?.quoteSingularName ?? DEFAULT_QUOTE_NAMING.singular,
    plural: settings?.quotePluralName ?? DEFAULT_QUOTE_NAMING.plural,
    slug: settings?.quoteUrlSegment ?? DEFAULT_QUOTE_NAMING.slug,
  };
}
export function suggestQuoteSlug(plural) {
  return plural.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100).replace(/-$/, '');
}
export function quotePath(naming = DEFAULT_QUOTE_NAMING, id) {
  return `/sales/${naming.slug}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
export function isQuoteRoute(path, naming = DEFAULT_QUOTE_NAMING) {
  const parts = String(path).split(/[?#]/)[0].replace(/\/+$/, '').split('/');
  return parts[0] === '' && parts[1]?.toLowerCase() === 'sales'
    && (parts[2]?.toLowerCase() === 'quotes'
      || (!RESERVED_SALES_SEGMENTS.includes(naming.slug) && parts[2] === naming.slug))
    && (parts.length === 3 || (parts.length === 4 && /^(?:new|[a-zA-Z0-9_-]+)$/.test(parts[3])));
}
// Rewrite only known internal routes, never customer links or authored labels.
export function canonicalQuoteLink(url, naming, previousNaming) {
  if (!isQuoteRoute(url, naming) && !(previousNaming && isQuoteRoute(url, previousNaming))) return url;
  return url.replace(/^\/sales\/[^/?#]+/i, quotePath(naming));
}
