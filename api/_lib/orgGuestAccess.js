// Shared helper for resolving an organisation's *effective* guest access
// settings, gated by the tenant master switch on
// `system_settings.guest_access`. When the master switch is off, every org
// is treated as "guests off" regardless of stored org settings. When the
// org has guest access on but no per-org override, the tenant's default
// period (or `unlimited`) is inherited.
//
// Returned shape:
//   { enabled: boolean, period_days: number|null, unlimited: boolean }
//
// Used by both `api/public/organisation/[id]/domains.js` (wire response)
// and `api/forms/process-application.js` (server-side guest stamping +
// domain enforcement) so the frontend's friendly bypass message and the
// backend's actual decision can never disagree.

const DISABLED = Object.freeze({ enabled: false, period_days: null, unlimited: false });

export const resolveEffectiveOrgGuestAccess = async (supabaseClient, org) => {
  if (!org || !org.tenant_id) return { ...DISABLED };

  let tenantEnabled = false;
  let tenantPeriodDays = null;
  let tenantUnlimited = false;

  const { data: settingRow } = await supabaseClient
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', org.tenant_id)
    .eq('setting_key', 'guest_access')
    .maybeSingle();

  if (settingRow?.setting_value) {
    try {
      const parsed = JSON.parse(settingRow.setting_value);
      tenantEnabled = !!parsed.enabled;
      tenantUnlimited = parsed.unlimited === true || parsed.default_period_days === null;
      const days = Number(parsed.default_period_days);
      tenantPeriodDays = Number.isFinite(days) && days > 0 ? days : null;
    } catch {
      // ignore parse errors
    }
  }

  if (!tenantEnabled || !org.guest_access_enabled) return { ...DISABLED };

  const orgUnlimited = !!org.guest_access_unlimited;
  const orgDays = Number(org.guest_access_period_days);
  const hasOrgOverride = orgUnlimited || (Number.isFinite(orgDays) && orgDays > 0);

  if (orgUnlimited) {
    return { enabled: true, period_days: null, unlimited: true };
  }
  if (hasOrgOverride) {
    return { enabled: true, period_days: orgDays, unlimited: false };
  }
  // Inherit tenant default
  return {
    enabled: true,
    period_days: tenantUnlimited ? null : tenantPeriodDays,
    unlimited: tenantUnlimited,
  };
};
