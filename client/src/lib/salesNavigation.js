import { DEFAULT_QUOTE_NAMING, isQuoteRoute, quotePath, canonicalQuoteLink } from '../../../shared/salesNaming.js';

export const SALES_DESTINATIONS = Object.freeze([
  { key: 'dashboard', label: 'Dashboard', permissionId: 'sales.dashboard' },
  { key: 'pipeline', label: 'Pipeline', permissionId: 'sales.pipeline' },
  { key: 'opportunities', label: 'Opportunities', permissionId: 'sales.opportunities' },
  { key: 'quotes', label: 'Quotes', permissionId: 'sales.quotes' },
  { key: 'catalogue', label: 'Catalogue', permissionId: 'sales.catalogue-prices.manage' },
  { key: 'products', label: 'Products', permissionId: 'sales.catalogue-prices.manage' },
  { key: 'bundles', label: 'Bundles', permissionId: 'sales.catalogue-prices.manage' },
  { key: 'tasks', label: 'Tasks', permissionId: 'sales.tasks' },
  { key: 'reports', label: 'Reports', permissionId: 'sales.reports.view' },
  { key: 'settings', label: 'Settings', permissionId: 'sales.settings' },
].map((destination) => ({
  ...destination,
  path: `/sales/${destination.key}`,
})));

export const SALES_BASE_PERMISSION = 'sales.view';

// Portal menu destinations use real routes, not generated /SalesQuotes aliases.
export const SALES_PORTAL_PAGES = Object.freeze(SALES_DESTINATIONS.map(item => ({
  value: item.path,
  route: item.path,
  label: `Sales — ${item.label}`,
  featureId: item.permissionId,
})));

export function getSalesPortalPermission(url, isExcluded = () => false, naming = DEFAULT_QUOTE_NAMING) {
  const path = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '');
  if (/^\/sales\/allocations\/[a-zA-Z0-9_-]+$/.test(path)) {
    return isExcluded(SALES_BASE_PERMISSION) ? SALES_BASE_PERMISSION : 'sales.allocations.manage';
  }
  const destination = getSalesDestination(path, naming);
  if (!destination) return null;
  return isExcluded(SALES_BASE_PERMISSION) ? SALES_BASE_PERMISSION : destination.permissionId;
}

export const SALES_CATALOGUE_SECTIONS = Object.freeze({
  catalogue: 'categories',
  products: 'products',
  bundles: 'bundles',
});

export function getVisibleSalesDestinations(isExcluded, naming = DEFAULT_QUOTE_NAMING) {
  if (isExcluded(SALES_BASE_PERMISSION)) return [];
  return SALES_DESTINATIONS.filter(({ permissionId }) => !isExcluded(permissionId)).map(item => decorateSalesDestination(item, naming));
}

export function decorateSalesDestination(item, naming = DEFAULT_QUOTE_NAMING) {
  return item.key === 'quotes' ? { ...item, label: naming.plural, path: quotePath(naming) } : item;
}

export function getSalesDestination(key, naming = DEFAULT_QUOTE_NAMING) {
  const path = key.startsWith('/') ? key.split(/[?#]/)[0].replace(/\/+$/, '') : `/sales/${key}`;
  const parts = path.split('/');
  const fixedKey = path === '/sales' ? 'dashboard' : parts[1]?.toLowerCase() === 'sales' ? parts[2]?.toLowerCase() : null;
  const fixed = SALES_DESTINATIONS.find(item => item.key === fixedKey);
  if (fixed && (parts.length <= 3 || (parts.length === 4 && ['quotes', 'opportunities'].includes(fixedKey) && parts[3]))) {
    return decorateSalesDestination(fixed, naming);
  }
  return isQuoteRoute(path, naming) ? decorateSalesDestination(SALES_DESTINATIONS.find(item => item.key === 'quotes'), naming) : null;
}

export function getSalesPortalPages(naming) {
  return SALES_DESTINATIONS.map(item => {
    const destination = decorateSalesDestination(item, naming);
    return { value: destination.path, route: destination.path, label: `Sales — ${destination.label}`, featureId: destination.permissionId };
  });
}

export function decorateSalesMenu(items, naming, { authored = false } = {}) {
  return items.map(item => ({
    ...item,
    ...(item.link_type !== 'external' && isQuoteRoute(item.url, naming) ? {
      url: canonicalQuoteLink(item.url, naming),
      ...(!authored ? { title: naming.plural } : {}),
    } : {}),
    ...(item.subItems ? { subItems: decorateSalesMenu(item.subItems, naming, { authored }) } : {}),
  }));
}

export function getSalesCatalogueSection(destinationKey) {
  return SALES_CATALOGUE_SECTIONS[destinationKey] || null;
}

export function getSalesCataloguePath(section) {
  const destinationKey = Object.entries(SALES_CATALOGUE_SECTIONS)
    .find(([, mappedSection]) => mappedSection === section)?.[0];
  return destinationKey ? `/sales/${destinationKey}` : null;
}