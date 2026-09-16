const SERVER_OWNED_ENTITY_NAMES = new Set([
  'formsubmissionpipelineentity',
  // Due-diligence stage mappings carry action-level target and form/stage
  // ownership invariants. They must only be written through
  // /api/stage-field-mapping-actions, never through the generic entity API
  // (whose table fallback would otherwise expose an unlisted table).
  'stagefieldmappingaction',
]);

const GENERIC_SERVER_OWNED_FIELDS = new Map([
  // This is retry bookkeeping owned by the due-diligence stage-action
  // processor. FormSubmissionDueDiligence itself remains available through
  // the generic entity API; only this server-owned field is protected.
  ['formsubmissionduediligence', new Set(['stage_action_occurrence_id'])],
]);

export function normalizeGenericEntityName(entity) {
  return String(entity || '').replace(/[-_]/g, '').toLowerCase();
}

/**
 * Remove server-owned fields from generic entity mutation payloads.
 *
 * The generic entity API is also used by bulk-shaped callers that submit an
 * array of records, so sanitize each record without mutating the request
 * body. Unknown entities and ordinary DD fields pass through unchanged.
 */
export function stripGenericServerOwnedFields(entity, payload) {
  const protectedFields = GENERIC_SERVER_OWNED_FIELDS.get(normalizeGenericEntityName(entity));
  if (!protectedFields || !payload || typeof payload !== 'object') return payload;

  const stripRecord = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const sanitized = { ...record };
    for (const field of protectedFields) delete sanitized[field];
    // Generic bulk/import callers commonly wrap rows under one of these
    // collection keys. Sanitize those rows too, while leaving unrelated
    // nested JSON values untouched.
    for (const collectionKey of ['rows', 'records', 'items', 'data']) {
      if (Array.isArray(sanitized[collectionKey])) {
        sanitized[collectionKey] = sanitized[collectionKey].map(stripRecord);
      }
    }
    return sanitized;
  };

  return Array.isArray(payload) ? payload.map(stripRecord) : stripRecord(payload);
}

export function rejectGenericServerOwnedEntity(entity, res) {
  if (!SERVER_OWNED_ENTITY_NAMES.has(normalizeGenericEntityName(entity))) return false;
  res.status(403).json({
    error: 'This server-owned record is not available through the generic entity API',
  });
  return true;
}