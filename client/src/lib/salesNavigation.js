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