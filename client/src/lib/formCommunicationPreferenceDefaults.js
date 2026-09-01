export function initializeCommunicationPreferenceDefaults({
  value,
  categories,
  defaultSelectedCategoryIds,
}) {
  if (value && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)) {
    return null;
  }
  if (!Array.isArray(categories) || categories.length === 0) return null;

  const selected = new Set(
    Array.isArray(defaultSelectedCategoryIds) ? defaultSelectedCategoryIds : [],
  );
  return Object.fromEntries(categories.map(category => [
    category.id,
    selected.has(category.id),
  ]));
}