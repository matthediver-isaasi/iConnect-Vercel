import { normalizeFormPrefillOrganizationId } from '../../shared/formNotListedChoice.js';

// Only call after the public form's existing relationship/access gates. This
// validates ownership, not permission to bypass those gates or mutate an org.
export async function resolveFormPaymentOrganization(db, tenantId, value) {
  const id = normalizeFormPrefillOrganizationId(value);
  if (!id) return null;
  if (typeof id !== 'string') throw new Error('Invalid organisation reference');
  const { data, error } = await db.from('organization').select('id')
    .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (error || !data) throw new Error('Organisation not found or does not belong to this tenant');
  return data.id;
}