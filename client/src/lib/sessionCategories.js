// Assignment IDs are editor state, never derived from a possibly failed catalogue.
export function sessionCategoryIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(id => typeof id === "string" && id))];
}

export function activeSessionCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter(category => category.is_active !== false)
    .slice()
    .sort((a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0));
}

export function resolveSessionCategories(ids, catalogue, { unavailable = true, settled = true } = {}) {
  const byId = new Map(activeSessionCategories(catalogue).map(category => [category.id, category]));
  return sessionCategoryIds(ids).flatMap(id => {
    const category = byId.get(id);
    if (category) return [{ id, name: category.name }];
    return unavailable ? [{ id, name: settled ? "Unavailable category" : "Saved category", unavailable: true }] : [];
  });
}
