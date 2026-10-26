// Read the same finalized revision that the reservation trigger pins under the
// plan lock. A stale preview cannot reserve an old scope after application.
export async function resolveMemberDynamicScopeRevision(db, agreement, intendedDate) {
  const terms = agreement.metadata?.dd;
  const { data: operation, error } = await db.from('member_amendment_provider_operation').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('state', 'finalized')
    .eq('prepared->input->agreement->>id', agreement.id)
    .eq('prepared->input->authority->>termKey', terms.commitment.term_key).maybeSingle();
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return null;
    throw new Error('Applied dynamic membership scope could not be read.');
  }
  if (!operation) return null;
  const application = operation.evidence?.application;
  const input = operation.prepared?.input;
  if (operation.tenant_id !== agreement.tenant_id || operation.member_id !== agreement.member_id
    || operation.state !== 'finalized' || input?.agreement?.id !== agreement.id
    || input?.authority?.termKey !== terms.commitment.term_key
    || application?.operationId !== operation.id
    || application.expiresOn !== terms.commitment.membership_renewal_date
    || !application.targetSnapshot?.config
    || application.targetSnapshot.config.tenant_id !== agreement.tenant_id
    || application.targetSnapshot.config.structure_scope_type !== 'member'
    || !/^\d{4}-\d{2}-\d{2}$/.test(application.effectiveDate || '')
    || application.effectiveDate >= application.expiresOn) {
    throw new Error('Applied dynamic membership scope is inconsistent.');
  }
  if (intendedDate < application.effectiveDate || intendedDate >= application.expiresOn) return null;
  return { id: operation.id, ...application.targetSnapshot };
}

export function projectMemberDynamicScope(agreement, revision) {
  if (!revision) return agreement;
  const projected = structuredClone(agreement), terms = projected.metadata.dd;
  terms.field_value = null;
  terms.commitment.commitment_snapshot = {
    ...terms.commitment.commitment_snapshot, config: revision.config,
    pricing: { ...terms.commitment.commitment_snapshot?.pricing, field_value: null, band: revision.band },
  };
  return projected;
}
