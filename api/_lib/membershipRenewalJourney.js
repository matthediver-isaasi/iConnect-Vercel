export const DEFAULT_RENEWAL_JOURNEY = Object.freeze({ mode: 'same_schedule', form_id: null, revision: 0 });

export async function readRenewalJourney(db, tenantId) {
  const { data, error } = await db.from('membership_renewal_journey').select('mode,form_id,revision').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data || { ...DEFAULT_RENEWAL_JOURNEY };
}

export async function applyRenewalJourney(db, tenantId, renewal) {
  // Routing grants no eligibility. Outstanding checkouts and already purchased
  // successors retain the existing server-side suppression.
  if (!renewal?.eligible) return renewal;
  try {
    const setting = await readRenewalJourney(db, tenantId);
    if (setting.mode === 'same_schedule') return renewal;
    if (setting.mode !== 'questionnaire' || !setting.form_id) throw new Error('Invalid renewal journey');
    const { data: form, error } = await db.from('form').select('id,tenant_id,slug,form_type,is_active,require_authentication')
      .eq('tenant_id', tenantId).eq('id', setting.form_id).maybeSingle();
    if (error || !form || form.tenant_id !== tenantId || !form.slug || !form.is_active || !form.require_authentication
      || ![null,undefined,'standard'].includes(form.form_type)) throw new Error('Renewal entry unavailable');
    const { price, priceState, ...rest } = renewal;
    return { ...rest, journeyMode: 'questionnaire', entryHref: `/FormView?slug=${encodeURIComponent(form.slug)}` };
  } catch {
    // Never silently fall back to a previous schedule on a configuration/read error.
    return { ...renewal, eligible: false, journeyUnavailable: true };
  }
}
