export async function deleteOrDeactivateBadge(supabase, { id, tenantId }) {
  if (!tenantId) {
    return { ok: false, status: 403, error: 'Valid tenant context required' };
  }

  const { data: deleted, error: deleteError } = await supabase
    .from('badge')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select();

  if (!deleteError) {
    if (!deleted?.length) {
      return { ok: false, status: 404, error: 'Badge not found' };
    }
    return { ok: true, outcome: 'deleted' };
  }

  if (deleteError.code !== '23503') {
    return { ok: false, status: 500, error: deleteError.message };
  }

  const { data: deactivated, error: deactivateError } = await supabase
    .from('badge')
    .update({ is_active: false })
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select();

  if (deactivateError) {
    return { ok: false, status: 500, error: deactivateError.message };
  }
  if (!deactivated?.length) {
    return { ok: false, status: 404, error: 'Badge not found' };
  }

  return { ok: true, outcome: 'deactivated', badge: deactivated[0] };
}