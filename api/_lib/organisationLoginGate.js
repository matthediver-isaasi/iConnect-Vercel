import { supabase as defaultSupabase } from './database.js';

export const DEFAULT_GATE_BLOCKED_MESSAGE =
  'Login is not currently available for your organisation. Please contact your administrator.';

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
