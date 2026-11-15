export async function duplicateSponsorCategories(db, tenantId, sourceId, targetId, eventType) {
  const { data, error } = await db.from('event_sponsor_category')
    .select('id,name,display_order').eq('tenant_id', tenantId)
    .eq('event_id', sourceId).eq('event_type', eventType);
  if (error) throw new Error('Could not load sponsor categories for duplication');
  const map = new Map();
  for (const category of data || []) {
    const { data: copy, error: insertError } = await db.from('event_sponsor_category')
      .insert({ tenant_id: tenantId, event_id: targetId, event_type: eventType,
        name: category.name, display_order: category.display_order })
      .select('id').single();
    if (insertError || !copy) throw new Error('Could not duplicate sponsor categories');
    map.set(category.id, copy.id);
  }
  return map;
}
