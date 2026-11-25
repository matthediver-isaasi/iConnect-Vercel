/**
 * Private events are active but unlisted. Listing surfaces (/Events, group
 * event lists, search, sitemap) leave them out for everyone except tenant
 * admins; Canvas event widgets and direct links are deliberately unaffected.
 * This is discovery only, never access control.
 */
export const isPrivateEvent = event => event?.is_private === true;

export function filterListedEvents(list, { isAdmin = false } = {}) {
  if (isAdmin) return list || [];
  return (list || []).filter(event => !isPrivateEvent(event));
}
