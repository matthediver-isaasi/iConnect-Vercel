const SERVER_OWNED_ENTITY_NAMES = new Set([
  'formsubmissionpipelineentity',
]);

export function normalizeGenericEntityName(entity) {
  return String(entity || '').replace(/[-_]/g, '').toLowerCase();
}

export function rejectGenericServerOwnedEntity(entity, res) {
  if (!SERVER_OWNED_ENTITY_NAMES.has(normalizeGenericEntityName(entity))) return false;
  res.status(403).json({
    error: 'This server-owned record is not available through the generic entity API',
  });
  return true;
}