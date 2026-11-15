// Apply after visibility checks. Within a category selections always use OR.
export function matchesResourceSubcategories(resource, selected, categories, mode = 'or') {
  if (!selected.length) return true;
  const tags = new Set(Array.isArray(resource.subcategories) ? resource.subcategories : []);
  if (mode !== 'and') return selected.some(name => tags.has(name));
  const selectedSet = new Set(selected);
  const mapped = new Set();
  const groups = categories.flatMap(category => {
    const names = (category.subcategories || []).filter(name => selectedSet.has(name));
    names.forEach(name => mapped.add(name));
    return names.length ? [names] : [];
  });
  // Preserve legacy saved/URL selections not present in the current taxonomy.
  const unmapped = selected.filter(name => !mapped.has(name));
  if (unmapped.length) groups.push(unmapped);
  return groups.every(names => names.some(name => tags.has(name)));
}
