import { buildFilterTagKeyMap, normalizeFilterTags } from './utils.js';

export const ALL_EVENT_CATEGORIES = '__all_event_categories__';

// Use the same public definitions in the inspector and renderer. A category
// name is a grouping label; only its subcategory values are event filter tags.
export function getCanvasEventCategories(definitions) {
  return (Array.isArray(definitions) ? definitions : [])
    .filter((category) => category?.is_active &&
      typeof category.id === 'string' && category.id &&
      Array.isArray(category.applies_to_content_types) &&
      category.applies_to_content_types.includes('Events') &&
      Array.isArray(category.subcategories))
    .map((category) => ({
      ...category,
      subcategories: category.subcategories.filter((value) => typeof value === 'string' && value.trim()),
    }))
    .filter((category) => category.subcategories.length > 0);
}

export function getCanvasEventCategoryOptions(categories) {
  return [
    { value: ALL_EVENT_CATEGORIES, label: 'All categories' },
    ...Array.from(buildFilterTagKeyMap(categories), ([value, info]) => ({
      value,
      label: `${info.categoryName} — ${info.subcategory}`,
    })),
  ];
}

export function resolveCanvasEventCategory(selection, categories) {
  if (typeof selection !== 'string' || !selection) return '';
  const [key] = normalizeFilterTags([selection], categories);
  return buildFilterTagKeyMap(categories).has(key) ? key : '';
}

export function matchesCanvasEventCategory(event, selectedCategory, categories) {
  if (!selectedCategory) return true;
  const tags = Array.isArray(event.filter_tags)
    ? event.filter_tags.filter((tag) => typeof tag === 'string')
    : [];
  return normalizeFilterTags(tags, categories).includes(selectedCategory);
}