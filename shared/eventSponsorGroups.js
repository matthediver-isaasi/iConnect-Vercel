// Public presentation depends only on the category on this event's assignment.
// Sponsor-level category_id is retained in storage solely for rollout history.
export function resolveEventSponsorCategoryIds(ids, categories) {
  const aliases = new Map(categories.filter(c => c.legacy_category_id).map(c => [String(c.legacy_category_id), String(c.id)]));
  return (Array.isArray(ids) ? ids : []).map(id => aliases.get(String(id)) || String(id));
}

export function groupEventSponsors(sponsors = [], assignments = [], categories = [], categoryOrder = []) {
  const sponsorMap = new Map(sponsors.map(s => [s.id, s]));
  const categoryMap = new Map(categories.map(c => [c.id, c]));
  const buckets = new Map();
  for (const assignment of assignments) {
    const sponsor = sponsorMap.get(assignment.sponsor_id);
    if (!sponsor) continue;
    const key = categoryMap.has(assignment.category_id) ? assignment.category_id : '__none__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(sponsor);
  }
  const order = new Map(categoryOrder.map((id, i) => [id, i]));
  const result = [...buckets].filter(([id]) => id !== '__none__').map(([id, list]) => {
    const category = categoryMap.get(id);
    return { id, name: category.name, order: category.display_order ?? 0,
      sort: order.get(id) ?? order.get(category.legacy_category_id) ?? Infinity,
      sponsors: list.sort((a, b) => (a.name || '').localeCompare(b.name || '')) };
  }).sort((a, b) => (a.sort - b.sort) || (a.order - b.order) || a.name.localeCompare(b.name));
  if (buckets.has('__none__')) result.push({ id: '__none__', name: result.length ? 'Other Sponsors' : '',
    order: 9999, sponsors: buckets.get('__none__').sort((a, b) => (a.name || '').localeCompare(b.name || '')) });
  return result;
}
