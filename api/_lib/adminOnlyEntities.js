// Entities whose generic entity-API access (all CRUD) is restricted to tenant
// admins. Client-side editor visibility is NOT an authorization boundary —
// these are enforced server-side in both api/entities/[entity]/index.js and
// api/entities/[entity]/[id].js.
//
// Names are compared after stripping -/_ and lowercasing, so 'EventCostLine',
// 'event_cost_line' and 'eventcostline' all match.
export const ADMIN_ONLY_ENTITIES = [
  'externalwriter',
  'externalwriterdocument',
  // Event budget cost lines hold financial data; only tenant admins may
  // read or modify them (the Budget UI is likewise admin-only).
  'eventcostline',
];

export function isAdminOnlyEntity(entity) {
  const norm = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  return ADMIN_ONLY_ENTITIES.includes(norm);
}
