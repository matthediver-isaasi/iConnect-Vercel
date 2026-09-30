import { supabase as defaultSupabase } from './database.js';

export const DEFAULT_GATE_BLOCKED_MESSAGE =
  'Login is not currently available for your organisation. Please contact your administrator.';

export const MANUAL_ORGANISATION_LOGIN_BLOCKED_MESSAGE =
  'Login has been disabled for this organisation. Please contact your administrator.';

export const MEMBER_PORTAL_GATE_BLOCKED_MESSAGE =
  'Access to the member portal is currently unavailable';

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
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('tenant_id', tenantId)
    .eq('setting_key', 'organization_login_gate')
    .maybeSingle();
  if (error) {
    // A lookup failure must never silently bypass a configured organisation
    // restriction. This result is only consumed for member-derived access;
    // standalone tenant/platform administration remains outside this gate.
    return { enabled: true, invalid: true };
  }
  if (!data?.setting_value) return null;
  try {
    const parsed = typeof data.setting_value === 'string'
      ? JSON.parse(data.setting_value)
      : data.setting_value;
    if (!parsed || typeof parsed !== 'object') return { enabled: true, invalid: true };
    return parsed;
  } catch (e) {
    return { enabled: true, invalid: true };
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

  if (gate.invalid || !gate.fieldKey || !gate.fieldSource) {
    // A tenant intentionally enabled this restriction but it can no longer be
    // resolved. Do not silently turn an access control rule into an allow.
    return { blocked: true, message, gate, reason: 'GATE_CONFIGURATION_INVALID' };
  }

  if (!organizationId) {
    return { blocked: true, message, gate };
  }

  let actualValues = [];

  if (gate.fieldSource === 'core') {
    if (!ALLOWED_CORE_FIELDS.has(gate.fieldKey)) {
      return { blocked: true, message, gate, reason: 'GATE_CONFIGURATION_INVALID' };
    }
    const { data: org } = await supabase
      .from('organization')
      .select(`id, tenant_id, ${gate.fieldKey}`)
      .eq('id', organizationId)
      .maybeSingle();
    if (!org || (tenantId && org.tenant_id !== tenantId)) {
      return { blocked: true, message, gate, reason: 'GATE_ORGANIZATION_UNRESOLVED' };
    }
    const raw = org[gate.fieldKey];
    actualValues = raw === null || raw === undefined ? [] : [normalizeScalar(raw)];
  } else if (gate.fieldSource === 'custom') {
    const { data: pref, error: preferenceError } = await supabase
      .from('organization_preference_value')
      .select('value')
      .eq('organization_id', organizationId)
      .eq('field_id', gate.fieldKey)
      .maybeSingle();
    if (preferenceError) {
      return { blocked: true, message, gate, reason: 'GATE_VALUE_UNRESOLVED' };
    }
    if (!pref) {
      actualValues = [];
    } else {
      actualValues = normalizePreferenceValue(pref.value);
    }
  } else {
    return { blocked: true, message, gate, reason: 'GATE_CONFIGURATION_INVALID' };
  }

  if (!valuesMatch(actualValues, gate.requiredValue)) {
    return { blocked: true, message, gate, reason: 'GATE_VALUE_DENIED' };
  }

  return { blocked: false, message: null, gate };
}

/**
 * The sole effective access decision for member sessions.  The manual
 * organisation switch is deliberately independent from the configured gate:
 * clearing one can never clear the other.
 */
export async function evaluateEffectiveOrganisationLoginAccess({
  supabase = defaultSupabase,
  tenantId,
  organizationId,
} = {}) {
  const gateResult = await evaluateOrganisationLoginGate({ supabase, tenantId, organizationId });
  let manualBlocked = false;
  let organization = null;

  if (organizationId) {
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, member_login_blocked, member_login_blocked_at, member_login_blocked_by, member_login_revocation_generation')
      .eq('id', organizationId)
      .maybeSingle();

    // Missing/cross-tenant organisations are not a valid member provenance.
    // If the organisation gate is configured it already denies this path;
    // otherwise deny it too rather than trusting stale session data.
    // Deploys can briefly serve code before the additive column is visible.
    // Preserve the legacy (manual=false) behaviour in that narrow compatibility
    // window while still enforcing the configured gate.
    if (error?.code === '42703' || error?.code === 'PGRST204') {
      return {
        manualBlocked: false,
        gateBlocked: !!gateResult.blocked,
        blocked: !!gateResult.blocked,
        causes: gateResult.blocked ? ['gate'] : [],
        updatedAt: null,
        updatedBy: null,
        message: gateResult.message || null,
        gate: gateResult.gate || null,
        organizationGeneration: 0,
      };
    }
    if (error || !data || (tenantId && data.tenant_id !== tenantId)) {
      return {
        manualBlocked: false,
        gateBlocked: true,
        blocked: true,
        causes: ['organization_unresolved'],
        updatedAt: null,
        updatedBy: null,
        message: gateResult.message || DEFAULT_GATE_BLOCKED_MESSAGE,
        gate: gateResult.gate || null,
        organizationGeneration: 0,
      };
    }
    organization = data;
    manualBlocked = data.member_login_blocked === true;
  }

  const causes = [];
  if (manualBlocked) causes.push('manual');
  if (gateResult.blocked) causes.push('gate');
  return {
    manualBlocked,
    gateBlocked: !!gateResult.blocked,
    blocked: manualBlocked || !!gateResult.blocked,
    causes,
    updatedAt: organization?.member_login_blocked_at || null,
    updatedBy: organization?.member_login_blocked_by || null,
    message: manualBlocked
      ? MANUAL_ORGANISATION_LOGIN_BLOCKED_MESSAGE
      : (gateResult.message || null),
    gate: gateResult.gate || null,
    organizationGeneration: Number(organization?.member_login_revocation_generation || 0),
  };
}

/**
 * Resolve a current member row before using its organisation restriction.
 * This is used by session validation as well as issuance, so reassignment and
 * gate-field changes take effect without relying on asynchronous cleanup.
 */
export async function evaluateMemberOrganisationLoginAccess({
  supabase = defaultSupabase,
  memberId,
  tenantId,
  member: suppliedMember,
} = {}) {
  let member = suppliedMember || null;
  if (!member && memberId) {
    const { data, error } = await supabase
      .from('member')
      .select('id, tenant_id, organization_id')
      .eq('id', memberId)
      .maybeSingle();
    if (error || !data) {
      return {
        blocked: true,
        causes: ['member_unresolved'],
        message: DEFAULT_GATE_BLOCKED_MESSAGE,
      };
    }
    member = data;
  }
  if (!member) {
    return { blocked: true, causes: ['member_unresolved'], message: DEFAULT_GATE_BLOCKED_MESSAGE };
  }

  let effectiveTenantId = tenantId || member.tenant_id || null;
  if (!effectiveTenantId && member.organization_id) {
    const { data: organization, error } = await supabase
      .from('organization')
      .select('tenant_id')
      .eq('id', member.organization_id)
      .maybeSingle();
    if (error || !organization?.tenant_id) {
      return { blocked: true, causes: ['organization_unresolved'], message: DEFAULT_GATE_BLOCKED_MESSAGE };
    }
    effectiveTenantId = organization.tenant_id;
  }
  if (!effectiveTenantId) {
    // Existing behaviour permits standalone member records only when no
    // organisation gate can be evaluated. Do not accidentally block them.
    return {
      blocked: false,
      causes: [],
      manualBlocked: false,
      gateBlocked: false,
      tenantId: null,
    };
  }
  const result = await evaluateEffectiveOrganisationLoginAccess({
    supabase,
    tenantId: effectiveTenantId,
    organizationId: member.organization_id || null,
  });
  return {
    ...result,
    tenantId: effectiveTenantId,
    organizationId: member.organization_id || null,
    organizationGeneration: Number(result.organizationGeneration || 0),
  };
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
    const arrearsPolicies = ['suspend'];
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
