/**
 * Reload only creation reservations whose entity now exists in the same
 * tenant. Reservations are written before inserts, so a crashed pre-insert
 * attempt may leave an orphan which must never grant mutation authority.
 */
export async function loadPersistedFormEntityCreations({
  db,
  tenantId,
  submissionId,
}) {
  const { data: reservations, error } = await db
    .from('form_submission_entity_creation')
    .select('entity_type, entity_id')
    .eq('tenant_id', tenantId)
    .eq('form_submission_id', submissionId);
  if (error) throw error;

  const result = { member: new Set(), organization: new Set() };
  for (const entity of ['member', 'organization']) {
    const ids = [...new Set((reservations || [])
      .filter(row => row.entity_type === entity)
      .map(row => String(row.entity_id))
      .filter(Boolean))];
    if (ids.length === 0) continue;
    const { data: rows, error: entityError } = await db
      .from(entity)
      .select('id')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (entityError) throw entityError;
    for (const row of rows || []) result[entity].add(String(row.id));
    if (result[entity].size > 1) {
      const conflict = new Error(`Submission has multiple created ${entity} records`);
      conflict.code = 'FORM_ENTITY_CREATION_PROVENANCE_CONFLICT';
      throw conflict;
    }
  }
  return result;
}

export function singlePersistedCreationId(creations, entity) {
  return [...(creations?.[entity] || [])][0] || null;
}