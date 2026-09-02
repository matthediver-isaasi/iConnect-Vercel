import { supabase as defaultSupabase } from './database.js';

export const DEFAULT_GATE_BLOCKED_MESSAGE =
  'Login is not currently available for your organisation. Please contact your administrator.';

export const MEMBER_PORTAL_GATE_BLOCKED_MESSAGE =
  'Access to the member portal is currently unavailable';

export const RECURRING_PAYMENT_RESTRICTED_MESSAGE =
  'Member portal access is restricted because a recurring membership payment is overdue. Please contact your administrator.';

export const RECURRING_PAYMENT_SUSPENDED_MESSAGE =
  'Member portal access is suspended because recurring membership payments are overdue. Please contact your administrator.';

const ALLOWED_CORE_FIELDS = new Set([
  'is_active',
  'status',
  'country',
]);

function normalizeScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  return String(v);
}

function normalizePreferenceValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return [];
  let val = rawValue;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) { return [val.trim()]; }
  }
  if (Array.isArray(val)) {
    return val.map((entry) => {
      if (entry && typeof entry === 'object' && entry.value !== undefined) return normalizeScalar(entry.value);
      return normalizeScalar(entry);
    }).filter((s) => s !== '');
  }
  if (val && typeof val === 'object') {
    if (val.value !== undefined) return [normalizeScalar(val.value)];
    return [];
  }
  return [normalizeScalar(val)];
}

function valuesMatch(actualList, required) {
  const req = normalizeScalar(required).toLowerCase();
  return actualList.some((a) => normalizeScalar(a).toLowerCase() === req);
}

/**
 * Load the tenant's Organisation Login Gate config from system_settings.
 * Returns { enabled, fieldSource, fieldKey, fieldLabel, requiredValue, blockedMessage } or null.
 */
export async function loadOrganisationLoginGate({ supabase = defaultSupabase, tenantId } = {}) {
  if (!supabase || !tenantId) return null;
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'organization_login_gate')
    .maybeSingle();
  if (!data?.setting_value) return null;
  try {
    const parsed = typeof data.setting_value === 'string'
      ? JSON.parse(data.setting_value)
      : data.setting_value;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * Evaluate the gate for a given (tenant, organization). Returns:
 *   { blocked: boolean, message: string | null, gate: object | null }
 *
 * - When the gate is not enabled/configured → { blocked: false }.
 * - When the organisation is missing → blocked with configured message.
 * - When the configured field's value doesn't match → blocked.
 */
export async function evaluateOrganisationLoginGate({
  supabase = defaultSupabase,
  tenantId,
  organizationId,
} = {}) {
  const gate = await loadOrganisationLoginGate({ supabase, tenantId });
  if (!gate || !gate.enabled) {
    return { blocked: false, message: null, gate };
  }

  const message = (typeof gate.blockedMessage === 'string' && gate.blockedMessage.trim())
    ? gate.blockedMessage
    : DEFAULT_GATE_BLOCKED_MESSAGE;

  if (!gate.fieldKey || !gate.fieldSource) {
    return { blocked: false, message: null, gate };
  }

  if (!organizationId) {
    return { blocked: true, message, gate };
  }

  let actualValues = [];

  if (gate.fieldSource === 'core') {
    if (!ALLOWED_CORE_FIELDS.has(gate.fieldKey)) {
      return { blocked: false, message: null, gate };
    }
    const { data: org } = await supabase
      .from('organization')
      .select(`id, tenant_id, ${gate.fieldKey}`)
      .eq('id', organizationId)
      .maybeSingle();
    if (!org || (tenantId && org.tenant_id && org.tenant_id !== tenantId)) {
      return { blocked: true, message, gate };
    }
    const raw = org[gate.fieldKey];
    actualValues = raw === null || raw === undefined ? [] : [normalizeScalar(raw)];
  } else if (gate.fieldSource === 'custom') {
    const { data: pref } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', organizationId)
      .eq('field_id', gate.fieldKey)
      .maybeSingle();
    if (!pref) {
      actualValues = [];
    } else {
      actualValues = normalizePreferenceValue(pref.value);
    }
  } else {
    return { blocked: false, message: null, gate };
  }

  if (!valuesMatch(actualValues, gate.requiredValue)) {
    return { blocked: true, message, gate };
  }

  return { blocked: false, message: null, gate };
}

/**
 * Evaluate the tenant-wide member portal availability switch.
 *
 * This gate is deliberately limited to member logins. Tenant users and other
 * administrative login types bypass it before any database lookup is made.
 * When disabled, only a member of the tenant's primary organisation may log
 * in. Older tenants without an is_primary marker use their earliest-created
 * organisation as the primary organisation.
 *
 * Availability lookups fail open: an infrastructure or schema error must not
 * lock every member out of a tenant. A successfully resolved disabled gate,
 * however, fails closed for missing or non-primary organisation membership.
 */
export async function evaluateMemberPortalLoginGate({
  supabase = defaultSupabase,
  tenantId,
  userType,
  member,
  organizationId,
} = {}) {
  const allow = (reason) => ({ blocked: false, message: null, reason });
  const block = (reason) => ({
    blocked: true,
    message: MEMBER_PORTAL_GATE_BLOCKED_MESSAGE,
    reason,
  });

  // The switch controls the member portal only. In particular, tenant admins
  // must retain access so that they can turn the portal back on.
  if (userType !== 'member') {
    return allow('USER_TYPE_EXEMPT');
  }

  if (!supabase || !tenantId) {
    return allow('LOOKUP_UNAVAILABLE');
  }

  try {
    // Recurring-payment access policy is evaluated dynamically rather than
    // rewriting member.login_enabled or membership_paused. Recovery therefore
    // restores access immediately without overwriting an administrator's
    // independent login/pause choice. Both member-owned and organisation-owned
    // recurring agreements are tenant-scoped here.
    const arrearsPolicies = ['restrict', 'suspend'];
    const loadArrearsPlan = async (column, value) => {
      if (!value) return null;
      const { data, error } = await supabase
        .from('membership_payment_plans')
        .select('id, arrears_policy_applied, arrears_policy_applied_at')
        .eq('tenant_id', tenantId)
        .eq(column, value)
        .eq('status', 'payment_overdue')
        .in('arrears_policy_applied', arrearsPolicies)
        .order('arrears_policy_applied_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    };

    const [memberArrears, organisationArrears] = await Promise.all([
      loadArrearsPlan('member_id', member?.id),
      loadArrearsPlan('organization_id', organizationId ?? member?.organization_id),
    ]);
    const appliedPolicies = [memberArrears, organisationArrears]
      .map((row) => row?.arrears_policy_applied)
      .filter(Boolean);
    if (appliedPolicies.includes('suspend')) {
      return {
        blocked: true,
        message: RECURRING_PAYMENT_SUSPENDED_MESSAGE,
        reason: 'RECURRING_PAYMENT_SUSPENDED',
      };
    }
    if (appliedPolicies.includes('restrict')) {
      return {
        blocked: true,
        message: RECURRING_PAYMENT_RESTRICTED_MESSAGE,
        reason: 'RECURRING_PAYMENT_RESTRICTED',
      };
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, settings')
      .eq('id', tenantId)
      .maybeSingle();

    if (tenantError) {
      return allow('TENANT_LOOKUP_FAILED');
    }

    // Missing tenants/settings and all values other than an explicit false
    // preserve the historical, enabled-by-default behavior.
    if (tenant?.settings?.member_portal_login_enabled !== false) {
      return allow('ENABLED');
    }

    if (member?.tenant_id && member.tenant_id !== tenantId) {
      return block('MEMBER_TENANT_MISMATCH');
    }

    const memberOrganizationId = organizationId ?? member?.organization_id ?? null;
    if (!memberOrganizationId) {
      return block('MEMBER_ORGANIZATION_MISSING');
    }

    const {
      data: markedPrimary,
      error: primaryError,
    } = await supabase
      .from('organization')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('is_primary', true)
      .limit(1)
      .maybeSingle();

    let primaryOrganizationId = markedPrimary?.id || null;

    if (primaryError) {
      // PostgreSQL 42703 means this legacy schema has no is_primary column,
      // for which the documented earliest-created fallback still applies.
      if (primaryError.code !== '42703') {
        return allow('PRIMARY_LOOKUP_FAILED');
      }
      primaryOrganizationId = null;
    }

    if (!primaryOrganizationId) {
      const { data: earliest, error: earliestError } = await supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (earliestError) {
        return allow('PRIMARY_FALLBACK_LOOKUP_FAILED');
      }
      primaryOrganizationId = earliest?.id || null;
    }

    if (!primaryOrganizationId) {
      return block('PRIMARY_ORGANIZATION_MISSING');
    }

    if (memberOrganizationId !== primaryOrganizationId) {
      return block('MEMBER_ORGANIZATION_NOT_PRIMARY');
    }

    return allow('PRIMARY_ORGANIZATION_MEMBER');
  } catch (error) {
    return allow('LOOKUP_FAILED');
  }
}
