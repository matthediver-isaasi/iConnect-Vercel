import { collaboratorOptions, validateCollaborator } from './opportunityCollaborators.js';
import { SalesHttpError } from './salesAccess.js';

const emptyAccess = { collaborators: [], opportunity: {} };
async function salesError(run) {
  try { return await run(); }
  catch (error) {
    if (error.status) throw new SalesHttpError(error.status, error.message);
    throw error;
  }
}

export const quoteSalespersonOptions = (db, tenantId, offset) =>
  salesError(() => collaboratorOptions(db, tenantId, emptyAccess, offset));

export async function quoteSalespersonSnapshot(db, tenantId, actor, draft, previous) {
  const id = draft.salespersonId !== undefined ? draft.salespersonId : draft.salesperson?.id;
  // Only a persisted snapshot loaded under this tenant can preserve an old
  // selection. Never accept a snapshot supplied by the browser.
  if (previous && (id === undefined || id === previous.id)) return previous;
  if (id === null || id === '') return null;
  if (!id) return { id: actor.actorId, type: actor.actorType };
  await salesError(() => validateCollaborator(db, tenantId, emptyAccess, { kind: 'member', id }));
  const { data, error } = await db.from('member').select('id,first_name,last_name,email')
    .eq('tenant_id', tenantId).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new SalesHttpError(400, 'Salesperson was not found in this tenant');
  return data;
}
