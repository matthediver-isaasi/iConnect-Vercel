// Subcategory keys are editor state, never derived from a possibly failed catalogue.
export function sessionCategoryIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(id => typeof id === "string" && id))];
}

export function activeSessionCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter(category => category && category.is_active !== false && typeof category.id === "string"
      && category.category_id && typeof category.category_name === "string"
      && typeof category.name === "string" && category.name.trim())
    .slice()
    .sort((a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0));
}

export function groupSessionCategories(categories) {
  const groups = new Map();
  for (const category of activeSessionCategories(categories)) {
    if (!groups.has(category.category_id)) {
      groups.set(category.category_id, { id: category.category_id, name: category.category_name, children: [] });
    }
    groups.get(category.category_id).children.push(category);
  }
  return [...groups.values()];
}

export function resolveSessionCategories(ids, catalogue, { unavailable = true, settled = true } = {}) {
  const byId = new Map(activeSessionCategories(catalogue).map(category => [category.id, category]));
  return sessionCategoryIds(ids).flatMap(id => {
    const category = byId.get(id);
    if (category) return [{ id, name: category.name, category_name: category.category_name }];
    return unavailable ? [{ id, name: settled ? "Unavailable subcategory" : "Saved subcategory", unavailable: true }] : [];
  });
}
