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

export function getSalesPortalPermission(url, isExcluded = () => false) {
  const path = String(url || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const destination = getSalesDestination(path === '/sales' ? 'dashboard'
    : path.startsWith('/sales/') ? path.slice('/sales/'.length) : '');
  if (!destination) return null;
  return isExcluded(SALES_BASE_PERMISSION) ? SALES_BASE_PERMISSION : destination.permissionId;
}

export const SALES_CATALOGUE_SECTIONS = Object.freeze({
  catalogue: 'categories',
  products: 'products',
  bundles: 'bundles',
});

export function getVisibleSalesDestinations(isExcluded) {
  if (isExcluded(SALES_BASE_PERMISSION)) return [];
  return SALES_DESTINATIONS.filter(({ permissionId }) => !isExcluded(permissionId));
}

export function getSalesDestination(key) {
  return SALES_DESTINATIONS.find((destination) => destination.key === key) || null;
}

export function getSalesCatalogueSection(destinationKey) {
  return SALES_CATALOGUE_SECTIONS[destinationKey] || null;
}

export function getSalesCataloguePath(section) {
  const destinationKey = Object.entries(SALES_CATALOGUE_SECTIONS)
    .find(([, mappedSection]) => mappedSection === section)?.[0];
  return destinationKey ? `/sales/${destinationKey}` : null;
}