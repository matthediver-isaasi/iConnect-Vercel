export const DEFAULT_RENEWAL_JOURNEY = Object.freeze({ mode: 'same_schedule', form_id: null, post_grace_form_id: null, revision: 0 });

export async function readRenewalJourney(db, tenantId) {
  let { data, error } = await db.from('membership_renewal_journey').select('mode,form_id,post_grace_form_id,revision').eq('tenant_id', tenantId).maybeSingle();
  // A rolling deployment may still read the old schema. Only a missing-column
  // response permits the old projection; other failures remain fail-closed.
  if (['42703', 'PGRST204'].includes(error?.code)) {
    ({ data, error } = await db.from('membership_renewal_journey').select('mode,form_id,revision').eq('tenant_id', tenantId).maybeSingle());
    if (data) data = { ...data, post_grace_form_id: null };
  }
  if (error) throw error;
  return data || { ...DEFAULT_RENEWAL_JOURNEY };
}

export async function applyRenewalJourney(db, tenantId, renewal) {
  // Routing grants no eligibility. Outstanding checkouts and already purchased
  // successors retain the existing server-side suppression.
  if (!renewal?.eligible) return renewal;
  try {
    const setting = await readRenewalJourney(db, tenantId);
    const restartForm = renewal.state === 'post_grace_renewal' ? setting.post_grace_form_id : null;
    if (!restartForm && setting.mode === 'same_schedule') return renewal;
    const formId = restartForm || setting.form_id;
    if ((!restartForm && setting.mode !== 'questionnaire') || !formId) throw new Error('Invalid renewal journey');
    const { data: form, error } = await db.from('form').select('id,tenant_id,slug,form_type,is_active,require_authentication,archived_at,deactivate_at')
      .eq('tenant_id', tenantId).eq('id', formId).maybeSingle();
    if (error || !form || form.tenant_id !== tenantId || !form.slug || !form.is_active || !form.require_authentication
      || form.archived_at || (form.deactivate_at && (!Number.isFinite(Date.parse(form.deactivate_at)) || Date.parse(form.deactivate_at) <= Date.now()))
      || ![null,undefined,'standard'].includes(form.form_type)) throw new Error('Renewal entry unavailable');
    const { price, priceState, ...rest } = renewal;
    return { ...rest, journeyMode: 'questionnaire', entryHref: `/FormView?slug=${encodeURIComponent(form.slug)}` };
  } catch {
    // Never silently fall back to a previous schedule on a configuration/read error.
    return { ...renewal, eligible: false, journeyUnavailable: true };
  }
}
