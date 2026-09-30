export function formatActorLabel(row, fallback = 'Staff member') {
  if (!row) return fallback;
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name || row.name || row.email || fallback;
}

export async function resolveBadgeActor(supabase, tenantCtx) {
  if (tenantCtx?.tenantUserId) {
    const { data } = await supabase
      .from('tenant_user')
      .select('first_name, last_name, name, email')
      .eq('id', tenantCtx.tenantUserId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    return {
      type: 'tenant_user',
      id: tenantCtx.tenantUserId,
      label: formatActorLabel(data, 'Tenant administrator'),
    };
  }

  if (tenantCtx?.memberId) {
    const { data } = await supabase
      .from('member')
      .select('first_name, last_name, email')
      .eq('id', tenantCtx.memberId)
      .eq('tenant_id', tenantCtx.tenantId)
      .maybeSingle();
    return {
      type: 'member',
      id: tenantCtx.memberId,
      label: formatActorLabel(data),
    };
  }

  return { type: 'system', id: null, label: 'System' };
}

export function awardSourceLabel(assignment) {
  if (assignment?.awarded_by_label) return assignment.awarded_by_label;
  if (assignment?.source === 'speaker_award' || assignment?.created_by === 'system:speaker-awards') {
    return 'Speaker awards automation';
  }
  return assignment?.created_by || 'Legacy award';
}
