/**
 * Discovery only, never authorization. Installing this schema is an activation
 * prerequisite; a project with no funnel schema retains its existing lists.
 * Return a wrapper so an async helper cannot assimilate a query builder.
 */
export function isDirectEventLookup(filter) {
  return !!filter && (typeof filter.id==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(filter.id)
    || typeof filter.slug==='string' && filter.slug.trim().length>0 && filter.slug.length<=200);
}
export async function scopeEventFunnelDiscovery({db,query,isAdministrator=false}) {
  if(isAdministrator) return {query};
  const ready=await db.rpc('event_funnel_discovery_ready');
  if(ready.error && ['42883','PGRST202'].includes(ready.error.code)) return {query};
  if(ready.error || ready.data!==true) throw new Error('Event discovery could not be verified');
  return {query:query.eq('event_funnel_discoverable',true)};
}
export async function readEventFunnelDiscovery({db,query}) {
  const scoped=await scopeEventFunnelDiscovery({db,query});
  return await scoped.query;
}
