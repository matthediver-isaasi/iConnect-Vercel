// The legacy JSON column now holds event context; survey selection is optional.
export async function resolveEventEmailContext(db, context, tenantId) {
  if (!tenantId || !context?.event_id || !['event', 'complex_event'].includes(context.event_type)) {
    throw new Error('Event context: select an event in the campaign event settings.');
  }
  const { data, error } = await db.from(context.event_type).select('*')
    .eq('tenant_id', tenantId).eq('id', context.event_id).maybeSingle();
  if (error) throw new Error('Event context: could not validate the selected event. Please retry.');
  if (!data || ['archived', 'deleted', 'inactive'].includes(data.status) || data.is_active === false || data.deleted_at) {
    throw new Error('Event context: the selected event is unavailable.');
  }
  return data;
}