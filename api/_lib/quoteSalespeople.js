import { validateCollaborator } from './opportunityCollaborators.js';
import { SalesHttpError } from './salesAccess.js';

const emptyAccess = { collaborators: [], opportunity: {} };
async function salesError(run) {
  try { return await run(); }
  catch (error) {
    if (error.status) throw new SalesHttpError(error.status, error.message);
    throw error;
  }
}

export async function quoteSalespersonOptions(db, tenantId, offset = '0', opportunityId) {
  if (!/^\d+$/.test(String(offset)) || !Number.isSafeInteger(Number(offset))) {
    throw new SalesHttpError(400, 'Invalid salesperson offset');
  }
  if (!opportunityId) return { items: [], nextOffset: null };
  const { data: opportunity, error: opportunityError } = await db.from('opportunity')
    .select('id').eq('tenant_id', tenantId).eq('id', opportunityId).maybeSingle();
  if (opportunityError) throw opportunityError;
  if (!opportunity) throw new SalesHttpError(404, 'Opportunity not found');
  const start = Number(offset);
  const { data: collaborators, error } = await db.from('opportunity_collaborator')
    .select('principal_id').eq('tenant_id', tenantId).eq('opportunity_id', opportunityId)
    .eq('principal_kind', 'member').order('principal_id').range(start, start + 99);
  if (error) throw error;
  const ids = (collaborators || []).map(row => row.principal_id);
  if (!ids.length) return { items: [], nextOffset: null };
  const { data: primary, error: primaryError } = await db.from('organization')
    .select('id').eq('tenant_id', tenantId).eq('is_primary', true).maybeSingle();
  if (primaryError) throw primaryError;
  if (!primary) throw new SalesHttpError(409, 'Set the tenant’s primary organisation before selecting a salesperson');
  const { data: items, error: memberError } = await db.from('member')
    .select('id,first_name,last_name,email').eq('tenant_id', tenantId).in('id', ids)
    .eq('organization_id', primary.id)
    .or('email.is.null,email.not.ilike.deleted_%@deleted.local')
    .order('last_name').order('first_name').order('id');
  if (memberError) throw memberError;
  return { items: items || [], nextOffset: ids.length === 100 ? start + 100 : null };
}

export async function quoteSalespersonSnapshot(db, tenantId, actor, draft, previous) {
  const id = draft.salespersonId !== undefined ? draft.salespersonId : draft.salesperson?.id;
  // Only a persisted snapshot loaded under this tenant can preserve an old
  // selection. Never accept a snapshot supplied by the browser.
  if (previous && (id === undefined || id === previous.id)) return previous;
  if (id === null || id === '') return null;
  if (!id) return null;
  if (!draft.opportunityId) throw new SalesHttpError(400, 'Choose an opportunity before selecting a salesperson');
  const { data: collaborator, error: collaboratorError } = await db.from('opportunity_collaborator')
    .select('principal_id').eq('tenant_id', tenantId).eq('opportunity_id', draft.opportunityId)
    .eq('principal_kind', 'member').eq('principal_id', id).maybeSingle();
  if (collaboratorError) throw collaboratorError;
  if (!collaborator) throw new SalesHttpError(400, 'Salesperson must be a collaborator on this proposal’s opportunity');
  await salesError(() => validateCollaborator(db, tenantId, emptyAccess, { kind: 'member', id }));
  const { data, error } = await db.from('member').select('id,first_name,last_name,email')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SalesHttpError(400, 'Salesperson was not found in this tenant');
  return data;
}
