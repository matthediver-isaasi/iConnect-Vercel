import { resolveCustomObjectDisplayValue } from './customObjectDomain.js';

export async function allAffiliationRows(makeQuery, limit = 10000) {
  const rows = [];
  for (let offset = 0; offset <= limit; offset += 500) {
    const { data, error, count } = await makeQuery().order('id').range(offset, offset + 499);
    if (error || !Array.isArray(data) || !Number.isInteger(count)) {
      throw new Error('Complete affiliation choices could not be loaded.');
    }
    rows.push(...data);
    if (rows.length > limit || count > limit) throw new Error('There are too many affiliation choices to safely review.');
    if (rows.length === count) return rows;
    if (!data.length || rows.length > count) throw new Error('Affiliation choices changed while loading. Reload the review.');
  }
  throw new Error('Affiliation choices are incomplete.');
}

export function originalAffiliationProposal(snapshot) {
  const { graph, config, member_id: memberId } = snapshot;
  if (!graph || !Array.isArray(graph.links) || !Array.isArray(graph.recordLinks)) {
    throw new Error('Original affiliations could not be verified.');
  }
  const opposite = edge => edge.source_record_id === memberId ? edge.target_record_id : edge.source_record_id;
  const departments = graph.links.filter(e => e.relationship_definition_id === config.memberDepartmentDefinitionId).map(opposite);
  const assignments = new Set(graph.links.filter(e => e.relationship_definition_id === config.secondaryMemberDefinitionId).map(opposite));
  const secondary = graph.recordLinks.filter(e => e.relationship_definition_id === config.secondaryOrganizationDefinitionId)
    .flatMap(e => assignments.has(e.source_record_id) ? [e.target_record_id]
      : assignments.has(e.target_record_id) ? [e.source_record_id] : []);
  return { primary: graph.organization_id ?? null, departments: [...new Set(departments)], secondary: [...new Set(secondary)] };
}

export async function loadAffiliationReview({ db, tenantId, submissionId }) {
  const { data: review, error } = await db.from('form_member_affiliation_review').select('*')
    .eq('tenant_id', tenantId).eq('due_diligence_submission_id', submissionId).maybeSingle();
  if (error) throw new Error('Affiliation review could not be loaded.');
  if (!review) return { active: false };
  const { data: snapshot, error: snapshotError } = await db.from('form_member_affiliation_snapshot')
    .select('config,graph,member_id').eq('id', review.snapshot_id).eq('tenant_id', tenantId).single();
  if (snapshotError || !snapshot || snapshot.member_id !== review.member_id) throw new Error('Original affiliation request could not be verified.');
  const organizations = await allAffiliationRows(() => db.from('organization').select('id,name', { count: 'exact' }).eq('tenant_id', tenantId));
  const departments = [];
  const cfg = snapshot.config;
  if (cfg.memberDepartmentDefinitionId) {
    const { data: definition, error: definitionError } = await db.from('custom_object_relationship_definition')
      .select('*').eq('id', cfg.memberDepartmentDefinitionId).eq('tenant_id', tenantId).eq('status', 'active').single();
    if (definitionError || !definition) throw new Error('Department relationships are unavailable.');
    const objectId = definition.source_kind === 'member' ? definition.target_custom_object_id
      : definition.target_kind === 'member' ? definition.source_custom_object_id : null;
    if (!objectId || !cfg.departmentOrganizationDefinitionId) throw new Error('Department eligibility configuration is incomplete.');
    const [{ data: object, error: objectError }, fields, records, edges] = await Promise.all([
      db.from('custom_object_definition').select('*').eq('tenant_id', tenantId).eq('id', objectId).single(),
      allAffiliationRows(() => db.from('preference_field').select('*', { count: 'exact' }).eq('tenant_id', tenantId).eq('custom_object_id', objectId)),
      allAffiliationRows(() => db.from('custom_object_record').select('*', { count: 'exact' }).eq('tenant_id', tenantId).eq('custom_object_id', objectId).is('archived_at', null)),
      allAffiliationRows(() => db.from('custom_object_relationship').select('id,source_record_id,target_record_id', { count: 'exact' })
        .eq('tenant_id', tenantId).eq('relationship_definition_id', cfg.departmentOrganizationDefinitionId).is('archived_at', null)),
    ]);
    if (objectError || !object) throw new Error('Department definitions are unavailable.');
    const orgIds = new Set(organizations.map(o => o.id));
    for (const record of records) {
      const organizationIds = [...new Set(edges.flatMap(e => e.source_record_id === record.id && orgIds.has(e.target_record_id)
        ? [e.target_record_id] : e.target_record_id === record.id && orgIds.has(e.source_record_id) ? [e.source_record_id] : []))];
      if (organizationIds.length) departments.push({
        id: record.id, label: resolveCustomObjectDisplayValue({ objectDefinition: object, record, fields }), organizationIds,
      });
    }
  }
  return {
    active: true,
    review: { id: review.id, status: review.status, version: review.resolution_version,
      details: review.details, resolution: review.resolution,
      proposal: review.proposed_resolution || originalAffiliationProposal(snapshot) },
    options: { complete: true, organizations: organizations.map(o => ({ id: o.id, label: o.name || 'Unnamed organisation' })), departments },
  };
}
