// Same-origin JSON client for the event funnel administration endpoint.
export async function eventFunnelRequest(body) {
  const response = await fetch('/api/event-funnels', {
    credentials: 'include',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Event funnels could not be loaded.');
  return result;
}

export const eventFunnelSetupUrl = definitionId => `/EventFunnels?funnel=${encodeURIComponent(definitionId)}`;

export const sortByName = items => [...items].sort((a, b) =>
  String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base', numeric: true }));

// Funnels and groups shown on an event's Funnel tab, alphabetically, filtered
// by a case-insensitive type-ahead query over names (and group names).
export function eventFunnelChoices({ definitions = [], groups = [], groupMembers = [] }, query = '') {
  const needle = query.trim().toLowerCase();
  const groupOf = new Map(groupMembers.map(row => [row.definition_id, row.collection_id]));
  const groupName = new Map(groups.map(group => [group.id, group.name]));
  const matches = (...values) => !needle || values.some(value => String(value || '').toLowerCase().includes(needle));
  return {
    groups: sortByName(groups).filter(group => matches(group.name))
      .map(group => ({ ...group, funnelCount: groupMembers.filter(row => row.collection_id === group.id).length })),
    funnels: sortByName(definitions).map(definition => ({ ...definition, groupName: groupName.get(groupOf.get(definition.id)) || null }))
      .filter(definition => matches(definition.name, definition.groupName)),
  };
}

export const funnelSourceEvent = definition =>
  definition?.graph?.nodes?.find(node => node.id === definition.graph.entry)?.event || null;
