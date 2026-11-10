export async function readJoiningJourney(db, tenantId) {
  const { data, error } = await db.from('membership_joining_journey')
    .select('form_id,revision').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data || { form_id: null, revision: 0 };
}

// This is a self-service navigation hint, not purchase/activation authority.
// An absent history alone cannot establish eligibility: in-flight checkouts
// can exist before a history row. All reads must succeed, even for guests.
export async function loadJoiningJourney(db, { tenantId, owner }) {
  const hidden = { eligible: false };
  if (!owner?.id || owner.tenant_id !== tenantId || owner.membership_paused || owner.membership_cancelled) return hidden;
  try {
    const settings = await readJoiningJourney(db, tenantId);
    if (!settings.form_id) return hidden;
    const { data: form, error } = await db.from('form')
      .select('id,tenant_id,slug,is_active,form_type,archived_at,deactivate_at').eq('tenant_id', tenantId).eq('id', settings.form_id).maybeSingle();
    if (error || !form || form.tenant_id !== tenantId || !form.slug || !form.is_active
      || form.archived_at || (form.deactivate_at && (!Number.isFinite(Date.parse(form.deactivate_at)) || Date.parse(form.deactivate_at) <= Date.now()))
      || ![null,undefined,'standard'].includes(form.form_type)) return hidden;
    const checks = [
      ['member_membership_history','member_id',owner.id,'cancelled_for_switch_at'],
      ['membership_billing_agreements','member_id',owner.id,'cancelled_for_switch_at'],
      ['membership_payment_quote','member_id',owner.id,'cancelled_for_switch_at'],
      ['membership_payment_plans','member_id',owner.id],
      ['form_joining_voucher_checkout','member_id',owner.id,'released_at'],
    ];
    if (owner.organization_id) checks.push(['organisation_membership_history','organization_id',owner.organization_id]);
    const evidence = await Promise.all(checks.map(([table, column, id, retiredColumn]) => {
      let query = db.from(table).select(table === 'form_joining_voucher_checkout' ? 'fee_token_id' : 'id')
        .eq('tenant_id', tenantId).eq(column, id);
      if (retiredColumn) query = query.is(retiredColumn, null);
      return query.limit(1);
    }));
    if (evidence.some(result => result.error || !Array.isArray(result.data) || result.data.length)) return hidden;
    // An expired token is not proof of cancellation. Only an explicitly
    // released first-membership voucher checkout can retire that evidence.
    for (let start = 0; ; start += 100) {
      const tokens = await db.from('membership_fee_token').select('id,status')
        .eq('tenant_id', tenantId).eq('member_id', owner.id).in('status',['pending','paid','expired'])
        .order('id').range(start,start+99);
      if (tokens.error || !Array.isArray(tokens.data)) return hidden;
      for (const token of tokens.data) {
        if (token.status !== 'expired') return hidden;
        const released = await db.from('form_joining_voucher_checkout').select('fee_token_id,released_at')
          .eq('tenant_id',tenantId).eq('member_id',owner.id).eq('fee_token_id',token.id).maybeSingle();
        if (released.error || !released.data?.released_at) return hidden;
      }
      if (tokens.data.length < 100) break;
    }
    return { eligible: true, entryHref: `/FormView?slug=${encodeURIComponent(form.slug)}` };
  } catch { return hidden; }
}
