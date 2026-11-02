import { createHash } from 'node:crypto';

/**
 * Pure, server-side planning for opt-in current-set form relationships.
 * Not a write endpoint or authorization mechanism. Inputs must come from
 * authoritative scoped reads and server-resolved visibility/eligibility.
 *
 * An executor must lock and re-read this snapshot, validate authority again,
 * and apply the whole plan with organisation/affiliation changes atomically.
 * Never execute a plan supplied by a browser.
 */
export class RelationshipCurrentSetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelationshipCurrentSetError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RelationshipCurrentSetError(code, message);
}

function identifier(value) {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function uniqueIds(values, label) {
  if (!Array.isArray(values) || values.some(value => !identifier(value))
    || new Set(values).size !== values.length) {
    fail('invalid_input', `${label} must contain unique record IDs.`);
  }
  return [...values].sort();
}

// Canonicalise object keys as well as row order. The snapshot includes edge
// metadata and affiliation context, so concurrent edits cannot go unnoticed.
function canonical(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.complete !== true || !identifier(snapshot.tenantId)
    || !identifier(snapshot.memberId) || !identifier(snapshot.contextVersion)) {
    fail('incomplete_snapshot', 'A complete member relationship and affiliation snapshot is required.');
  }
  if (!Array.isArray(snapshot.sets)) fail('invalid_input', 'Relationship sets are required.');
  const definitions = new Set();
  const sets = new Set();
  const edges = new Set();
  for (const set of snapshot.sets) {
    if (!identifier(set.id) || sets.has(set.id)
      || !identifier(set.definitionId) || definitions.has(set.definitionId)
      || !['source', 'target'].includes(set.ownerSide) || set.complete !== true
      || !Array.isArray(set.edges)) {
      fail('invalid_scope', 'Each relationship definition needs one complete, non-overlapping member set.');
    }
    sets.add(set.id);
    definitions.add(set.definitionId);
    const targetIds = new Set();
    for (const edge of set.edges) {
      if (!identifier(edge.id) || edges.has(edge.id) || !identifier(edge.relatedId)
        || targetIds.has(edge.relatedId) || edge.tenantId !== snapshot.tenantId
        || edge.memberId !== snapshot.memberId || edge.definitionId !== set.definitionId
        || edge.ownerSide !== set.ownerSide || edge.archivedAt != null
        || !identifier(edge.version)) {
        fail('invalid_scope', 'Relationship snapshot contains duplicate, inactive or out-of-scope links.');
      }
      edges.add(edge.id);
      targetIds.add(edge.relatedId);
    }
  }
}

export function relationshipCurrentSetVersion(snapshot) {
  validateSnapshot(snapshot);
  const normalized = {
    tenantId: snapshot.tenantId,
    memberId: snapshot.memberId,
    contextVersion: snapshot.contextVersion,
    sets: snapshot.sets.map(set => ({
      id: set.id,
      definitionId: set.definitionId,
      ownerSide: set.ownerSide,
      edges: [...set.edges].sort((a, b) => a.id.localeCompare(b.id)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex');
}

/**
 * selections: [{setId, state:'replace'|'unanswered'|'hidden', relatedIds:[]}]
 * Only explicit, visible replacement can remove links. Missing sets are kept.
 * eligibility: complete post-change target IDs, resolved against the proposed
 * primary AND retained secondary affiliations (not just the primary org).
 */
export function planRelationshipCurrentSet({
  snapshot, expectedVersion, actor, selections = [], eligibility = [],
}) {
  validateSnapshot(snapshot);
  if (actor?.authenticated !== true || actor.tenantId !== snapshot.tenantId
    || actor.memberId !== snapshot.memberId) {
    fail('forbidden', 'Only the authenticated member can replace their own form relationships.');
  }
  const version = relationshipCurrentSetVersion(snapshot);
  if (expectedVersion !== version) {
    fail('stale_snapshot', 'Your affiliations changed since this form was loaded. Reload before saving.');
  }
  if (!Array.isArray(selections) || !Array.isArray(eligibility)) fail('invalid_input', 'Invalid relationship choices.');
  const bySet = new Map();
  for (const selection of selections) {
    if (!snapshot.sets.some(set => set.id === selection?.setId) || bySet.has(selection.setId)
      || !['replace', 'unanswered', 'hidden'].includes(selection.state)) {
      fail('invalid_input', 'Relationship choices contain an unknown, duplicate or invalid set.');
    }
    bySet.set(selection.setId, selection);
  }
  const allowed = new Map();
  for (const item of eligibility) {
    if (!snapshot.sets.some(set => set.id === item?.setId) || allowed.has(item.setId)
      || item.complete !== true) {
      fail('incomplete_eligibility', 'Complete post-change relationship eligibility is required.');
    }
    allowed.set(item.setId, new Set(uniqueIds(item.relatedIds, 'Eligible relationships')));
  }
  const result = { version, tenantId: snapshot.tenantId, memberId: snapshot.memberId, sets: [], changed: false };
  for (const set of snapshot.sets) {
    const selection = bySet.get(set.id);
    const replacing = selection?.state === 'replace';
    const desired = replacing
      ? uniqueIds(selection.relatedIds, 'Selected relationships')
      : set.edges.map(edge => edge.relatedId).sort();
    const eligible = allowed.get(set.id);
    if (!eligible) fail('incomplete_eligibility', 'Eligibility must cover every managed relationship set.');
    // Never quietly drop invalid old links after an organisation switch. The
    // member must explicitly review that set, including an intentional clear.
    if (desired.some(id => !eligible.has(id))) {
      fail(replacing ? 'ineligible_selection' : 'review_required',
        'Review the selected relationships for the proposed organisations before saving.');
    }
    const desiredSet = new Set(desired);
    const existing = new Set(set.edges.map(edge => edge.relatedId));
    const retain = set.edges.filter(edge => desiredSet.has(edge.relatedId)).map(edge => edge.id).sort();
    const archive = set.edges.filter(edge => !desiredSet.has(edge.relatedId)).map(edge => edge.id).sort();
    const add = desired.filter(id => !existing.has(id));
    result.sets.push({ setId: set.id, definitionId: set.definitionId, ownerSide: set.ownerSide, retain, archive, add });
    if (archive.length || add.length) result.changed = true;
  }
  return result;
}
