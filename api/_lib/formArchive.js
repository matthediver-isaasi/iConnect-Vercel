// Archive/restore is deliberately separate from editing form mappings: old
// configurations must remain available to render their historical submissions.
export async function updateFormArchive({ db, context, id, body, hasAdminAccess }) {
  if (!context.isAuthenticated) return { status: 401, body: { error: 'Authentication required' } };
  if (!context.tenantId || !(await hasAdminAccess(context))) {
    return { status: 403, body: { error: 'Tenant admin access required' } };
  }
  const { data: existing, error: readError } = await db.from('form')
    .select('form_type').eq('id', id).eq('tenant_id', context.tenantId).maybeSingle();
  if (readError) return { status: 503, body: { error: 'Could not verify form lifecycle' } };
  if (existing?.form_type === 'survey') return { status: 409, body: { error: 'Use survey lifecycle management to review the impact before archiving or restoring.' } };
  if (Object.keys(body).some(key => key !== 'archived_at')
    || (body.archived_at !== null && !Number.isFinite(Date.parse(body.archived_at)))) {
    return { status: 400, body: { error: 'Send only archived_at to archive or restore a form' } };
  }
  const { data, error } = await db.from('form')
    .update({ archived_at: body.archived_at === null ? null : new Date().toISOString(), is_active: false })
    .eq('id', id).eq('tenant_id', context.tenantId).select('*').maybeSingle();
  if (error) return { status: 500, body: { error: error.message } };
  if (!data) return { status: 404, body: { error: 'Form not found' } };
  return { status: 200, body: data };
}