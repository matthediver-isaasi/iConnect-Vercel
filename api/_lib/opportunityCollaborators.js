import { OpportunityHttpError } from './opportunityRules.js';

// A customer or an arbitrary first organisation must never become the team.
async function primaryOrganisation(db, tenantId) {
  const { data, error } = await db.from('organization').select('id')
    .eq('tenant_id', tenantId).eq('is_primary', true).maybeSingle();
  if (error) throw error;
  if (!data) throw new OpportunityHttpError(409, 'Set the tenant’s primary organisation before adding collaborators');
  return data.id;
}

function members(db, tenantId, organisationId) {
  return db.from('member').select('id,first_name,last_name,email,organization_id')
    .eq('tenant_id', tenantId).eq('organization_id', organisationId)
    .or('email.is.null,email.not.ilike.deleted_%@deleted.local');
}

export async function collaboratorOptions(db, tenantId, access, offset = '0') {
  if (!/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset))) {
    throw new OpportunityHttpError(400, 'Invalid collaborator offset');
  }
  const organisationId = await primaryOrganisation(db, tenantId);
  const start = Number(offset);
  const { data, error } = await members(db, tenantId, organisationId)
    .order('last_name').order('first_name').order('id').range(start, start + 99);
  if (error) throw error;
  const excluded = new Set(access.collaborators.filter(row => row.principal_kind === 'member').map(row => row.principal_id));
  if (access.opportunity.owner_kind === 'member') excluded.add(access.opportunity.owner_id);
  return {
    items: (data || []).filter(row => !excluded.has(row.id)).map(({ organization_id, ...row }) => row),
    nextOffset: data?.length === 100 ? start + 100 : null,
  };
}

export async function validateCollaborator(db, tenantId, access, principal) {
  if (principal?.kind !== 'member' || !principal.id) {
    throw new OpportunityHttpError(400, 'Choose a member of the tenant’s primary organisation');
  }
  const organisationId = await primaryOrganisation(db, tenantId);
  const { data, error } = await members(db, tenantId, organisationId).eq('id', principal.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new OpportunityHttpError(400, 'Collaborator must belong to the tenant’s primary organisation');
  if ((access.opportunity.owner_kind === 'member' && access.opportunity.owner_id === principal.id)
    || access.collaborators.some(row => row.principal_kind === 'member' && row.principal_id === principal.id)) {
    throw new OpportunityHttpError(409, 'This member is already an owner or collaborator');
  }
}
