const BLOCKED_CPD_POINTS_ENTITY_ALIASES = new Set([
  'eventcpdpointsrule',
  'eventcpdpointsrules',
  'membercpdpointsledger',
  'membercpdpointsledgers',
  'eventcpdpointsawardattempt',
  'eventcpdpointsawardattempts',
  'eventcpdpointsfollowup',
  'eventcpdpointsfollowups',
  'eventcpdpointsoutbox',
  'eventcpdpointsoutboxes',
  'eventcpdpointsreplay',
  'eventcpdpointsreplays',
]);

export function normalizeGenericEntityAlias(entity) {
  return String(entity || '').replace(/[-_\s]/g, '').toLowerCase();
}

export function isBlockedCpdPointsEntity(entity) {
  return BLOCKED_CPD_POINTS_ENTITY_ALIASES.has(normalizeGenericEntityAlias(entity));
}

export function rejectGenericCpdPointsEntity(entity, res) {
  if (!isBlockedCpdPointsEntity(entity)) return false;
  res.status(403).json({
    error: 'CPD points records are available only through dedicated service endpoints',
  });
  return true;
}
