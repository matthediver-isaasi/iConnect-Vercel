/**
 * AI Composition version retention — pure decision logic (Task #2849).
 *
 * Mirrors the canvas_page_version rules (keep the newest MAX_KEEP unlocked
 * snapshots, locked versions sit outside the pot) with one extra guarantee
 * from the Phase 0 design (§8): the CURRENT version is never pruned, even if
 * it has aged out of the rolling window — "never overwrite the only valid
 * version".
 */

export const MAX_KEEP = 10;
export const MAX_LOCKED = 3;

/**
 * @param {Array<{id: string, created_at: string, locked?: boolean}>} versions
 *   All versions of one composition (any order).
 * @param {string|null} currentVersionId
 * @returns {string[]} ids to delete
 */
export function selectVersionsToPrune(versions, currentVersionId, maxKeep = MAX_KEEP) {
  const unlocked = (versions || [])
    .filter((v) => v && !v.locked)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return unlocked
    .slice(maxKeep)
    .filter((v) => v.id !== currentVersionId)
    .map((v) => v.id);
}

/**
 * Build the row for a restore: restore = insert a NEW version whose document
 * copies the restored one; the restored version's id becomes the parent so
 * the chain is preserved. The source version itself is never mutated.
 */
export function buildRestoreVersion(sourceVersion, { tenantId, compositionId, createdBy }) {
  if (!sourceVersion || typeof sourceVersion !== 'object' || !sourceVersion.document) {
    throw new Error('Cannot restore: source version has no document');
  }
  return {
    composition_id: compositionId,
    tenant_id: tenantId,
    parent_version_id: sourceVersion.id,
    document: sourceVersion.document,
    change_summary: `Restored version from ${sourceVersion.created_at || 'earlier'}`,
    operation_type: 'restore',
    validation_result: { ok: true, restoredFrom: sourceVersion.id },
    generation_metadata: sourceVersion.generation_metadata || null,
    created_by: createdBy || null,
  };
}
