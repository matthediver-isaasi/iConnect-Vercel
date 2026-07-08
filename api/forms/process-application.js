import { createClient } from '@supabase/supabase-js';
import { triggerWorkflows } from '../_lib/workflows.js';
import { calculateMembershipYearWindow } from '../_lib/membershipYear.js';
import { resolveEffectiveOrgGuestAccess } from '../_lib/orgGuestAccess.js';
import { notifyGuestSignup } from '../_lib/guestSignupNotification.js';
import { resolveStaticTodayToken } from '../_lib/staticValueTokens.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

// Fields that should be coerced to boolean values
const BOOLEAN_CORE_FIELDS = ['show_in_directory', 'login_enabled'];

// Helper function to check if a value is "empty" (undefined, null, or empty string)
const isEmptyValue = (value) => value === undefined || value === null || value === '';

// Cross-tenant guard: verify a role belongs to the same tenant as the member
// it is about to be written onto. Returns { ok: true } when the role is in
// the expected tenant. Returns { ok: false, message } on mismatch / missing
// role / lookup failure. Returns { ok: true, skipped: true } when either id
// is missing — the caller is responsible for deciding whether to proceed.
//
// Treat mismatches as a hard internal error (FormBuilder is supposed to only
// surface roles from the current tenant, so this branch should never fire in
// normal operation; if it does, the form's pipeline / conditional logic is
// referencing a stale cross-tenant role and we must not silently corrupt
// member.role_id).
const validateRoleTenant = async (supabaseClient, roleId, expectedTenantId) => {
  if (!roleId || !expectedTenantId) {
    return { ok: true, skipped: true };
  }
  const { data: role, error } = await supabaseClient
    .from('role')
    .select('id, tenant_id')
    .eq('id', roleId)
    .maybeSingle();
  if (error) {
    console.error('[AppProcessor] Role tenant lookup failed:', { roleId, error });
    return { ok: false, message: `Failed to validate role tenant: ${error.message}` };
  }
  if (!role) {
    console.error('[AppProcessor] Role not found during tenant validation:', { roleId });
    return { ok: false, message: `Configured role does not exist` };
  }
  if (role.tenant_id !== expectedTenantId) {
    console.error('[AppProcessor] Cross-tenant role write blocked:', {
      role_id: roleId,
      role_tenant_id: role.tenant_id,
      expected_tenant_id: expectedTenantId,
    });
    return { ok: false, message: 'Configured role does not belong to this tenant' };
  }
  return { ok: true };
};

// Resolve the tenant's configured default role (`is_default = true`),
// strictly tenant-scoped. Returns { role, error } where `role` is the full
// role row ({ id, name }) or null when no default is configured, and
// `error` is non-null only on lookup failure (so callers can distinguish
// "tenant misconfig" from "DB error").
const resolveTenantDefaultRole = async (supabaseClient, tenantId) => {
  if (!tenantId) return { role: null, error: null };
  const { data, error } = await supabaseClient
    .from('role')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('is_default', true)
    .order('id', { ascending: true });
  if (error) return { role: null, error };
  if (!data || data.length === 0) return { role: null, error: null };
  if (data.length > 1) {
    console.warn('[AppProcessor] Tenant has multiple is_default roles; picking first by id:', {
      tenant_id: tenantId,
      candidate_role_ids: data.map(r => r.id),
    });
  }
  return { role: data[0], error: null };
};

// Helper function to check if a field has a usable value for assignment
// For boolean fields, we ALWAYS assign (even undefined means false - toggle was off)
const hasAssignableValue = (fieldName, value) => {
  if (BOOLEAN_CORE_FIELDS.includes(fieldName)) {
    // For boolean fields, always return true - if a mapping exists, we should assign
    // Undefined/null/empty will be coerced to false by coerceBooleanField
    return true;
  }
  // For non-boolean fields, skip empty values
  return !isEmptyValue(value);
};

// Address-typed columns that should accept multi-line strings, not raw objects.
// FormBuilder may collect a structured address (from a composite address field
// or a future structured input) whose value is an object — coerce it into a
// newline-joined string so it lands cleanly in the text column.
const ADDRESS_LIKE_TARGETS = new Set(['invoicing_address', 'address']);

const normalizeAddressValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter(p => p !== undefined && p !== null && String(p).trim() !== '')
      .map(p => String(p))
      .join('\n');
  }
  if (typeof value === 'object') {
    // Try a known subfield order first, tolerate common naming variants.
    const candidates = [
      value.line1, value.address_line_1, value.line_1, value.street, value.address1,
      value.line2, value.address_line_2, value.line_2, value.address2,
      value.line3, value.address_line_3, value.line_3,
      value.city, value.town,
      value.state, value.region, value.county,
      value.postcode, value.postal_code, value.zip,
      value.country,
    ];
    let parts = candidates.filter(p => p !== undefined && p !== null && String(p).trim() !== '');
    if (parts.length === 0) {
      // Fallback: insertion order, primitives only (skip nested objects).
      parts = Object.values(value)
        .filter(p => p !== undefined && p !== null)
        .filter(p => typeof p !== 'object')
        .filter(p => String(p).trim() !== '');
    }
    return parts.map(p => String(p)).join('\n');
  }
  return String(value);
};

// Coerce values destined for address-like text columns. Other columns are
// returned unchanged.
const coerceAddressIfNeeded = (targetField, value) =>
  ADDRESS_LIKE_TARGETS.has(targetField) ? normalizeAddressValue(value) : value;

// URL-typed core columns that should receive a plain URL string. File-upload
// form fields produce object values (`{ file_url, storage_path, bucket,
// file_name, ... }`) and FormBuilder allows mapping such a field to e.g.
// Organisation → Logo, which then writes the entire JSON payload into
// `organization.logo_url` and breaks `<img src>` rendering. Detect a
// file-upload payload (object with a `file_url` string, or a JSON-encoded
// string of one) and reduce it to the URL string. Other shapes — plain
// strings, null, empty — pass through unchanged.
//
// Member core columns surfaced by FormBuilder don't currently include any
// file-capable URL targets (linkedin_url etc. are custom/text fields), but
// the helper is keyed by target field name so adding a future member URL
// target only requires extending FILE_URL_CORE_TARGETS.
const FILE_URL_CORE_TARGETS = new Set(['logo_url', 'website_url']);

const extractFileUrlFromValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Cheap shape check before attempting JSON.parse — only try when the
    // string looks like a JSON object literal of a file payload.
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('file_url')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.file_url === 'string') {
          return parsed.file_url;
        }
      } catch (_) {
        // Not valid JSON — leave the original string untouched.
      }
    }
    return value;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.file_url === 'string') return value.file_url;
  }
  return value;
};

const coerceFileValueIfNeeded = (targetField, value) =>
  FILE_URL_CORE_TARGETS.has(targetField) ? extractFileUrlFromValue(value) : value;

// Compose the per-target coercions in a fixed order so each write path stays
// in sync: file → address → boolean. Only the matching coercion transforms
// the value; the rest pass it through unchanged.
const coerceCoreFieldValue = (targetEntity, targetField, value) => {
  let v = coerceFileValueIfNeeded(targetField, value);
  v = coerceAddressIfNeeded(targetField, v);
  if (targetEntity === 'member') {
    v = coerceBooleanField(targetField, v);
  }
  return v;
};

// Helper function to coerce values to boolean for boolean fields
const coerceBooleanField = (fieldName, value) => {
  if (!BOOLEAN_CORE_FIELDS.includes(fieldName)) {
    return value;
  }
  // Already a boolean
  if (typeof value === 'boolean') {
    return value;
  }
  // Handle undefined, null, or empty string as false
  if (value === undefined || value === null || value === '') {
    return false;
  }
  // Handle string representations
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false;
    }
  }
  // Handle numeric values
  if (typeof value === 'number') {
    return value !== 0;
  }
  // Default: treat as false for boolean fields
  return false;
};

// Helper function to apply value transformations
const applyTransformation = (value, transformation) => {
  if (value === null || value === undefined) return value;
  const strValue = String(value);
  
  switch (transformation) {
    case 'trim':
      return strValue.trim();
    case 'uppercase':
      return strValue.toUpperCase();
    case 'lowercase':
      return strValue.toLowerCase();
    case 'titlecase':
      return strValue.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    case 'extract_domain': {
      let domain = strValue.trim();
      if (domain.includes('@')) {
        domain = domain.split('@').pop() || domain;
      }
      domain = domain.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
      domain = domain.replace(/^www\./i, '');
      domain = domain.split(/[/?#]/)[0];
      return domain.toLowerCase() || strValue;
    }
    case 'extract_username':
      if (strValue.includes('@')) {
        return strValue.split('@')[0] || strValue;
      }
      return strValue;
    case 'first_word':
      return strValue.trim().split(/\s+/)[0] || strValue;
    case 'last_word':
      const words = strValue.trim().split(/\s+/);
      return words[words.length - 1] || strValue;
    case 'remove_spaces':
      return strValue.replace(/\s+/g, '');
    case 'numbers_only':
      return strValue.replace(/[^0-9]/g, '');
    case 'current_date':
      return new Date().toISOString().split('T')[0]; // Returns YYYY-MM-DD format
    case 'none':
    default:
      return strValue;
  }
};

// Helper function to load an organisation's verified email domains.
// Mirrors the behaviour of api/public/organisation/[id]/domains.js so the
// frontend's domain check and the backend's guest-stamping stay in sync.
//
// preference_field is tenant-scoped, so when the caller already knows the
// org's tenant_id it MUST be passed in — otherwise the lookup would either
// fail with PGRST116 (multi-row from .single()) or pick the wrong tenant's
// field_id and silently return an empty domain list. When tenantId is
// omitted we look it up from the organization row, tolerating databases
// without the tenant_id column (42703) by falling back to the unscoped
// query; the maybeSingle() + early-return-on-error guard below means a
// multi-row fallback safely collapses to [] instead of crashing.
const loadOrgVerifiedDomains = async (supabaseClient, organizationId, tenantId) => {
  if (!organizationId) return [];

  let resolvedTenantId = tenantId || null;
  if (!resolvedTenantId) {
    const { data: orgRow, error: orgErr } = await supabaseClient
      .from('organization')
      .select('tenant_id')
      .eq('id', organizationId)
      .maybeSingle();
    if (!orgErr && orgRow?.tenant_id) {
      resolvedTenantId = orgRow.tenant_id;
    }
    // If the column doesn't exist (42703) or the row has a NULL tenant_id we
    // proceed without a tenant filter — the maybeSingle() fallback below
    // ensures we no longer crash on multi-row results.
  }

  let fieldDefQuery = supabaseClient
    .from('preference_field')
    .select('id')
    .eq('name', 'verified_domains')
    .eq('entity_scope', 'organization')
    .eq('is_active', true);

  if (resolvedTenantId) {
    fieldDefQuery = fieldDefQuery.eq('tenant_id', resolvedTenantId);
  }

  const { data: fieldDef, error: fieldError } = await fieldDefQuery.maybeSingle();

  if (fieldError || !fieldDef) return [];

  const { data: fieldValue, error: valueError } = await supabaseClient
    .from('organization_preference_value')
    .select('value')
    .eq('organization_id', organizationId)
    .eq('field_id', fieldDef.id)
    .maybeSingle();

  if (valueError || !fieldValue?.value) return [];

  const val = fieldValue.value;
  let domains = [];
  if (Array.isArray(val)) {
    domains = val.filter(Boolean);
  } else if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      domains = Array.isArray(parsed) ? parsed.filter(Boolean) : [parsed].filter(Boolean);
    } catch {
      domains = val.split(',').map(d => d.trim()).filter(Boolean);
    }
  }
  return domains.map(d => String(d).toLowerCase()).filter(Boolean);
};

// Helper to extract the lowercase domain portion of an email address.
const extractEmailDomain = (email) => {
  if (!email || typeof email !== 'string') return '';
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[1]) return '';
  return parts[1].trim().toLowerCase();
};

// Determine whether the form's email field (the one mapped to member.email)
// opted into the "Restrict to Organisation Domain" check. Mirrors how
// FormBuilder surfaces `validate_org_domain` on email fields and how the
// frontend's FormRenderer enforces it — so the server only rejects on
// domain mismatch for forms that actually configured the restriction.
const formHasMemberEmailDomainRestriction = (fields, fieldMappings, memberPipelines) => {
  if (!Array.isArray(fields) || fields.length === 0) return false;

  const sourceFieldIds = new Set();

  // 1. Modern field_mappings array (preferred).
  if (Array.isArray(fieldMappings)) {
    for (const m of fieldMappings) {
      if (
        m &&
        m.target_type === 'core' &&
        m.target_entity === 'member' &&
        m.target_field === 'email' &&
        m.source_field_id
      ) {
        sourceFieldIds.add(m.source_field_id);
      }
    }
  }

  // 2. entity_pipelines: primary member pipeline's mappings array.
  if (Array.isArray(memberPipelines) && memberPipelines.length > 0) {
    const primary = memberPipelines.find(p => p && (p.isPrimary || p.is_primary)) || memberPipelines[0];
    if (primary && Array.isArray(primary.mappings)) {
      for (const m of primary.mappings) {
        if (
          m &&
          m.target_type === 'core' &&
          m.target_field === 'email' &&
          m.source_field_id
        ) {
          sourceFieldIds.add(m.source_field_id);
        }
      }
    }
  }

  // 3. Legacy fallback: fields[].core_field_mapping === 'email'.
  if (sourceFieldIds.size === 0) {
    for (const f of fields) {
      if (f && f.core_field_mapping === 'email' && f.id) {
        sourceFieldIds.add(f.id);
      }
    }
  }

  if (sourceFieldIds.size === 0) return false;

  for (const f of fields) {
    if (f && sourceFieldIds.has(f.id) && f.validate_org_domain === true) {
      return true;
    }
  }
  return false;
};

// Resolve domain-vs-guest context for a brand-new member. Returns
//   {
//     emailDomain,         // lowercase domain or '' when unparseable
//     verifiedDomains,     // array of lowercase domains, possibly empty
//     domainMatches,       // bool: emailDomain is in verifiedDomains
//     guestStamp,          // { is_guest, guest_expires_at } | null
//     hasOrgContext,       // bool: org row was loaded successfully
//   }
// or null when there's no organisationId / email to evaluate. The
// guest_access decision is gated by the tenant master switch (via the
// shared resolveEffectiveOrgGuestAccess helper) so this can never disagree
// with the public /domains endpoint that the frontend consults.
const resolveDomainGuestContext = async (supabaseClient, organizationId, email) => {
  if (!organizationId || !email) return null;
  const emailDomain = extractEmailDomain(email);
  if (!emailDomain) return null;

  // Fetch the per-org guest access settings, including tenant_id so the
  // verified-domains lookup below stays tenant-scoped. Tolerate databases
  // without the optional columns (returns 42703) so existing flows keep
  // working.
  let org = null;
  {
    const { data, error } = await supabaseClient
      .from('organization')
      .select('id, tenant_id, guest_access_enabled, guest_access_period_days, guest_access_unlimited')
      .eq('id', organizationId)
      .single();
    if (error) {
      if (error.code === '42703') {
        // Guest access columns aren't on this database — fall back to a
        // basic select so domain enforcement still works.
        const { data: basicData, error: basicErr } = await supabaseClient
          .from('organization')
          .select('id, tenant_id')
          .eq('id', organizationId)
          .single();
        if (basicErr) {
          console.error('[AppProcessor] Failed to load org (basic) for guest check:', basicErr);
          return null;
        }
        org = basicData;
      } else {
        console.error('[AppProcessor] Failed to load org for guest check:', error);
        return null;
      }
    } else {
      org = data;
    }
  }

  const verifiedDomains = await loadOrgVerifiedDomains(supabaseClient, organizationId, org.tenant_id);
  const domainMatches = verifiedDomains.includes(emailDomain);

  let guestStamp = null;
  if (!domainMatches) {
    const effective = await resolveEffectiveOrgGuestAccess(supabaseClient, org);
    if (effective.enabled) {
      if (effective.unlimited || effective.period_days == null) {
        guestStamp = { is_guest: true, guest_expires_at: null };
      } else {
        const expires = new Date();
        expires.setUTCDate(expires.getUTCDate() + Number(effective.period_days));
        guestStamp = { is_guest: true, guest_expires_at: expires.toISOString() };
      }
    }
  }

  return {
    emailDomain,
    verifiedDomains,
    domainMatches,
    guestStamp,
    hasOrgContext: true,
  };
};

// Helper function to check role capacity for per-organization limits
const checkRoleCapacity = async (supabaseClient, roleId, organizationId) => {
  console.log('[checkRoleCapacity] Checking capacity for role:', roleId, 'org:', organizationId);
  
  // Fetch role to check if it has max_members limit
  const { data: role, error: roleError } = await supabaseClient
    .from('role')
    .select('id, name, max_members')
    .eq('id', roleId)
    .single();
  
  if (roleError) {
    console.error('[checkRoleCapacity] Failed to fetch role:', roleError);
    return { hasCapacity: true, error: roleError.message };
  }
  
  if (!role) {
    console.log('[checkRoleCapacity] Role not found:', roleId);
    return { hasCapacity: true, error: 'Role not found' };
  }
  
  // If no max_members limit, allow
  if (!role.max_members) {
    console.log('[checkRoleCapacity] No max_members limit for role:', role.name);
    return { hasCapacity: true, maxMembers: null, roleName: role.name };
  }
  
  // Role capacity is ALWAYS per-organization - no global fallback
  if (!organizationId) {
    console.log('[checkRoleCapacity] Organization required for capacity check');
    return { 
      hasCapacity: false, 
      maxMembers: role.max_members, 
      roleName: role.name,
      missingOrgContext: true,
      error: 'Organization context required for per-organization capacity check'
    };
  }
  
  // Count active members with this role in this organization
  const { count, error: countError } = await supabaseClient
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('role_id', roleId)
    .eq('organization_id', organizationId)
    .eq('login_enabled', true);
  
  if (countError) {
    console.error('[checkRoleCapacity] Failed to count members:', countError);
    return { hasCapacity: true, error: countError.message };
  }
  
  const currentCount = count || 0;
  const hasCapacity = currentCount < role.max_members;
  
  console.log('[checkRoleCapacity] Per-org capacity check:', {
    roleId,
    roleName: role.name,
    organizationId,
    currentCount,
    maxMembers: role.max_members,
    hasCapacity
  });
  
  return {
    hasCapacity,
    currentCount,
    maxMembers: role.max_members,
    roleName: role.name
  };
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { 
      form_id,
      form_values,
      fields,
      field_mappings,
      application_level,
      create_entity_type,
      entity_action,
      member_entity_action,        // Legacy: independent member action (none/create/update/upsert)
      organization_entity_action,  // Legacy: independent organization action (none/create/update/upsert)
      prefill_member_id,
      prefill_organization_id,
      submission_id,
      role_id,                     // Role ID from form conditional logic (set_role action)
      additional_member_creations, // Legacy: Array of additional members to create
      entity_pipelines,            // New unified structure: {members: [], organisations: []}
      tenant_id                    // Tenant ID for multi-tenant isolation (from public API)
    } = req.body;

    if (!form_values || typeof form_values !== 'object') {
      return res.status(400).json({ error: 'form_values is required' });
    }
    
    if (!fields || !Array.isArray(fields)) {
      return res.status(400).json({ error: 'fields array is required' });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Per-submission processing notes. Anything written here is persisted to
    // form_submission.processing_notes at the end of the handler so the
    // FormSubmissionView admin page can surface dropped fields and other
    // per-submission diagnostics that used to be log-only and therefore
    // invisible to admins. Keep entries small and structured (kind + a few
    // context keys) — this is a debugging breadcrumb, not a full audit log.
    const processingNotes = [];
    const addProcessingNote = (entry) => {
      try {
        processingNotes.push({
          // `at` is the canonical key; the FormSubmissionView UI reads it
          // by that name. Keep this in sync if you ever rename it.
          at: new Date().toISOString(),
          ...entry,
        });
      } catch (_) {
        // Defence in depth: never let note-keeping itself fail the request.
      }
    };

    // Custom-field upsert helper. Switches the existence probe to
    // .maybeSingle()-equivalent semantics (tolerating zero or duplicate rows
    // for the same (parent_id, field_id) pair), checks the result of every
    // .update() / .insert(), and accumulates failures into processingNotes
    // with full submission/member/field context. Pass entityScope='member'
    // for member_preference_value and 'organization' for organization_preference_value.
    const upsertPreferenceValue = async ({
      table,
      parentColumn,
      parentId,
      fieldId,
      value,
      entityScope,
      prefField,
    }) => {
      const noteContext = {
        submission_id: submission_id || null,
        [parentColumn]: parentId,
        field_id: fieldId,
        field_label: prefField?.label || prefField?.name || null,
        field_type: prefField?.field_type || null,
        entity_scope: entityScope,
      };
      try {
        const { data: existingRows, error: lookupError } = await supabase
          .from(table)
          .select('id')
          .eq(parentColumn, parentId)
          .eq('field_id', fieldId)
          .order('id', { ascending: true });
        if (lookupError) {
          console.error('[AppProcessor] Custom field lookup failed:', { ...noteContext, error: lookupError.message });
          addProcessingNote({ kind: 'custom_field_lookup_failed', message: lookupError.message, ...noteContext });
          return { ok: false };
        }
        const rows = existingRows || [];
        if (rows.length > 1) {
          console.warn('[AppProcessor] Custom field has duplicate rows; updating the first and ignoring the rest:', { ...noteContext, duplicate_ids: rows.slice(1).map(r => r.id) });
          addProcessingNote({ kind: 'custom_field_duplicate_rows', message: `Found ${rows.length} rows for (${parentColumn}, field_id); updated the earliest and left the rest untouched`, ...noteContext, duplicate_ids: rows.slice(1).map(r => r.id) });
        }
        if (rows.length >= 1) {
          const { error: updateError } = await supabase
            .from(table)
            .update({ value })
            .eq('id', rows[0].id);
          if (updateError) {
            console.error('[AppProcessor] Custom field update failed:', { ...noteContext, error: updateError.message });
            addProcessingNote({ kind: 'custom_field_update_failed', message: updateError.message, ...noteContext });
            return { ok: false };
          }
          return { ok: true, action: 'updated', id: rows[0].id };
        }
        const insertPayload = { [parentColumn]: parentId, field_id: fieldId, value };
        const { error: insertError } = await supabase
          .from(table)
          .insert(insertPayload);
        if (insertError) {
          console.error('[AppProcessor] Custom field insert failed:', { ...noteContext, error: insertError.message });
          addProcessingNote({ kind: 'custom_field_insert_failed', message: insertError.message, ...noteContext });
          return { ok: false };
        }
        return { ok: true, action: 'inserted' };
      } catch (err) {
        console.error('[AppProcessor] Custom field upsert threw:', { ...noteContext, error: err?.message });
        addProcessingNote({ kind: 'custom_field_upsert_threw', message: err?.message || String(err), ...noteContext });
        return { ok: false };
      }
    };

    // Delete an existing preference value row when the user explicitly cleared
    // a mapped custom field on update (distinct from "field absent from the
    // submission", which is a no-op). Tolerates duplicate rows.
    const clearPreferenceValue = async ({
      table,
      parentColumn,
      parentId,
      fieldId,
      entityScope,
      prefField,
    }) => {
      const noteContext = {
        submission_id: submission_id || null,
        [parentColumn]: parentId,
        field_id: fieldId,
        field_label: prefField?.label || prefField?.name || null,
        field_type: prefField?.field_type || null,
        entity_scope: entityScope,
      };
      const { error: deleteError } = await supabase
        .from(table)
        .delete()
        .eq(parentColumn, parentId)
        .eq('field_id', fieldId);
      if (deleteError) {
        console.error('[AppProcessor] Custom field clear failed:', { ...noteContext, error: deleteError.message });
        addProcessingNote({ kind: 'custom_field_clear_failed', message: deleteError.message, ...noteContext });
        return { ok: false };
      }
      return { ok: true };
    };

    // Normalize entity_pipelines to work with both new and legacy formats
    const memberPipelines = entity_pipelines?.members || [];
    const orgPipelines = entity_pipelines?.organisations || [];
    
    console.log('[AppProcessor] Entity pipelines - members:', memberPipelines.length, 'organisations:', orgPipelines.length);
    
    // Debug: Log all field IDs in form_values to help diagnose missing fields
    console.log('[AppProcessor] Form values - all field IDs present:', Object.keys(form_values));
    console.log('[AppProcessor] Form values sample (first 5 entries):', 
      Object.entries(form_values).slice(0, 5).map(([k, v]) => `${k}=${JSON.stringify(v)?.substring(0, 50)}`));
    
    // Determine if we should process members/orgs based on new entity_pipelines structure
    // If entity_pipelines is provided, use that exclusively; otherwise fall back to legacy fields
    const validActions = ['none', 'create', 'update', 'upsert'];
    const hasEntityPipelinesConfig = entity_pipelines !== undefined && entity_pipelines !== null;
    
    let memberAction;
    let orgAction;
    
    if (hasEntityPipelinesConfig) {
      // New entity_pipelines system - if provided, use it exclusively
      // If member pipelines exist, use 'upsert'; otherwise 'none' (no member processing)
      memberAction = memberPipelines.length > 0 ? 'upsert' : 'none';
    } else if (member_entity_action && validActions.includes(member_entity_action)) {
      memberAction = member_entity_action;
    } else {
      // Legacy fallback (only when entity_pipelines is not provided)
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'member' || legacyEntityType === 'both') {
        memberAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        memberAction = 'none';
      }
    }
    
    if (hasEntityPipelinesConfig) {
      // New entity_pipelines system - if provided, use it exclusively
      // If org pipelines exist, use 'upsert'; otherwise 'none' (no org processing)
      orgAction = orgPipelines.length > 0 ? 'upsert' : 'none';
    } else if (organization_entity_action && validActions.includes(organization_entity_action)) {
      orgAction = organization_entity_action;
    } else {
      // Legacy fallback (only when entity_pipelines is not provided)
      const legacyEntityType = create_entity_type || application_level || 'member';
      const legacyActionMode = entity_action || 'create';
      if (legacyEntityType === 'organization' || legacyEntityType === 'both') {
        orgAction = legacyActionMode === 'update' ? 'update' : 'create';
      } else {
        orgAction = 'none';
      }
    }
    
    // Determine processing flags based on action values
    const shouldProcessMember = memberAction !== 'none';
    const shouldProcessOrganization = orgAction !== 'none';
    const isUpdateMode = orgAction === 'update'; // For org logic compatibility
    const isMemberUpdateMode = memberAction === 'update';
    
    console.log('[AppProcessor] Entity actions - member:', memberAction, 'organization:', orgAction);
    console.log('[AppProcessor] Received role_id:', role_id, 'type:', typeof role_id);

    // Idempotency check: if submission_id provided, check if already processed.
    // form_submission has no processed_at column (the previous select referenced
    // a non-existent column and silently errored, defeating idempotency). We
    // treat a non-null created_member_id or created_organization_id as the
    // success marker — both are stamped at the end of a successful run.
    // Uses .maybeSingle() so a missing row (or zero rows) doesn't throw.
    if (submission_id) {
      const { data: existingSubmission, error: existingErr } = await supabase
        .from('form_submission')
        .select('created_member_id, created_organization_id')
        .eq('id', submission_id)
        .maybeSingle();

      if (existingErr) {
        console.error('[AppProcessor] Failed to look up existing submission for idempotency:', existingErr);
      }

      if (existingSubmission && (existingSubmission.created_member_id || existingSubmission.created_organization_id)) {
        console.log('[AppProcessor] Submission already processed:', submission_id);
        return res.json({
          success: true,
          already_processed: true,
          created_member_id: existingSubmission.created_member_id,
          created_organization_id: existingSubmission.created_organization_id
        });
      }
    }

    // SERVER-SIDE UNIQUENESS VALIDATION (defense in depth)
    // This blocks duplicates even if client-side validation is bypassed
    // Skip for update modes with prefill IDs (those are legitimate self-updates)
    const isCreatingNewEntities = !prefill_member_id && !prefill_organization_id;
    
    if (form_id && isCreatingNewEntities) {
      const { data: formData } = await supabase
        .from('form')
        .select('uniqueness_checks, tenant_id')
        .eq('id', form_id)
        .single();
      
      if (formData?.uniqueness_checks && Array.isArray(formData.uniqueness_checks) && formData.uniqueness_checks.length > 0) {
        const effectiveTenantId = tenant_id || formData.tenant_id;
        console.log('[AppProcessor] Running server-side uniqueness validation, tenant_id:', effectiveTenantId);
        
        const conflicts = [];
        const validFieldIds = new Set((fields || []).filter(f => f && f.id).map(f => f.id));
        
        for (const check of formData.uniqueness_checks) {
          if (!check || !check.field_id || !validFieldIds.has(check.field_id)) continue;
          
          const field = fields.find(f => f && f.id === check.field_id);
          if (!field) continue;
          
          const value = form_values[check.field_id];
          if (!value) continue;
          
          const targetField = check.target_field;
          if (!targetField || !targetField.includes('.')) continue;
          
          const [targetEntity, targetColumn] = targetField.split('.');
          const tableName = targetEntity === 'organization' ? 'organization' : 'member';
          
          // Validate target column against whitelist
          const validColumns = {
            member: ['email', 'full_name', 'phone'],
            organization: ['name', 'invoicing_email', 'phone', 'website_url']
          };
          if (!validColumns[tableName]?.includes(targetColumn)) continue;
          
          // Escape SQL wildcards for safe ilike usage
          const searchValue = String(value).trim().replace(/[%_]/g, '\\$&');
          const mode = check.comparison_mode || 'equals_lowercase';
          
          // Build query based on comparison mode
          let query = supabase.from(tableName).select('id', { count: 'exact', head: true });
          
          if (mode === 'equals') {
            query = query.eq(targetColumn, searchValue);
          } else if (mode === 'contains') {
            query = query.ilike(targetColumn, `%${searchValue}%`);
          } else if (mode === 'starts_with') {
            query = query.ilike(targetColumn, `${searchValue}%`);
          } else if (mode === 'ends_with') {
            query = query.ilike(targetColumn, `%${searchValue}`);
          } else {
            // Default: equals_lowercase (case insensitive exact match)
            query = query.ilike(targetColumn, searchValue);
          }
          
          // Add tenant filtering
          if (effectiveTenantId) {
            query = query.eq('tenant_id', effectiveTenantId);
          }
          
          const { count } = await query;
          
          if (count && count > 0) {
            const entityLabel = tableName === 'organization' ? 'an organisation' : 'a member';
            conflicts.push({
              field_id: check.field_id,
              field_label: field.label || check.field_id,
              message: `We already have ${entityLabel} registered with this value.`
            });
          }
        }
        
        if (conflicts.length > 0) {
          console.log('[AppProcessor] Server-side uniqueness check BLOCKED submission:', conflicts);
          return res.status(409).json({
            valid: false,
            error: 'Uniqueness validation failed',
            conflicts,
            code: 'UNIQUENESS_CONFLICT'
          });
        }
        
        console.log('[AppProcessor] Server-side uniqueness check passed');
      }
    }

    const memberData = {};
    const orgData = {};
    // Use Maps to aggregate values for list fields
    const memberCustomFieldsMap = new Map();
    const orgCustomFieldsMap = new Map();
    // Track custom fields the user explicitly cleared on this submission so we
    // can DELETE the existing member_preference_value / organization_preference_value
    // row at upsert time. This is distinct from "field absent from the
    // submission" (which is a no-op). Populated by both the legacy
    // field_mappings path and the entity_pipelines path when the source form
    // value is present but empty (null / '' / [] / __clear__ sentinel).
    const memberCustomFieldsToClear = new Set();
    const orgCustomFieldsToClear = new Set();
    // Map to collect communication preferences (categoryId -> boolean subscribed value)
    const memberCommunicationPrefsMap = new Map();

    // Test whether a form_values key is "present and explicitly cleared" vs
    // "absent from the submission". Only used for custom-field mappings (core
    // field semantics are owned by hasAssignableValue / task #593's work).
    const isExplicitlyClearedValue = (value) => {
      if (value === '__clear__') return true;
      if (value === null) return true;
      if (value === '') return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    };

    // Lookup form-field metadata by id so mapping handlers can introspect the
    // source field's type. Used to guard against writing an
    // organisation_dropdown's stored UUID into an organisation core column
    // (which would rename the org to its own id).
    const fieldsById = new Map((fields || []).filter(f => f && f.id).map(f => [f.id, f]));
    const isOrgDropdownSourceField = (sourceFieldId) => {
      if (!sourceFieldId) return false;
      const f = fieldsById.get(sourceFieldId);
      return !!f && f.type === 'organisation_dropdown';
    };
    // Captures the organisation id selected via an organisation_dropdown form
    // field, when that field was mapped to an organisation core column. We
    // never write the UUID into the core column; instead we feed it into the
    // existing org-resolution chain as a synthetic prefill_organization_id so
    // the right organisation row is updated.
    let dropdownSelectedOrgId = null;
    // Same guard for member_dropdown form fields: their stored value is a
    // member UUID, and mapping that to a member core column (Email / Full
    // Name / etc.) would rename the member to its own id. Capture the id
    // and feed it into the member-resolution chain instead.
    const isMemberDropdownSourceField = (sourceFieldId) => {
      if (!sourceFieldId) return false;
      const f = fieldsById.get(sourceFieldId);
      return !!f && f.type === 'member_dropdown';
    };
    let dropdownSelectedMemberId = null;

    const { data: preferenceFields } = await supabase
      .from('preference_field')
      .select('*')
      .eq('is_active', true);

    const prefFieldMap = new Map((preferenceFields || []).map(pf => [pf.id, pf]));

    // Multi-value preference field types. All of these store their value as a
    // JSON-stringified array via convertMapToArray below, so when the same
    // field is mapped from multiple form fields (or arrives as an array from
    // a multi-select control) we aggregate-and-dedupe instead of letting one
    // mapping clobber another. Single-value field types fall through to
    // "last write wins". Keep this list in sync with the FormBuilder field
    // type catalogue so a new multi-select type doesn't silently regress to
    // scalar storage.
    const MULTI_VALUE_PREF_FIELD_TYPES = new Set([
      'list',
      'picklist',
      'checkbox',
      'multi_select',
      'multiselect',
    ]);

    // Helper to add value to custom field map (aggregates for multi-value fields)
    const addCustomFieldValue = (map, fieldId, value, prefField) => {
      const isMultiValueField =
        MULTI_VALUE_PREF_FIELD_TYPES.has(prefField?.field_type) || Array.isArray(value);

      if (isMultiValueField) {
        // Aggregate values into a deduped array for multi-value fields
        if (!map.has(fieldId) || !Array.isArray(map.get(fieldId))) {
          map.set(fieldId, []);
        }
        const arr = map.get(fieldId);

        // Handle array values (from multi-select checkboxes)
        if (Array.isArray(value)) {
          for (const item of value) {
            if (!arr.includes(item)) {
              arr.push(item);
            }
          }
        } else if (value !== undefined && value !== null && value !== '') {
          if (!arr.includes(value)) {
            arr.push(value);
          }
        }
      } else {
        // For non-multi-value fields, just store the value (last one wins).
        map.set(fieldId, value);
      }
    };

    // Build set of fields that are explicitly mapped in entity_pipelines Primary Member
    // These fields should NOT be populated by legacy field_mappings (entity_pipelines takes precedence)
    const pipelineMemberFields = new Set();
    const pipelineOrgFields = new Set();
    
    if (memberPipelines.length > 0) {
      const primaryMemberPipeline = memberPipelines.find(m => m.isPrimary || m.is_primary);
      if (primaryMemberPipeline?.mappings && Array.isArray(primaryMemberPipeline.mappings)) {
        for (const m of primaryMemberPipeline.mappings) {
          if (m.target_type === 'core' && m.target_field) {
            pipelineMemberFields.add(m.target_field);
          }
        }
      }
    }
    
    if (orgPipelines.length > 0) {
      const primaryOrgPipeline = orgPipelines.find(o => o.isPrimary || o.is_primary);
      if (primaryOrgPipeline?.mappings && Array.isArray(primaryOrgPipeline.mappings)) {
        for (const m of primaryOrgPipeline.mappings) {
          if (m.target_type === 'core' && m.target_field) {
            pipelineOrgFields.add(m.target_field);
          }
        }
      }
    }
    
    console.log('[AppProcessor] Entity pipeline fields to skip in legacy field_mappings - member:', [...pipelineMemberFields], 'org:', [...pipelineOrgFields]);
    
    // Process new field_mappings array first (preferred method)
    // Skip fields that are mapped in entity_pipelines (those take precedence even if undefined)
    if (field_mappings && Array.isArray(field_mappings) && field_mappings.length > 0) {
      console.log('[AppProcessor] Using field_mappings:', field_mappings.length, 'mappings');
      
      for (const mapping of field_mappings) {
        const { source_type, source_field_id, source_category_id, static_value, target_type, target_entity, target_field, transformation } = mapping;
        
        // Skip if no target field
        if (!target_field) continue;
        
        // Skip if this core field is mapped in entity_pipelines (takes precedence)
        if (target_type === 'core') {
          if (target_entity === 'member' && pipelineMemberFields.has(target_field)) {
            console.log('[AppProcessor] Skipping legacy field_mappings for member field (entity_pipelines takes precedence):', target_field);
            continue;
          }
          if (target_entity === 'organization' && pipelineOrgFields.has(target_field)) {
            console.log('[AppProcessor] Skipping legacy field_mappings for org field (entity_pipelines takes precedence):', target_field);
            continue;
          }
        }
        
        let value;
        // Track whether this mapping was sourced from a key that exists in
        // form_values (vs absent). For custom-field mappings, an absent key
        // is a no-op while a present-but-empty key is an explicit clear.
        let sourceFieldKeyPresent = false;
        
        // Handle current_date source type or transformation - doesn't need a source value
        if (source_type === 'current_date' || transformation === 'current_date') {
          value = applyTransformation('', 'current_date');
          sourceFieldKeyPresent = true;
          console.log('[AppProcessor] Current date mapping:', target_field, '=', value);
        } else if (source_type === 'static') {
          // Static value mapping - use the fixed value
          value = resolveStaticTodayToken(static_value);
          if (value === undefined || value === null || value === '') continue;
          sourceFieldKeyPresent = true;
          console.log('[AppProcessor] Static mapping:', target_field, '=', value);
        } else {
          // Form field mapping (default)
          if (!source_field_id) continue;
          sourceFieldKeyPresent = Object.prototype.hasOwnProperty.call(form_values, source_field_id);
          value = form_values[source_field_id];
          
          // If source_category_id is set, extract the specific category value from a communication_preferences object
          if (source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
            value = value[source_category_id] !== undefined ? value[source_category_id] : null;
            console.log(`[AppProcessor] Extracted category ${source_category_id} from communication_preferences: ${value}`);
          }
          
          // For boolean fields in member entities, allow empty/false through (they mean false)
          const isMemberBooleanField = target_type === 'core' && target_entity === 'member' && BOOLEAN_CORE_FIELDS.includes(target_field);
          // For custom-field mappings, distinguish "absent" (skip) from
          // "present and explicitly cleared" (clear the existing value at
          // upsert time). For core fields, preserve the legacy behaviour of
          // skipping any empty value (task #593 owns core field clearing).
          if (target_type === 'custom') {
            if (!sourceFieldKeyPresent) continue;
            // Falls through with possibly-empty value; clear handling below.
          } else if (!isMemberBooleanField && (value === undefined || value === null || value === '')) {
            continue;
          }
          
          // Apply transformation only for field mappings (skip for empty
          // custom-field clears so transformations don't synthesise a value).
          if (transformation && transformation !== 'none' && !(target_type === 'custom' && isExplicitlyClearedValue(value))) {
            value = applyTransformation(value, transformation);
          }
        }
        
        if (target_type === 'core') {
          if (target_entity === 'member') {
            // Guard: a member_dropdown stores the selected member's UUID
            // as its value. Writing that into memberData.email / .full_name
            // / etc. would rename the member to its own id. Instead,
            // capture the selected id for the member-resolution chain and
            // skip the assignment.
            if (isMemberDropdownSourceField(source_field_id)) {
              if (typeof value === 'string' && value && !dropdownSelectedMemberId) {
                dropdownSelectedMemberId = value;
              }
              console.log('[AppProcessor] Skipped member core assignment from member_dropdown source:', { target_field, source_field_id, captured_member_id: value });
              continue;
            }
            // Use hasAssignableValue to properly handle boolean fields
            if (hasAssignableValue(target_field, value)) {
              memberData[target_field] = coerceCoreFieldValue('member', target_field, value);
            }
          } else if (target_entity === 'organization') {
            // Guard: an organisation_dropdown stores the selected org's UUID
            // as its value. Writing that into orgData.name (or any other org
            // core column) would rename the org to its own id. Instead,
            // capture the selected id for the org-resolution chain and skip
            // the assignment.
            if (isOrgDropdownSourceField(source_field_id)) {
              if (typeof value === 'string' && value && !dropdownSelectedOrgId) {
                dropdownSelectedOrgId = value;
              }
              console.log('[AppProcessor] Skipped org core assignment from organisation_dropdown source:', { target_field, source_field_id, captured_org_id: value });
              continue;
            }
            orgData[target_field] = coerceCoreFieldValue('organization', target_field, value);
          }
        } else if (target_type === 'custom') {
          const prefField = prefFieldMap.get(target_field);
          const targetMap = target_entity === 'organization' ? orgCustomFieldsMap : memberCustomFieldsMap;
          const targetClearSet = target_entity === 'organization' ? orgCustomFieldsToClear : memberCustomFieldsToClear;
          if (isExplicitlyClearedValue(value)) {
            // Explicit clear: drop any aggregated value and queue the existing
            // DB row for deletion at upsert time.
            targetMap.delete(target_field);
            targetClearSet.add(target_field);
          } else {
            targetClearSet.delete(target_field);
            addCustomFieldValue(targetMap, target_field, value, prefField);
          }
        }
      }
    } else {
      // Fallback: Use legacy core_field_mapping and custom_field_id on fields
      for (const field of fields) {
        const fieldKeyPresent = Object.prototype.hasOwnProperty.call(form_values, field.id);
        const value = form_values[field.id];

        // Check if this is a boolean member core field - allow empty/false through
        let isMemberBooleanField = false;
        if (field.core_field_mapping) {
          const [entity, fieldName] = field.core_field_mapping.split('.');
          isMemberBooleanField = entity === 'member' && BOOLEAN_CORE_FIELDS.includes(fieldName);
        }

        const isEmptyForCore = !isMemberBooleanField && (value === undefined || value === null || value === '');

        if (field.core_field_mapping && !isEmptyForCore) {
          const [entity, fieldName] = field.core_field_mapping.split('.');
          if (entity === 'member') {
            // Guard: a member_dropdown stores the selected member's UUID.
            // Writing it into a member core column would rename the member
            // to its own id. Capture the id for the member-resolution chain
            // and skip.
            if (field.type === 'member_dropdown') {
              if (typeof value === 'string' && value && !dropdownSelectedMemberId) {
                dropdownSelectedMemberId = value;
              }
              console.log('[AppProcessor] Skipped member core assignment from member_dropdown source (legacy fallback):', { fieldName, field_id: field.id, captured_member_id: value });
            } else if (hasAssignableValue(fieldName, value)) {
              memberData[fieldName] = coerceCoreFieldValue('member', fieldName, value);
            }
          } else if (entity === 'organization') {
            // Guard: an organisation_dropdown stores the org's UUID. Writing
            // it into an org core column would rename the org to its own id.
            // Capture the id for the org-resolution chain and skip.
            if (field.type === 'organisation_dropdown') {
              if (typeof value === 'string' && value && !dropdownSelectedOrgId) {
                dropdownSelectedOrgId = value;
              }
              console.log('[AppProcessor] Skipped org core assignment from organisation_dropdown source (legacy fallback):', { fieldName, field_id: field.id, captured_org_id: value });
            } else {
              orgData[fieldName] = coerceCoreFieldValue('organization', fieldName, value);
            }
          }
        }

        // Custom-field handling: distinguish absent (no-op) from explicitly
        // cleared (delete existing pref value at upsert time). The form key
        // is always present when the form rendered the field, so absent
        // means the form configuration itself doesn't include this field.
        if (field.custom_field_id) {
          const customField = prefFieldMap.get(field.custom_field_id);
          if (customField) {
            if (!fieldKeyPresent) continue;
            const targetMap = customField.entity_scope === 'organization' ? orgCustomFieldsMap : memberCustomFieldsMap;
            const targetClearSet = customField.entity_scope === 'organization' ? orgCustomFieldsToClear : memberCustomFieldsToClear;
            if (isExplicitlyClearedValue(value)) {
              targetMap.delete(customField.id);
              targetClearSet.add(customField.id);
            } else {
              targetClearSet.delete(customField.id);
              addCustomFieldValue(targetMap, customField.id, value, customField);
            }
          }
        }
      }
    }

    // Convert maps to arrays for insertion, stringifying values appropriately
    // Centralised value coercion for preference values. Arrays/objects are
    // JSON-encoded; scalars are stringified. Used by convertMapToArray (which
    // feeds the primary-member/org upsert paths) and by the additional-member
    // upsert paths so all four sites store identical shapes — review-noted
    // risk that the additional paths previously bypassed coercion.
    const coercePreferenceValueForStorage = (value) => {
      if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
        return JSON.stringify(value);
      }
      return String(value);
    };

    const convertMapToArray = (map) => {
      const result = [];
      for (const [fieldId, value] of map.entries()) {
        result.push({ field_id: fieldId, value: coercePreferenceValueForStorage(value) });
      }
      return result;
    };

    let memberCustomFields = convertMapToArray(memberCustomFieldsMap);

    // Helper function to process pipeline entry mappings (supports both new array format and legacy object format)
    const processPipelineMappings = (pipelineEntry, targetEntity, dataObj, customFieldsMap, coreFieldMappingConfig, customFieldsToClear) => {
      if (!pipelineEntry) return;
      
      // Check for new mappings array format first
      if (pipelineEntry.mappings && Array.isArray(pipelineEntry.mappings)) {
        console.log(`[AppProcessor] Processing ${targetEntity} from entity_pipelines (new format):`, pipelineEntry.label, 'mappings:', pipelineEntry.mappings.length);
        console.log(`[AppProcessor] ${pipelineEntry.label} mappings detail:`, JSON.stringify(pipelineEntry.mappings, null, 2));
        
        // Log form values for each mapping to debug
        console.log(`[AppProcessor] Form values for ${pipelineEntry.label}:`);
        for (const m of pipelineEntry.mappings) {
          if (m.source_field_id) {
            console.log(`  - ${m.target_field}: form_values["${m.source_field_id}"] = "${form_values[m.source_field_id]}"`);
          }
        }
        
        for (const mapping of pipelineEntry.mappings) {
          if (!mapping.target_field) continue;
          
          // Get value from form or static value
          let value;
          let sourceFieldKeyPresent = false;
          if (mapping.source_type === 'static') {
            value = resolveStaticTodayToken(mapping.static_value);
            sourceFieldKeyPresent = true;
          } else if (mapping.transformation === 'current_date') {
            value = new Date().toISOString().split('T')[0];
            sourceFieldKeyPresent = true;
          } else if (mapping.source_field_id) {
            sourceFieldKeyPresent = Object.prototype.hasOwnProperty.call(form_values, mapping.source_field_id);
            value = form_values[mapping.source_field_id];
            
            if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
              value = value[mapping.source_category_id] !== undefined ? value[mapping.source_category_id] : null;
              console.log(`[AppProcessor] Extracted category ${mapping.source_category_id} from communication_preferences: ${value}`);
            }
          }
          
          // Handle __clear__ sentinel value
          if (value === '__clear__') {
            if (mapping.target_type === 'core') {
              const dbKey = coreFieldMappingConfig[mapping.target_field] || mapping.target_field;
              dataObj[dbKey] = null;
            } else if (mapping.target_type === 'custom') {
              customFieldsMap.delete(mapping.target_field);
              if (customFieldsToClear) customFieldsToClear.add(mapping.target_field);
            }
            continue;
          }
          
          // Apply transformation
          if (value !== undefined && value !== null && mapping.transformation && mapping.transformation !== 'none') {
            value = applyTransformation(value, mapping.transformation);
          }
          
          if (mapping.target_type === 'core') {
            // Map to database field name using config
            const dbKey = coreFieldMappingConfig[mapping.target_field] || mapping.target_field;
            // Guard: an organisation_dropdown stores the selected org's UUID
            // as its value. Writing that into an organisation core column
            // (e.g. name) would rename the org to its own id. Capture the
            // selected id so the existing org-resolution chain picks up the
            // right row, and skip the assignment.
            if (targetEntity === 'organization' && isOrgDropdownSourceField(mapping.source_field_id)) {
              if (typeof value === 'string' && value && !dropdownSelectedOrgId) {
                dropdownSelectedOrgId = value;
              }
              console.log('[AppProcessor] Skipped org core assignment from organisation_dropdown source (pipeline):', { target_field: mapping.target_field, source_field_id: mapping.source_field_id, captured_org_id: value });
              continue;
            }
            // Same guard for member_dropdown -> member core column writes.
            if (targetEntity === 'member' && isMemberDropdownSourceField(mapping.source_field_id)) {
              if (typeof value === 'string' && value && !dropdownSelectedMemberId) {
                dropdownSelectedMemberId = value;
              }
              console.log('[AppProcessor] Skipped member core assignment from member_dropdown source (pipeline):', { target_field: mapping.target_field, source_field_id: mapping.source_field_id, captured_member_id: value });
              continue;
            }
            // Use hasAssignableValue to allow boolean false/empty through for boolean fields
            if (hasAssignableValue(dbKey, value)) {
              // Coerce boolean fields for member entities; for org address-like
              // text columns, normalise object/array values to a multi-line string.
              dataObj[dbKey] = coerceCoreFieldValue(targetEntity, dbKey, value);
            }
          } else if (mapping.target_type === 'custom') {
            // Custom field. Distinguish "absent" (source key not in
            // form_values) from "present and explicitly cleared" (source
            // key present but empty). Absent → skip; cleared → queue
            // delete-on-upsert. Includes prefField metadata in the log so
            // future investigations don't need to re-read the source to
            // figure out why a value was treated as scalar vs aggregated.
            const customFieldId = mapping.target_field;
            const prefField = prefFieldMap.get(customFieldId);
            const isCleared = isExplicitlyClearedValue(value);
            const hasValue = !isCleared && value !== undefined;
            console.log(`[AppProcessor] Custom field mapping: target=${customFieldId}, source=${mapping.source_field_id}, source_key_present=${sourceFieldKeyPresent}, field_type=${prefField?.field_type || 'unknown'}, entity_scope=${prefField?.entity_scope || 'unknown'}, value=${JSON.stringify(value)?.substring(0, 200)}, hasValue=${hasValue}, isCleared=${isCleared}`);
            if (!sourceFieldKeyPresent && value === undefined) {
              console.log(`[AppProcessor] Skipped custom field (absent from submission): ${customFieldId}`);
            } else if (isCleared) {
              customFieldsMap.delete(customFieldId);
              if (customFieldsToClear) customFieldsToClear.add(customFieldId);
              console.log(`[AppProcessor] Queued custom field clear: ${customFieldId}`);
            } else if (hasValue) {
              if (customFieldsToClear) customFieldsToClear.delete(customFieldId);
              addCustomFieldValue(customFieldsMap, customFieldId, value, prefField);
              console.log(`[AppProcessor] Added custom field value: ${customFieldId} = ${JSON.stringify(value)?.substring(0, 200)}`);
            }
          } else if (mapping.target_type === 'communication' && targetEntity === 'member') {
            // Communication preference (marketing list subscription)
            const categoryId = mapping.target_field;
            // If value is an object (communication_preferences map), extract the specific category boolean
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              value = value[categoryId] !== undefined ? value[categoryId] : null;
              console.log(`[AppProcessor] Extracted category ${categoryId} from communication_preferences object: ${value}`);
            }
            // Coerce value to boolean - truthy values mean subscribed
            let isSubscribed = false;
            if (typeof value === 'boolean') {
              isSubscribed = value;
            } else if (typeof value === 'string') {
              const lower = value.toLowerCase().trim();
              isSubscribed = lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on';
            } else if (typeof value === 'number') {
              isSubscribed = value !== 0;
            } else if (value) {
              isSubscribed = true;
            }
            console.log(`[AppProcessor] Communication preference mapping: category=${categoryId}, rawValue=${JSON.stringify(value)}, subscribed=${isSubscribed}`);
            memberCommunicationPrefsMap.set(categoryId, isSubscribed);
          }
        }
        
        return;
      }
      
      // Fall back to legacy field_mappings object format ONLY if no mappings array
      // This ensures we don't process both formats for the same entry
      if (!pipelineEntry.mappings && pipelineEntry.field_mappings) {
        console.log(`[AppProcessor] Processing ${targetEntity} from entity_pipelines (legacy format):`, pipelineEntry.label);
        
        for (const [configKey, dbKey] of Object.entries(coreFieldMappingConfig)) {
          const fieldId = pipelineEntry.field_mappings[configKey];
          if (!fieldId) continue;
          
          if (fieldId === '__clear__') {
            dataObj[dbKey] = null;
          } else {
            const val = form_values[fieldId];
            // Use hasAssignableValue to allow boolean false/empty through for boolean fields
            if (hasAssignableValue(dbKey, val)) {
              // Coerce boolean fields for member entities; coerce address-like
              // values for org entities so object payloads land cleanly in text columns.
              dataObj[dbKey] = coerceCoreFieldValue(targetEntity, dbKey, val);
            }
          }
        }
        
        // Process custom fields from legacy format
        const pipelineCustomMappings = Object.entries(pipelineEntry.field_mappings)
          .filter(([key]) => key.startsWith('custom_'));
        
        for (const [key, fieldId] of pipelineCustomMappings) {
          if (!fieldId) continue;
          const customFieldId = key.replace('custom_', '');
          const prefField = prefFieldMap.get(customFieldId);
          
          if (fieldId === '__clear__') {
            customFieldsMap.delete(customFieldId);
            if (customFieldsToClear) customFieldsToClear.add(customFieldId);
          } else {
            const fieldKeyPresent = Object.prototype.hasOwnProperty.call(form_values, fieldId);
            const val = form_values[fieldId];
            if (!fieldKeyPresent) continue; // absent: skip
            if (isExplicitlyClearedValue(val)) {
              customFieldsMap.delete(customFieldId);
              if (customFieldsToClear) customFieldsToClear.add(customFieldId);
            } else {
              if (customFieldsToClear) customFieldsToClear.delete(customFieldId);
              addCustomFieldValue(customFieldsMap, customFieldId, val, prefField);
            }
          }
        }
      }
    };

    // Process entity_pipelines primary entries if available (new unified system)
    // This supplements/overrides the field_mappings data
    if (memberPipelines.length > 0) {
      // Support both isPrimary (camelCase) and is_primary (snake_case) for compatibility
      const primaryMemberPipeline = memberPipelines.find(m => m.isPrimary || m.is_primary);
      console.log('[AppProcessor] Member pipelines:', memberPipelines.length, 'Primary found:', !!primaryMemberPipeline);
      const memberCoreFieldMappings = {
        'email': 'email',
        'first_name': 'first_name',
        'last_name': 'last_name',
        'phone': 'mobile',
        'job_title': 'job_title',
        'mobile': 'mobile',
        'landline': 'landline',
        'organization_id': 'organization_id',
        'show_in_directory': 'show_in_directory'
      };
      
      processPipelineMappings(primaryMemberPipeline, 'member', memberData, memberCustomFieldsMap, memberCoreFieldMappings, memberCustomFieldsToClear);
      
      // If pipeline has a role_id, use it. null/undefined/'__keep__' all mean
      // "don't change" — leave memberData.role_id unset so update/insert skip it.
      // '__clear__' explicitly sets the role to null. A specific role overwrites.
      const pipelineRoleId = primaryMemberPipeline?.role_id;
      if (pipelineRoleId && pipelineRoleId !== '__keep__') {
        if (pipelineRoleId === '__clear__') {
          memberData.role_id = null;
        } else {
          memberData.role_id = pipelineRoleId;
        }
        console.log('[AppProcessor] Using pipeline role_id:', memberData.role_id);
      } else {
        console.log('[AppProcessor] Pipeline role_id is don\'t-change (keep/null) — preserving existing role on update');
      }

      // Login: only set when pipeline explicitly chose true/false. null/undefined
      // mean "don't change" — leave memberData.login_enabled unset so update skips
      // it; on insert, the create branch supplies its own default.
      if (primaryMemberPipeline && typeof primaryMemberPipeline.login_enabled === 'boolean') {
        memberData.login_enabled = primaryMemberPipeline.login_enabled;
        console.log('[AppProcessor] Using pipeline login_enabled:', memberData.login_enabled);
      } else {
        console.log('[AppProcessor] Pipeline login_enabled is don\'t-change (null) — preserving existing login on update');
      }
      
      // Re-convert custom fields after pipeline processing
      memberCustomFields = convertMapToArray(memberCustomFieldsMap);
    }
    
    // Process entity_pipelines primary organisation if available
    let orgCustomFields = convertMapToArray(orgCustomFieldsMap);
    if (orgPipelines.length > 0) {
      // Support both isPrimary (camelCase) and is_primary (snake_case) for compatibility
      const primaryOrgPipeline = orgPipelines.find(o => o.isPrimary || o.is_primary);
      console.log('[AppProcessor] Org pipelines:', orgPipelines.length, 'Primary found:', !!primaryOrgPipeline);
      if (primaryOrgPipeline) {
        console.log('[AppProcessor] Primary org pipeline mappings:', JSON.stringify(primaryOrgPipeline.mappings, null, 2));
      }
      // Maps the FormBuilder core-field key (UI-facing) to the actual organisation
      // table column. Must include every key surfaced by the FormBuilder UI
      // (ORG_CORE_FIELDS) — otherwise the legacy field_mappings object branch
      // silently drops them, and the new pipeline mappings array path falls back
      // to the raw target_field which can write to the wrong column or none at all.
      const orgCoreFieldMappings = {
        'name': 'name',
        'logo_url': 'logo_url',
        'phone': 'phone',
        'invoicing_email': 'invoicing_email',
        'invoicing_address': 'invoicing_address',
        'website_url': 'website_url',
        // Backward-compat aliases for forms saved with legacy keys.
        // 'email' and 'address' remain on their own columns (both exist).
        'email': 'email',
        'address': 'address',
        // 'website' was a legacy key that mapped to a non-existent column —
        // route it to the modern website_url so older forms keep working.
        'website': 'website_url',
      };
      
      processPipelineMappings(primaryOrgPipeline, 'organization', orgData, orgCustomFieldsMap, orgCoreFieldMappings, orgCustomFieldsToClear);
      
      // Re-convert custom fields after pipeline processing
      orgCustomFields = convertMapToArray(orgCustomFieldsMap);
    }

    console.log('[AppProcessor] Extracted data:', { memberData, orgData, memberCustomFields: memberCustomFields.length, orgCustomFields: orgCustomFields.length, orgCustomFieldsDetail: orgCustomFields });

    let createdOrganizationId = null;
    let newlyCreatedOrgData = null; // Track org data for workflow trigger after custom fields saved
    let createdMemberId = null;

    // Process organization based on orgAction (none/create/update/upsert)
    if (shouldProcessOrganization) {
      // If an organisation_dropdown selection was captured but no explicit
      // prefill_organization_id was supplied, use the dropdown's id as the
      // synthetic prefill so the existing resolution chain targets the right
      // org. When the request already carries an explicit prefill that
      // disagrees, prefer the explicit one and leave a processing note.
      let effectivePrefillOrgId = prefill_organization_id || null;
      if (dropdownSelectedOrgId) {
        if (!effectivePrefillOrgId) {
          effectivePrefillOrgId = dropdownSelectedOrgId;
          console.log('[AppProcessor] Using organisation_dropdown selection as effective prefill_organization_id:', dropdownSelectedOrgId);
        } else if (effectivePrefillOrgId !== dropdownSelectedOrgId) {
          addProcessingNote({
            level: 'info',
            stage: 'organization_resolve',
            message: 'organisation_dropdown selection ignored: explicit prefill_organization_id takes precedence.',
            dropdown_org_id: dropdownSelectedOrgId,
            prefill_organization_id: effectivePrefillOrgId,
          });
          console.warn('[AppProcessor] Dropdown org id disagrees with explicit prefill_organization_id; using explicit:', { dropdown: dropdownSelectedOrgId, prefill: effectivePrefillOrgId });
        }
      }
      console.log('[AppProcessor] Org processing enabled. Action:', orgAction, 'OrgData:', orgData, 'PrefillOrgId:', effectivePrefillOrgId);
      
      // Find existing organisation. Resolution order — first match wins:
      //   1. prefill_organization_id (URL-prefilled / passed by caller)
      //   2. The organisation_id already stamped on the form_submission row
      //      (set by FormView when the submitter was authenticated/contextualised)
      //   3. The organisation_id of the resolved member (prefill_member_id, or
      //      tenant-scoped lookup by memberData.email) — useful when an
      //      authenticated member submits a form with org core-field mappings
      //      but no explicit organisation context was forwarded.
      //   4. Case-insensitive name match against orgData.name.
      // Each step uses .maybeSingle() so a missing row is treated as "not found"
      // rather than an error (the previous .single() variants surfaced misleading
      // errors and short-circuited the search).
      let existingOrg = null;
      let orgResolutionMethod = null;
      
      if (effectivePrefillOrgId) {
        const { data: foundOrg } = await supabase
          .from('organization')
          .select('*')
          .eq('id', effectivePrefillOrgId)
          .maybeSingle();
        if (foundOrg) {
          existingOrg = foundOrg;
          orgResolutionMethod = effectivePrefillOrgId === dropdownSelectedOrgId && !prefill_organization_id
            ? 'organisation_dropdown_selection'
            : 'prefill_organization_id';
        }
        console.log('[AppProcessor] Found org by prefill ID:', existingOrg?.id);
      }
      
      if (!existingOrg && submission_id) {
        const { data: subRow } = await supabase
          .from('form_submission')
          .select('organization_id')
          .eq('id', submission_id)
          .maybeSingle();
        if (subRow?.organization_id) {
          const { data: foundOrg } = await supabase
            .from('organization')
            .select('*')
            .eq('id', subRow.organization_id)
            .maybeSingle();
          if (foundOrg) {
            existingOrg = foundOrg;
            orgResolutionMethod = 'form_submission.organization_id';
            console.log('[AppProcessor] Found org via form_submission.organization_id:', existingOrg.id);
          }
        }
      }
      
      if (!existingOrg) {
        // Try via the resolved member (prefill_member_id, the member_dropdown
        // selection, or by email within tenant).
        let resolvedMember = null;
        const memberIdForOrgLookup = prefill_member_id || dropdownSelectedMemberId || null;
        if (memberIdForOrgLookup) {
          const { data: m } = await supabase
            .from('member')
            .select('id, organization_id')
            .eq('id', memberIdForOrgLookup)
            .maybeSingle();
          resolvedMember = m;
        } else if (memberData?.email) {
          let q = supabase
            .from('member')
            .select('id, organization_id')
            .ilike('email', memberData.email);
          if (tenant_id) q = q.eq('tenant_id', tenant_id);
          const { data: m } = await q.limit(1).maybeSingle();
          resolvedMember = m;
        }
        if (resolvedMember?.organization_id) {
          const { data: foundOrg } = await supabase
            .from('organization')
            .select('*')
            .eq('id', resolvedMember.organization_id)
            .maybeSingle();
          if (foundOrg) {
            existingOrg = foundOrg;
            orgResolutionMethod = 'resolved_member.organization_id';
            console.log('[AppProcessor] Found org via resolved member:', existingOrg.id);
          }
        }
      }
      
      if (!existingOrg && orgData.name) {
        const { data: foundOrg } = await supabase
          .from('organization')
          .select('*')
          .ilike('name', orgData.name)
          .limit(1)
          .maybeSingle();
        if (foundOrg) {
          existingOrg = foundOrg;
          orgResolutionMethod = 'org_name_match';
        }
        console.log('[AppProcessor] Found org by name:', existingOrg?.id);
      }
      
      if (existingOrg) {
        console.log('[AppProcessor] Resolved existing org via:', orgResolutionMethod, '->', existingOrg.id);
      }
      
      if (existingOrg) {
        // Organization exists
        if (orgAction === 'create') {
          // Create mode but org exists - skip creation, use existing ID
          console.log('[AppProcessor] Organization exists, skipping create (create mode):', existingOrg.id);
          createdOrganizationId = existingOrg.id;
        } else if (orgAction === 'update' || orgAction === 'upsert') {
          // Update existing organization - dynamically include all orgData fields that were explicitly set
          const allowedOrgColumns = ['name', 'logo_url', 'invoicing_email', 'phone', 'website_url', 'invoicing_address', 'email', 'address'];
          const orgUpdateData = {};
          for (const [key, value] of Object.entries(orgData)) {
            if (!allowedOrgColumns.includes(key)) continue;
            if (value === null) {
              orgUpdateData[key] = null;
            } else if (value !== undefined && value !== '') {
              // Defence in depth: even if an upstream code path missed it, coerce
              // file-upload payloads to their URL string and address-like object
              // values to a multi-line string before writing.
              orgUpdateData[key] = coerceCoreFieldValue('organization', key, value);
            }
          }
          
          // Set tenant_id if org has none and we have a valid tenant_id (from public form)
          if (tenant_id && !existingOrg.tenant_id) {
            orgUpdateData.tenant_id = tenant_id;
          }
          
          if (Object.keys(orgUpdateData).length > 0) {
            console.log('[AppProcessor] Org update data:', orgUpdateData);
            const { error: orgUpdateError } = await supabase
              .from('organization')
              .update(orgUpdateData)
              .eq('id', existingOrg.id);
            
            if (orgUpdateError) {
              console.error('[AppProcessor] Failed to update organization:', orgUpdateError);
              return res.status(500).json({ error: `Failed to update organisation: ${orgUpdateError.message}` });
            }
            console.log('[AppProcessor] Updated organization:', existingOrg.id);
          } else {
            console.log('[AppProcessor] No org core fields to update (orgData was empty):', orgData);
          }
          createdOrganizationId = existingOrg.id;
        }
      } else {
        // Organization does not exist via any of the resolution strategies above.
        if (orgAction === 'update') {
          // Update mode and we couldn't find an org to update — emit a high-signal
          // diagnostic so this skip is observable in production logs and
          // also append a structured note so the form_submission viewer
          // surfaces the skip. Includes everything we tried for postmortem.
          addProcessingNote({
            level: 'warn',
            stage: 'organization_resolve',
            message: 'Organisation update skipped — no existing organisation could be resolved.',
          });
          console.warn('[AppProcessor] Organisation update SKIPPED — no existing org could be resolved.', {
            submission_id: submission_id || null,
            form_id: form_id || null,
            tenant_id: tenant_id || null,
            prefill_organization_id: prefill_organization_id || null,
            effective_prefill_organization_id: effectivePrefillOrgId || null,
            dropdown_selected_org_id: dropdownSelectedOrgId || null,
            prefill_member_id: prefill_member_id || null,
            member_email_for_lookup: memberData?.email || null,
            org_data_name: orgData.name || null,
            org_data_keys: Object.keys(orgData),
          });
          createdOrganizationId = effectivePrefillOrgId || null;
        } else if (orgAction === 'create' || orgAction === 'upsert') {
          // Create new organization - require name
          if (!orgData.name) {
            console.error('[AppProcessor] Organization creation requested but no organization.name field mapped');
            return res.status(400).json({ 
              error: 'Organisation name is required. Please map a form field to "Organisation Name" in the Submission Settings.',
              code: 'MISSING_ORG_NAME'
            });
          }
          
          const orgInsertData = {
            name: orgData.name,
            logo_url: orgData.logo_url || null,
            invoicing_email: orgData.invoicing_email || null,
            invoicing_address: orgData.invoicing_address || null,
            phone: orgData.phone || null,
            website_url: orgData.website_url || null,
            created_at: new Date().toISOString()
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            orgInsertData.tenant_id = tenant_id;
          }

          console.log('[AppProcessor] Creating organization with data:', orgInsertData);

          const { data: newOrg, error: orgError } = await supabase
            .from('organization')
            .insert(orgInsertData)
            .select()
            .single();

          if (orgError) {
            console.error('[AppProcessor] Failed to create organization:', orgError);
            return res.status(500).json({ error: `Failed to create organisation: ${orgError.message}` });
          }

          createdOrganizationId = newOrg.id;
          newlyCreatedOrgData = newOrg; // Track for workflow trigger after custom fields are saved
          console.log('[AppProcessor] Created organization:', createdOrganizationId);
        }
      }

      // Save/update org custom fields if we have an org ID. Uses the
      // checked upsertPreferenceValue helper so RLS denials, FK violations,
      // type mismatches, and trigger failures surface in processing_notes
      // instead of being swallowed (the long-standing bug fixed here).
      if (createdOrganizationId && orgCustomFields.length > 0) {
        for (const cf of orgCustomFields) {
          await upsertPreferenceValue({
            table: 'organization_preference_value',
            parentColumn: 'organization_id',
            parentId: createdOrganizationId,
            fieldId: cf.field_id,
            value: cf.value,
            entityScope: 'organization',
            prefField: prefFieldMap.get(cf.field_id),
          });
        }
      }

      // Apply explicit clears for org custom fields that the user emptied
      // on this submission (only meaningful on update flows; harmless when
      // the row doesn't exist).
      if (createdOrganizationId && orgCustomFieldsToClear.size > 0) {
        for (const fieldId of orgCustomFieldsToClear) {
          await clearPreferenceValue({
            table: 'organization_preference_value',
            parentColumn: 'organization_id',
            parentId: createdOrganizationId,
            fieldId,
            entityScope: 'organization',
            prefField: prefFieldMap.get(fieldId),
          });
        }
      }
      
      // Trigger workflow evaluation for newly created organization (AFTER custom fields are saved)
      // Must await to ensure completion before Vercel terminates the function
      if (newlyCreatedOrgData) {
        const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
        console.log('[AppProcessor] Triggering workflows for organization:', newlyCreatedOrgData.id, 'tenant_id:', newlyCreatedOrgData.tenant_id);
        try {
          await triggerWorkflows('organization', newlyCreatedOrgData.id, null, newlyCreatedOrgData, 'record_create', baseUrl, { formSubmissionId: submission_id });
          console.log('[AppProcessor] Workflow evaluation completed for organization:', newlyCreatedOrgData.id);
        } catch (err) {
          console.error('[AppProcessor] Workflow error for organization:', err);
        }
      }
    }

    // Process member based on memberAction (none/create/update/upsert)
    if (shouldProcessMember) {
      // If a member_dropdown selection was captured but no explicit
      // prefill_member_id was supplied, use the dropdown's id as the
      // synthetic prefill so the existing resolution chain targets the right
      // member. When the request already carries an explicit prefill that
      // disagrees, prefer the explicit one and leave a processing note.
      let effectivePrefillMemberId = prefill_member_id || null;
      if (dropdownSelectedMemberId) {
        if (!effectivePrefillMemberId) {
          effectivePrefillMemberId = dropdownSelectedMemberId;
          console.log('[AppProcessor] Using member_dropdown selection as effective prefill_member_id:', dropdownSelectedMemberId);
        } else if (effectivePrefillMemberId !== dropdownSelectedMemberId) {
          addProcessingNote({
            level: 'info',
            stage: 'member_resolve',
            message: 'member_dropdown selection ignored: explicit prefill_member_id takes precedence.',
            dropdown_member_id: dropdownSelectedMemberId,
            prefill_member_id: effectivePrefillMemberId,
          });
          console.warn('[AppProcessor] Dropdown member id disagrees with explicit prefill_member_id; using explicit:', { dropdown: dropdownSelectedMemberId, prefill: effectivePrefillMemberId });
        }
      }
      console.log('[AppProcessor] Member processing enabled. Action:', memberAction, 'MemberData:', memberData, 'PrefillMemberId:', effectivePrefillMemberId);
      
      // Find existing member: by prefill_member_id first, then by email
      let existingMember = null;
      
      if (effectivePrefillMemberId) {
        const { data: foundMember } = await supabase
          .from('member')
          .select('*')
          .eq('id', effectivePrefillMemberId)
          .single();
        existingMember = foundMember;
        console.log('[AppProcessor] Found member by prefill ID:', existingMember?.id);
      } else if (memberData.email) {
        let emailQuery = supabase
          .from('member')
          .select('*')
          .ilike('email', memberData.email);
        if (tenant_id) {
          emailQuery = emailQuery.eq('tenant_id', tenant_id);
        }
        const { data: foundMember } = await emailQuery.limit(1).single();
        existingMember = foundMember;
        console.log('[AppProcessor] Found member by email:', existingMember?.id, tenant_id ? `(tenant: ${tenant_id})` : '(no tenant filter)');
      }
      
      if (existingMember) {
        // Member exists
        if (memberAction === 'create') {
          // Create mode but member exists - skip creation, use existing ID
          console.log('[AppProcessor] Member exists, skipping create (create mode):', existingMember.id);
          createdMemberId = existingMember.id;
        } else if (memberAction === 'update' || memberAction === 'upsert') {
          // Update existing member
          // Note: member table doesn't have phone column
          const memberUpdateData = {};
          if (memberData.email) memberUpdateData.email = memberData.email;
          if (memberData.first_name) memberUpdateData.first_name = memberData.first_name;
          if (memberData.last_name) memberUpdateData.last_name = memberData.last_name;
          if (memberData.job_title) memberUpdateData.job_title = memberData.job_title;
          if (memberData.mobile) memberUpdateData.mobile = memberData.mobile;
          if (memberData.landline) memberUpdateData.landline = memberData.landline;
          
          // Determine effective role_id from multiple sources
          const effectiveRoleIdForUpdate = memberData.role_id !== undefined ? memberData.role_id : role_id;
          console.log('[AppProcessor] Role ID resolution (update):', { 
            memberData_role_id: memberData.role_id, 
            role_id_param: role_id, 
            effectiveRoleIdForUpdate 
          });

          // Cross-tenant guard: if a real role_id is about to be written to an
          // existing member, verify it belongs to that member's tenant. Hard
          // fail on mismatch — never silently corrupt member.role_id.
          if (effectiveRoleIdForUpdate) {
            const memberTenantForCheck = existingMember.tenant_id || tenant_id || null;
            const tenantCheck = await validateRoleTenant(supabase, effectiveRoleIdForUpdate, memberTenantForCheck);
            if (!tenantCheck.ok) {
              return res.status(500).json({
                error: tenantCheck.message,
                code: 'ROLE_TENANT_MISMATCH'
              });
            }
          }

          // Check capacity when:
          // 1. Role is being changed (different role_id)
          // 2. Organization is being changed AND member has/will have a role with max_members
          const targetOrgId = createdOrganizationId || memberData.organization_id || prefill_organization_id || existingMember.organization_id;
          const roleToCheckCapacity = effectiveRoleIdForUpdate !== undefined ? effectiveRoleIdForUpdate : existingMember.role_id;
          
          const roleIsChanging = effectiveRoleIdForUpdate !== undefined && 
            effectiveRoleIdForUpdate !== null && 
            effectiveRoleIdForUpdate !== existingMember.role_id;
          const orgIsChanging = targetOrgId && existingMember.organization_id && 
            targetOrgId !== existingMember.organization_id;
          
          // Check capacity if role or org is changing (and member has/will have a role)
          if (roleToCheckCapacity && roleToCheckCapacity !== null && (roleIsChanging || orgIsChanging)) {
            console.log('[AppProcessor] Checking capacity for primary member update:', { 
              roleIsChanging,
              orgIsChanging,
              from: { role: existingMember.role_id, org: existingMember.organization_id },
              to: { role: roleToCheckCapacity, org: targetOrgId }
            });
            const capacityCheck = await checkRoleCapacity(supabase, roleToCheckCapacity, targetOrgId);
            console.log('[AppProcessor] Role capacity check result (update):', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                return res.status(400).json({ 
                  error: `Cannot assign this role without an organization.`,
                  code: 'ROLE_CAPACITY_MISSING_ORG'
                });
              }
              return res.status(400).json({ 
                error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                code: 'ROLE_CAPACITY_EXCEEDED'
              });
            }
          }
          
          if (effectiveRoleIdForUpdate !== undefined) {
            memberUpdateData.role_id = effectiveRoleIdForUpdate;
          }
          
          // Add login_enabled from pipeline config if specified
          if (memberData.login_enabled !== undefined) {
            memberUpdateData.login_enabled = memberData.login_enabled;
            console.log('[AppProcessor] Adding pipeline login_enabled to member update:', memberData.login_enabled);
          }
          
          // Add show_in_directory from pipeline config if specified
          if (memberData.show_in_directory !== undefined) {
            memberUpdateData.show_in_directory = memberData.show_in_directory;
            console.log('[AppProcessor] Adding pipeline show_in_directory to member update:', memberData.show_in_directory);
          }
          
          // Handle full_name parsing if provided (parse into first_name/last_name since member table doesn't have full_name column)
          if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
            const nameParts = memberData.full_name.trim().split(/\s+/);
            memberUpdateData.first_name = nameParts[0] || '';
            memberUpdateData.last_name = nameParts.slice(1).join(' ') || '';
          }
          
          // Use createdOrganizationId if org was created/updated, otherwise use prefill_organization_id
          const orgIdToLink = createdOrganizationId || prefill_organization_id;
          if (orgIdToLink) memberUpdateData.organization_id = orgIdToLink;
          
          if (Object.keys(memberUpdateData).length > 0) {
            const { error: memberUpdateError } = await supabase
              .from('member')
              .update(memberUpdateData)
              .eq('id', existingMember.id);
            
            if (memberUpdateError) {
              console.error('[AppProcessor] Failed to update member:', memberUpdateError);
              return res.status(500).json({ error: `Failed to update member: ${memberUpdateError.message}` });
            }
            console.log('[AppProcessor] Updated member:', existingMember.id);
          }
          createdMemberId = existingMember.id;
        }
      } else {
        // Member does not exist
        if (memberAction === 'update') {
          // Update mode but member doesn't exist - skip
          console.log('[AppProcessor] Member not found, skipping update (update mode)');
        } else if (memberAction === 'create' || memberAction === 'upsert') {
          // Create new member - require email
          if (!memberData.email) {
            console.error('[AppProcessor] Member creation requested but no member.email field mapped');
            return res.status(400).json({ 
              error: 'Member email is required. Please map a form field to "Email" (target: member.email) in the Submission Settings.',
              code: 'MISSING_MEMBER_EMAIL'
            });
          }
          
          if (memberData.full_name && !memberData.first_name && !memberData.last_name) {
            const nameParts = memberData.full_name.trim().split(/\s+/);
            memberData.first_name = nameParts[0] || '';
            memberData.last_name = nameParts.slice(1).join(' ') || '';
          }
          
          // Use createdOrganizationId if org was created/updated, 
          // then memberData.organization_id (from form dropdown), then prefill_organization_id
          const orgIdForNewMember = createdOrganizationId || memberData.organization_id || prefill_organization_id || null;
          console.log('[AppProcessor] Resolved orgIdForNewMember:', orgIdForNewMember);

          // Note: member table doesn't have phone or status columns
          const memberInsertData = {
            email: memberData.email,
            first_name: memberData.first_name || '',
            last_name: memberData.last_name || '',
            organization_id: orgIdForNewMember,
            login_enabled: memberData.login_enabled !== undefined ? memberData.login_enabled : false,
            show_in_directory: memberData.show_in_directory !== undefined ? memberData.show_in_directory : true
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            memberInsertData.tenant_id = tenant_id;
          }
          
          // Add job_title only if provided (it's a valid column)
          if (memberData.job_title) memberInsertData.job_title = memberData.job_title;
          // Add mobile and landline if provided
          if (memberData.mobile) memberInsertData.mobile = memberData.mobile;
          if (memberData.landline) memberInsertData.landline = memberData.landline;

          // Domain bypass guest flag: when the member's email domain doesn't
          // match the org's verified domains AND the org has Guest Access on,
          // stamp is_guest + guest_expires_at so the team card surfaces this
          // member under Guest Access. When the email field opted into
          // `validate_org_domain` and guest fallback isn't available (tenant
          // master switch off, or org has guest access off), reject the
          // submission instead of silently creating a non-guest member.
          const domainCtx = await resolveDomainGuestContext(
            supabase,
            orgIdForNewMember,
            memberData.email
          );
          if (domainCtx?.guestStamp) {
            memberInsertData.is_guest = domainCtx.guestStamp.is_guest;
            memberInsertData.guest_expires_at = domainCtx.guestStamp.guest_expires_at;
            console.log('[AppProcessor] Domain mismatch with guest access enabled — stamping member as guest:', {
              organization_id: orgIdForNewMember,
              guest_expires_at: domainCtx.guestStamp.guest_expires_at,
            });
          } else if (
            domainCtx &&
            !domainCtx.domainMatches &&
            domainCtx.verifiedDomains.length > 0 &&
            formHasMemberEmailDomainRestriction(fields, field_mappings, memberPipelines)
          ) {
            const domainList = domainCtx.verifiedDomains.join(', ');
            const message = `Email domain must be one of: ${domainList}`;
            console.warn('[AppProcessor] Rejecting new member: email domain not in verified list and guest fallback unavailable:', {
              organization_id: orgIdForNewMember,
              email_domain: domainCtx.emailDomain,
              verified_domains: domainCtx.verifiedDomains,
            });
            return res.status(400).json({
              error: message,
              code: 'EMAIL_DOMAIN_NOT_ALLOWED',
            });
          }
          
          // Resolve role_id with explicit precedence. The pipeline writes
          // memberData.role_id only for real UUIDs or explicit __clear__
          // (null); __keep__ leaves it undefined. The request-level role_id
          // is form-conditional logic — callers pass `null` when none, so a
          // truthy check correctly treats null as "no conditional role".
          // On create only, fall back to the tenant's default role; explicit
          // pipeline-clear (null) is preserved.
          let effectiveRoleId;
          let roleSource;
          if (memberData.role_id !== undefined) {
            effectiveRoleId = memberData.role_id;
            if (effectiveRoleId === null) {
              roleSource = 'pipeline-clear';
              console.log('[AppProcessor] Pipeline explicitly cleared role on new member (role_id will be NULL)');
            } else {
              roleSource = 'pipeline-configured';
              console.log('[AppProcessor] Applied pipeline-configured role to new member:', effectiveRoleId);
            }
          } else if (role_id) {
            effectiveRoleId = role_id;
            roleSource = 'form-conditional';
            console.log('[AppProcessor] Applied form-conditional role to new member:', effectiveRoleId);
          } else {
            const tenantForDefault = memberInsertData.tenant_id || tenant_id || null;
            const { role: tenantDefaultRole, error: defaultLookupError } = await resolveTenantDefaultRole(supabase, tenantForDefault);
            if (defaultLookupError) {
              effectiveRoleId = undefined;
              roleSource = 'lookup-error';
              console.error('[AppProcessor] Tenant default role lookup failed; new member created without role:', { tenant_id: tenantForDefault, error: defaultLookupError });
            } else if (tenantDefaultRole) {
              effectiveRoleId = tenantDefaultRole.id;
              roleSource = 'tenant-default';
              console.log('[AppProcessor] Applied tenant default role to new member:', { role_id: tenantDefaultRole.id, role_name: tenantDefaultRole.name, tenant_id: tenantForDefault });
            } else {
              effectiveRoleId = undefined;
              roleSource = 'none';
              console.warn('[AppProcessor] No default role configured for tenant; new member created without role. Set one in /RoleManagement.', { tenant_id: tenantForDefault });
            }
          }
          console.log('[AppProcessor] Role ID resolution:', {
            memberData_role_id: memberData.role_id,
            role_id_param: role_id,
            effectiveRoleId,
            roleSource,
          });

          // Add role_id if we have one from any source
          if (effectiveRoleId !== undefined) {
            // Cross-tenant guard: a non-null role_id about to be written onto
            // a brand-new member must belong to that member's tenant. Hard
            // fail on mismatch — see validateRoleTenant rationale.
            if (effectiveRoleId) {
              const tenantCheck = await validateRoleTenant(supabase, effectiveRoleId, memberInsertData.tenant_id || tenant_id || null);
              if (!tenantCheck.ok) {
                return res.status(500).json({
                  error: tenantCheck.message,
                  code: 'ROLE_TENANT_MISMATCH'
                });
              }
            }

            memberInsertData.role_id = effectiveRoleId;
            console.log('[AppProcessor] Adding role_id to member insert:', effectiveRoleId, `(source: ${roleSource})`);

            // Check role capacity before inserting member (per-organization)
            if (effectiveRoleId !== null) {
              const capacityCheck = await checkRoleCapacity(supabase, effectiveRoleId, orgIdForNewMember);
              console.log('[AppProcessor] Role capacity check result:', JSON.stringify(capacityCheck));
              if (!capacityCheck.hasCapacity) {
                if (capacityCheck.missingOrgContext) {
                  console.error('[AppProcessor] Cannot check capacity: organization context required');
                  return res.status(400).json({ 
                    error: `Cannot assign this role without an organization.`,
                    code: 'ROLE_CAPACITY_MISSING_ORG'
                  });
                }
                console.error('[AppProcessor] Role at max capacity:', capacityCheck.currentCount, '/', capacityCheck.maxMembers);
                return res.status(400).json({ 
                  error: `This role has reached its maximum capacity of ${capacityCheck.maxMembers} members for this organization. Please contact an administrator.`,
                  code: 'ROLE_CAPACITY_EXCEEDED'
                });
              }
            }
          } else {
            console.log('[AppProcessor] No role_id from any source');
          }
          
          console.log('[AppProcessor] login_enabled for member insert:', memberInsertData.login_enabled);

          console.log('[AppProcessor] Final memberInsertData:', JSON.stringify(memberInsertData));

          const { data: newMember, error: memberError } = await supabase
            .from('member')
            .insert(memberInsertData)
            .select()
            .single();

          if (memberError) {
            console.error('[AppProcessor] Failed to create member:', memberError);
            return res.status(500).json({ error: `Failed to create member: ${memberError.message}` });
          }

          createdMemberId = newMember.id;
          console.log('[AppProcessor] Created member:', createdMemberId);
          
          // Trigger workflows for new member creation
          // Must await to ensure completion before Vercel terminates the function
          const baseUrl = process.env.APP_URL || `https://${req.headers.host}`;
          try {
            await triggerWorkflows('member', createdMemberId, null, newMember, 'record_create', baseUrl, { formSubmissionId: submission_id });
            console.log('[AppProcessor] Workflow evaluation completed for member:', createdMemberId);
          } catch (err) {
            console.error('[AppProcessor] Workflow error:', err);
          }
          console.log('[AppProcessor] Triggered workflows for new member:', createdMemberId);

          // Guest signup approval alerts: when this member was stamped as a
          // guest (domain mismatch + guest access enabled), email the tenant
          // roles configured on the Guest Access card with one-click
          // Approve/Deny links. Non-fatal — never blocks member creation.
          if (domainCtx?.guestStamp) {
            try {
              await notifyGuestSignup({
                client: supabase,
                tenantId: newMember.tenant_id || tenant_id || null,
                member: newMember,
                organizationId: orgIdForNewMember,
                organizationName: domainCtx?.organizationName || null,
                guestExpiresAt: domainCtx.guestStamp.guest_expires_at,
              });
            } catch (notifyErr) {
              console.error('[AppProcessor] Guest signup notification error:', notifyErr);
            }
          }

        }
      }

      // Save/update member custom fields. Uses upsertPreferenceValue so
      // any failure (RLS denial, FK violation, type mismatch, trigger
      // error) lands in processing_notes instead of being silently
      // dropped — the long-standing bug fixed by task 653.
      for (const cf of memberCustomFields) {
        await upsertPreferenceValue({
          table: 'member_preference_value',
          parentColumn: 'member_id',
          parentId: createdMemberId,
          fieldId: cf.field_id,
          value: cf.value,
          entityScope: 'member',
          prefField: prefFieldMap.get(cf.field_id),
        });
      }

      // Apply explicit clears for member custom fields the user emptied
      // on this submission.
      if (memberCustomFieldsToClear.size > 0) {
        for (const fieldId of memberCustomFieldsToClear) {
          await clearPreferenceValue({
            table: 'member_preference_value',
            parentColumn: 'member_id',
            parentId: createdMemberId,
            fieldId,
            entityScope: 'member',
            prefField: prefFieldMap.get(fieldId),
          });
        }
      }

      // Handle category_multiselect field values - save to member_resource_category table
      // Uses diff-based approach: only add/remove what changed
      const categoryFields = fields.filter(f => f.type === 'category_multiselect' || f.type === 'resource_categories');
      if (createdMemberId && categoryFields.length > 0) {
        // Get all resource categories to map subcategory names to category IDs
        const { data: resourceCategories } = await supabase
          .from('resource_category')
          .select('id, name, subcategories')
          .eq('is_active', true);
        
        // Parse subcategories that might be stored as JSON strings and normalize
        const categoryMap = new Map((resourceCategories || []).map(c => {
          let subcats = c.subcategories || [];
          // Handle case where subcategories is stored as JSON string
          if (typeof subcats === 'string') {
            try {
              subcats = JSON.parse(subcats);
            } catch {
              subcats = [];
            }
          }
          // Ensure it's an array and trim all values
          if (!Array.isArray(subcats)) subcats = [];
          subcats = subcats.map(s => String(s).trim()).filter(Boolean);
          return [c.id, subcats];
        }));
        
        // Build set of category IDs affected by the form fields
        const formCategoryIds = new Set();
        for (const field of categoryFields) {
          const allowedCatIds = field.allowed_category_ids?.length > 0 
            ? field.allowed_category_ids 
            : Array.from(categoryMap.keys());
          allowedCatIds.forEach(id => formCategoryIds.add(id));
        }
        
        // Build list of category selections from all category_multiselect fields
        const categorySelections = [];
        
        for (const field of categoryFields) {
          const selectedValues = form_values[field.id];
          if (!Array.isArray(selectedValues) || selectedValues.length === 0) continue;
          
          // Get allowed categories for this field (or all if not specified)
          const allowedCategoryIds = field.allowed_category_ids?.length > 0 
            ? field.allowed_category_ids 
            : Array.from(categoryMap.keys());
          
          // Map selected subcategory names to their parent category IDs
          for (const subcatName of selectedValues) {
            const normalizedSubcat = String(subcatName).trim();
            // Find which category this subcategory belongs to
            for (const catId of allowedCategoryIds) {
              const subcats = categoryMap.get(catId);
              if (subcats && subcats.includes(normalizedSubcat)) {
                categorySelections.push({
                  category_id: catId,
                  subcategory_name: normalizedSubcat
                });
                break;
              }
            }
          }
        }
        
        // Get current selections for diff-based update (always do this, even for empty submissions)
        const { data: currentSelections } = await supabase
          .from('member_resource_category')
          .select('id, resource_category_id, subcategory_name')
          .eq('member_id', createdMemberId);
        
        const existing = currentSelections || [];
        const currentKeys = new Set(
          existing.map(s => `${s.resource_category_id}|${s.subcategory_name || ''}`)
        );
        const newKeys = new Set(
          categorySelections.map(s => `${s.category_id}|${s.subcategory_name || ''}`)
        );
        
        // Find selections to add
        const toAdd = categorySelections.filter(s => 
          !currentKeys.has(`${s.category_id}|${s.subcategory_name || ''}`)
        );
        
        // Find selections to remove (only remove if in the same categories as the form fields)
        const toRemove = existing.filter(s => 
          formCategoryIds.has(s.resource_category_id) && 
          !newKeys.has(`${s.resource_category_id}|${s.subcategory_name || ''}`)
        );
        
        // Remove old selections (including when form submits empty to clear selections)
        if (toRemove.length > 0) {
          const removeIds = toRemove.map(s => s.id);
          await supabase
            .from('member_resource_category')
            .delete()
            .in('id', removeIds);
          console.log(`[AppProcessor] Removed ${toRemove.length} category selections`);
        }
        
        // Add new selections
        if (toAdd.length > 0) {
          const insertData = toAdd.map(sel => ({
            member_id: createdMemberId,
            resource_category_id: sel.category_id,
            subcategory_name: sel.subcategory_name
          }));
          
          await supabase
            .from('member_resource_category')
            .insert(insertData);
          console.log(`[AppProcessor] Added ${toAdd.length} category selections`);
        }
      }
    }
    
    // Auto-approve membership fees for tier configs with auto_approve_fees enabled
    // Runs AFTER custom fields and category selections are saved so config resolution can match correctly
    if (createdMemberId) {
      try {
        let effectiveTenantId = tenant_id;
        if (!effectiveTenantId) {
          const { data: memberForTenant } = await supabase
            .from('member')
            .select('tenant_id')
            .eq('id', createdMemberId)
            .maybeSingle();
          effectiveTenantId = memberForTenant?.tenant_id;
          if (effectiveTenantId) {
            console.log('[AppProcessor] Resolved tenant_id from member record for auto-approve:', effectiveTenantId);
          }
        }
        if (!effectiveTenantId) {
          console.warn('[AppProcessor] Cannot auto-approve fees: tenant_id could not be resolved for member:', createdMemberId);
        }

        if (effectiveTenantId) {
          const { getConfigForMember, getConfigForOrganisation } = await import('../_lib/membershipConfigResolver.js');

          const memberConfig = await getConfigForMember(effectiveTenantId, createdMemberId);
          if (memberConfig && memberConfig.structure_scope_type === 'member' && memberConfig.auto_approve_fees) {
            const membershipYearLabel = calculateMembershipYearWindow(memberConfig).label;

            const { data: existingInvoicing } = await supabase
              .from('member_membership_invoicing')
              .select('id')
              .eq('tenant_id', effectiveTenantId)
              .eq('member_id', createdMemberId)
              .eq('membership_year', membershipYearLabel)
              .maybeSingle();

            let invoicingErr;
            if (existingInvoicing) {
              const { error } = await supabase
                .from('member_membership_invoicing')
                .update({ fees_approved: true })
                .eq('id', existingInvoicing.id);
              invoicingErr = error;
            } else {
              const { error } = await supabase
                .from('member_membership_invoicing')
                .insert({
                  tenant_id: effectiveTenantId,
                  member_id: createdMemberId,
                  membership_year: membershipYearLabel,
                  fees_approved: true,
                  invoicing_mode: 'manual',
                });
              invoicingErr = error;
            }

            if (invoicingErr) {
              console.error('[AppProcessor] Failed to auto-approve member fees:', invoicingErr);
            } else {
              console.log('[AppProcessor] Auto-approved membership fees for member:', createdMemberId, 'year:', membershipYearLabel);
            }
          }

          const resolvedOrgId = createdOrganizationId || prefill_organization_id;
          if (resolvedOrgId) {
            const orgConfig = await getConfigForOrganisation(effectiveTenantId, resolvedOrgId);
            if (orgConfig && orgConfig.auto_approve_fees) {
              const membershipYearLabel = calculateMembershipYearWindow(orgConfig).label;

              const { data: existingOrgInvoicing } = await supabase
                .from('organisation_membership_invoicing')
                .select('id')
                .eq('tenant_id', effectiveTenantId)
                .eq('organization_id', resolvedOrgId)
                .eq('membership_year', membershipYearLabel)
                .maybeSingle();

              let orgInvoicingErr;
              if (existingOrgInvoicing) {
                const { error } = await supabase
                  .from('organisation_membership_invoicing')
                  .update({ fees_approved: true })
                  .eq('id', existingOrgInvoicing.id);
                orgInvoicingErr = error;
              } else {
                const { error } = await supabase
                  .from('organisation_membership_invoicing')
                  .insert({
                    tenant_id: effectiveTenantId,
                    organization_id: resolvedOrgId,
                    membership_year: membershipYearLabel,
                    fees_approved: true,
                    invoicing_mode: 'manual',
                  });
                orgInvoicingErr = error;
              }

              if (orgInvoicingErr) {
                console.error('[AppProcessor] Failed to auto-approve org fees:', orgInvoicingErr);
              } else {
                console.log('[AppProcessor] Auto-approved membership fees for organisation:', resolvedOrgId, 'year:', membershipYearLabel);
              }
            }
          }
        }
      } catch (autoApproveErr) {
        console.error('[AppProcessor] Auto-approve fees error (non-blocking):', autoApproveErr);
      }
    }

    // Handle communication_preferences field values - save to member_communication_preference table
    // Only update categories that are explicitly included in the form submission
    // Do NOT auto-subscribe missing categories - this preserves existing opt-outs
    // Note: Pipeline mappings (memberCommunicationPrefsMap) run AFTER this and will override these values
    console.log(`[AppProcessor] Communication preferences path #1 check: createdMemberId=${createdMemberId}, fields=${fields ? fields.length + ' fields' : 'null/undefined'}, form_values keys=${form_values ? Object.keys(form_values).length : 'null'}`);
    if (createdMemberId && fields) {
      const commPrefFields = fields.filter(f => f.type === 'communication_preferences');
      console.log(`[AppProcessor] Found ${commPrefFields.length} communication_preferences fields in form fields array`);
      if (commPrefFields.length > 0) {
        console.log(`[AppProcessor] Processing ${commPrefFields.length} communication preference fields`);
        
        const commPrefSelections = [];
        const processedCategoryIds = new Set();
        
        for (const field of commPrefFields) {
          const prefValues = form_values[field.id];
          console.log(`[AppProcessor] Communication preferences field ${field.id} raw value type: ${typeof prefValues}, value:`, JSON.stringify(prefValues));
          if (prefValues && typeof prefValues === 'object') {
            for (const [categoryId, isSubscribed] of Object.entries(prefValues)) {
              if (!processedCategoryIds.has(categoryId)) {
                commPrefSelections.push({
                  category_id: categoryId,
                  is_subscribed: Boolean(isSubscribed)
                });
                processedCategoryIds.add(categoryId);
                console.log(`[AppProcessor] Queued comm pref: category=${categoryId}, subscribed=${Boolean(isSubscribed)}`);
              }
            }
          } else {
            console.warn(`[AppProcessor] Communication preferences field ${field.id} has no valid object value - skipping. Value was: ${JSON.stringify(prefValues)}`);
          }
        }
        
        if (commPrefSelections.length > 0) {
          console.log(`[AppProcessor] Saving ${commPrefSelections.length} communication preferences for member:`, createdMemberId);
          
          for (const pref of commPrefSelections) {
            const { data: existingPref } = await supabase
              .from('member_communication_preference')
              .select('id')
              .eq('member_id', createdMemberId)
              .eq('category_id', pref.category_id)
              .single();
            
            if (existingPref) {
              const { error: updateErr } = await supabase
                .from('member_communication_preference')
                .update({ is_subscribed: pref.is_subscribed })
                .eq('id', existingPref.id);
              if (updateErr) {
                console.error(`[AppProcessor] Failed to update communication preference ${pref.category_id}:`, updateErr);
              } else {
                console.log(`[AppProcessor] Updated comm pref: category=${pref.category_id}, subscribed=${pref.is_subscribed}`);
              }
            } else {
              const { data: insertedPref, error: insertErr } = await supabase
                .from('member_communication_preference')
                .insert({
                  member_id: createdMemberId,
                  category_id: pref.category_id,
                  is_subscribed: pref.is_subscribed,
                  tenant_id: tenant_id
                })
                .select('id');
              if (insertErr) {
                console.error(`[AppProcessor] Failed to insert communication preference ${pref.category_id}:`, JSON.stringify(insertErr));
              } else {
                console.log(`[AppProcessor] Inserted comm pref: id=${insertedPref?.[0]?.id}, category=${pref.category_id}, subscribed=${pref.is_subscribed}`);
              }
            }
          }
          console.log(`[AppProcessor] Completed saving communication preferences for member:`, createdMemberId);
        } else {
          console.log(`[AppProcessor] No communication preference selections extracted from form values`);
        }
      }
    } else {
      console.log(`[AppProcessor] Skipping communication preferences path #1: createdMemberId=${createdMemberId || 'not set'}, fields=${fields ? 'present' : 'missing'}`);
    }

    // Save communication preferences (marketing list subscriptions) for primary member
    if (createdMemberId && memberCommunicationPrefsMap.size > 0) {
      console.log(`[AppProcessor] Saving ${memberCommunicationPrefsMap.size} communication preferences for member ${createdMemberId}`);
      
      for (const [categoryId, isSubscribed] of memberCommunicationPrefsMap) {
        // Check if preference already exists
        const { data: existingPref } = await supabase
          .from('member_communication_preference')
          .select('id, is_subscribed')
          .eq('member_id', createdMemberId)
          .eq('category_id', categoryId)
          .single();
        
        if (existingPref) {
          // Update existing preference only if different
          if (existingPref.is_subscribed !== isSubscribed) {
            await supabase
              .from('member_communication_preference')
              .update({ is_subscribed: isSubscribed, updated_at: new Date().toISOString() })
              .eq('id', existingPref.id);
            console.log(`[AppProcessor] Updated communication preference: category=${categoryId}, subscribed=${isSubscribed}`);
          } else {
            console.log(`[AppProcessor] Communication preference unchanged: category=${categoryId}, subscribed=${isSubscribed}`);
          }
        } else {
          // Create new preference
          const { error: commInsertErr } = await supabase
            .from('member_communication_preference')
            .insert({
              member_id: createdMemberId,
              category_id: categoryId,
              is_subscribed: isSubscribed,
              tenant_id: tenant_id
            });
          if (commInsertErr) {
            console.error(`[AppProcessor] Failed to insert communication preference ${categoryId}:`, JSON.stringify(commInsertErr));
          } else {
            console.log(`[AppProcessor] Created communication preference: category=${categoryId}, subscribed=${isSubscribed}`);
          }
        }
      }
    }

    // Process member pipelines (additional members) with sequential upsert logic
    // Use entity_pipelines.members if available, fall back to legacy additional_member_creations
    // Track processed emails to handle same email appearing in multiple member configs
    // Store full context: {id, role_id, organization_id} to ensure capacity checks use latest data
    const processedEmails = new Map(); // email -> {id, role_id, organization_id}
    
    // If primary member was created/updated, track its email with full context
    // Fetch current state from DB to ensure we have authoritative role_id/organization_id after mutations
    if (createdMemberId) {
      const { data: primaryMemberState } = await supabase
        .from('member')
        .select('id, email, role_id, organization_id')
        .eq('id', createdMemberId)
        .single();
      
      if (primaryMemberState?.email) {
        const primaryEmail = primaryMemberState.email.toLowerCase();
        processedEmails.set(primaryEmail, { 
          id: primaryMemberState.id, 
          role_id: primaryMemberState.role_id, 
          organization_id: primaryMemberState.organization_id 
        });
        console.log('[AppProcessor] Tracking primary member email (from DB):', primaryEmail, '->', { 
          id: primaryMemberState.id, 
          role_id: primaryMemberState.role_id, 
          organization_id: primaryMemberState.organization_id 
        });
      }
    }
    
    // Merge member pipelines: use entity_pipelines.members if available, otherwise legacy additional_member_creations
    // Filter out primary member from pipelines (it was already processed above via field_mappings)
    let memberCreationConfigs = [];
    if (memberPipelines.length > 0) {
      // New system: use entity_pipelines.members, skip primary (it's handled by existing field_mappings logic)
      memberCreationConfigs = memberPipelines.filter(m => !m.isPrimary);
      console.log('[AppProcessor] Using entity_pipelines.members:', memberCreationConfigs.length, 'non-primary entries');
    } else if (additional_member_creations && Array.isArray(additional_member_creations) && additional_member_creations.length > 0) {
      // Legacy system: use additional_member_creations
      memberCreationConfigs = additional_member_creations;
      console.log('[AppProcessor] Using legacy additional_member_creations:', memberCreationConfigs.length);
    }
    
    const additionalMemberIds = [];
    if (memberCreationConfigs.length > 0) {
      console.log('[AppProcessor] Processing member creations:', memberCreationConfigs.length);
      
      for (let configIndex = 0; configIndex < memberCreationConfigs.length; configIndex++) {
        const memberConfig = memberCreationConfigs[configIndex];
        console.log(`[AppProcessor] ======= Processing member config ${configIndex + 1}/${memberCreationConfigs.length}: "${memberConfig.label}" =======`);
        console.log('[AppProcessor] Config mappings:', JSON.stringify(memberConfig.mappings, null, 2));
        
        // Log actual form_values for each source_field_id to debug value issues
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          console.log('[AppProcessor] Form values for this member config:');
          for (const m of memberConfig.mappings) {
            if (m.source_field_id) {
              console.log(`  - ${m.target_field}: form_values["${m.source_field_id}"] = "${form_values[m.source_field_id]}"`);
            }
          }
        }
        
        // Extract email and build data from either new mappings array or legacy field_mappings object
        let memberEmail = null;
        const additionalMemberData = {};
        const additionalCustomFieldsMap = new Map();
        const clearFields = [];
        
        const coreFieldMappings = {
          'email': 'email',
          'first_name': 'first_name',
          'last_name': 'last_name',
          'phone': 'mobile',
          'job_title': 'job_title',
          'mobile': 'mobile',
          'landline': 'landline',
          'organization_id': 'organization_id',
          'show_in_directory': 'show_in_directory'
        };
        
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          // New format: process mappings array
          const emailMapping = memberConfig.mappings.find(m => m.target_field === 'email' && m.target_type === 'core');
          if (!emailMapping) {
            console.log('[AppProcessor] Skipping additional member - no email mapping:', memberConfig.label);
            continue;
          }
          
          // Get email value
          if (emailMapping.source_type === 'static') {
            memberEmail = emailMapping.static_value;
          } else if (emailMapping.source_field_id) {
            memberEmail = form_values[emailMapping.source_field_id];
          }
          
          if (!memberEmail) {
            console.log('[AppProcessor] Skipping additional member - email value is empty:', memberConfig.label);
            continue;
          }
          
          // Process all mappings
          for (const mapping of memberConfig.mappings) {
            if (!mapping.target_field || mapping.target_field === 'email') continue;
            
            let value;
            if (mapping.source_type === 'current_date' || mapping.transformation === 'current_date') {
              value = new Date().toISOString().split('T')[0];
            } else if (mapping.source_type === 'static') {
              value = resolveStaticTodayToken(mapping.static_value);
            } else if (mapping.source_field_id) {
              value = form_values[mapping.source_field_id];
              
              if (mapping.source_category_id && value && typeof value === 'object' && !Array.isArray(value)) {
                value = value[mapping.source_category_id] !== undefined ? value[mapping.source_category_id] : null;
                console.log(`[AppProcessor] Extracted category ${mapping.source_category_id} from communication_preferences: ${value}`);
              }
            }
            
            // Handle __clear__ sentinel value
            if (value === '__clear__') {
              if (mapping.target_type === 'core') {
                const dbKey = coreFieldMappings[mapping.target_field] || mapping.target_field;
                clearFields.push(dbKey);
                additionalMemberData[dbKey] = null;
              } else if (mapping.target_type === 'custom') {
                // Mark custom field for clearing - will be handled in custom field processing
                additionalCustomFieldsMap.set(mapping.target_field, '__clear__');
              }
              continue;
            }
            
            if (value !== undefined && value !== null && mapping.transformation && mapping.transformation !== 'none') {
              value = applyTransformation(value, mapping.transformation);
            }
            
            if (mapping.target_type === 'core') {
              const dbKey = coreFieldMappings[mapping.target_field] || mapping.target_field;
              // Use hasAssignableValue to allow boolean false/empty through for boolean fields
              if (hasAssignableValue(dbKey, value)) {
                // Coerce boolean fields for member entities
                additionalMemberData[dbKey] = coerceBooleanField(dbKey, value);
              }
            } else if (mapping.target_type === 'custom') {
              const prefField = prefFieldMap.get(mapping.target_field);
              if (value !== undefined && value !== null && value !== '') {
                addCustomFieldValue(additionalCustomFieldsMap, mapping.target_field, value, prefField);
              }
            }
          }
        } else if (memberConfig.field_mappings) {
          // Legacy format: process field_mappings object
          if (!memberConfig.field_mappings.email) {
            console.log('[AppProcessor] Skipping additional member - no email mapping:', memberConfig.label);
            continue;
          }
          
          const emailFieldId = memberConfig.field_mappings.email;
          if (emailFieldId === '__clear__') {
            console.log('[AppProcessor] Skipping additional member - email set to clear:', memberConfig.label);
            continue;
          }
          
          memberEmail = form_values[emailFieldId];
          
          if (!memberEmail) {
            console.log('[AppProcessor] Skipping additional member - email value is empty:', memberConfig.label);
            continue;
          }
          
          for (const [configKey, dbKey] of Object.entries(coreFieldMappings)) {
            if (configKey === 'email') continue;
            const fieldId = memberConfig.field_mappings[configKey];
            if (!fieldId) continue;
            
            if (fieldId === '__clear__') {
              clearFields.push(dbKey);
              additionalMemberData[dbKey] = null;
            } else if (hasAssignableValue(dbKey, form_values[fieldId])) {
              // Coerce boolean fields for member entities
              additionalMemberData[dbKey] = coerceBooleanField(dbKey, form_values[fieldId]);
            }
          }
        } else {
          console.log('[AppProcessor] Skipping additional member - no mappings:', memberConfig.label);
          continue;
        }
        
        const normalizedEmail = memberEmail.toLowerCase().trim();
        
        console.log(`[AppProcessor] Built data for "${memberConfig.label}":`, {
          email: normalizedEmail,
          additionalMemberData: { ...additionalMemberData },
          customFieldCount: additionalCustomFieldsMap.size
        });
        
        // Add role_id if specified. null/undefined/'__keep__' all mean "don't change" —
        // leave additionalMemberData.role_id unset so update/insert skip it.
        // '__clear__' explicitly sets the role to null. A specific role overwrites.
        const additionalRoleId = memberConfig.role_id;
        if (additionalRoleId && additionalRoleId !== '__keep__') {
          if (additionalRoleId === '__clear__') {
            additionalMemberData.role_id = null;
            clearFields.push('role_id');
          } else {
            additionalMemberData.role_id = additionalRoleId;
          }
          console.log('[AppProcessor] Additional member role_id:', additionalMemberData.role_id);
        } else {
          console.log('[AppProcessor] Additional member role_id is don\'t-change — preserving existing role on update');
        }

        // Login: only set when member config explicitly chose true/false. null/undefined
        // mean "don't change" — leave additionalMemberData.login_enabled unset so update
        // skips it; on insert, the create branch supplies its own default.
        if (typeof memberConfig.login_enabled === 'boolean') {
          additionalMemberData.login_enabled = memberConfig.login_enabled;
          console.log('[AppProcessor] Additional member login_enabled:', memberConfig.login_enabled);
        } else {
          console.log('[AppProcessor] Additional member login_enabled is don\'t-change — preserving existing login on update');
        }
        
        console.log('[AppProcessor] Processing additional member:', memberConfig.label, 'email:', normalizedEmail, 'data:', additionalMemberData, 'clearFields:', clearFields);
        
        // Check if we've already processed this email in this submission
        // processedEmails stores {id, role_id, organization_id} for in-memory context
        const processedEntry = processedEmails.get(normalizedEmail);
        let existingMemberId = processedEntry?.id || null;
        
        // Use in-memory context if available, otherwise fetch from DB
        let existingMemberRecord = processedEntry ? { 
          id: processedEntry.id, 
          role_id: processedEntry.role_id, 
          organization_id: processedEntry.organization_id 
        } : null;
        
        if (!existingMemberId) {
          // Check if member exists in database (scoped to tenant). Also fetch
          // tenant_id so the cross-tenant role guard below has the member's
          // authoritative tenant when validating any pipeline-supplied role.
          let existingMemberQuery = supabase
            .from('member')
            .select('id, role_id, organization_id, tenant_id')
            .ilike('email', normalizedEmail);
          
          if (tenant_id) {
            existingMemberQuery = existingMemberQuery.eq('tenant_id', tenant_id);
          }
          
          const { data: existingMember } = await existingMemberQuery
            .limit(1)
            .single();
          
          if (existingMember) {
            existingMemberId = existingMember.id;
            existingMemberRecord = existingMember;
            console.log('[AppProcessor] Found existing member in DB:', normalizedEmail, '->', existingMemberId);
          }
        } else {
          console.log('[AppProcessor] Using in-memory context for:', normalizedEmail, existingMemberRecord);
        }
        
        if (existingMemberId) {
          // UPDATE existing member - merge fields, don't clear unless explicitly requested

          // Cross-tenant guard: if the additional-member pipeline carries a
          // real role_id, verify it belongs to this member's tenant before
          // writing it. Hard fail on mismatch — see validateRoleTenant.
          if (additionalMemberData.role_id) {
            const memberTenantForCheck = existingMemberRecord?.tenant_id || tenant_id || null;
            const tenantCheck = await validateRoleTenant(supabase, additionalMemberData.role_id, memberTenantForCheck);
            if (!tenantCheck.ok) {
              return res.status(500).json({
                error: tenantCheck.message,
                code: 'ROLE_TENANT_MISMATCH'
              });
            }
          }
          
          // Resolve organization_id: prefer the UUID from the org pipeline, fall back to prefill
          // The raw form value in additionalMemberData.organization_id may be a name string, not a UUID
          const resolvedAdditionalOrgId = createdOrganizationId || prefill_organization_id || null;
          if (additionalMemberData.organization_id) {
            if (resolvedAdditionalOrgId) {
              additionalMemberData.organization_id = resolvedAdditionalOrgId;
            } else {
              // No resolved UUID available — remove the raw name to prevent DB errors
              delete additionalMemberData.organization_id;
            }
          }
          
          console.log('[AppProcessor] Updating existing member:', existingMemberId, 'with:', additionalMemberData);
          
          // Check role capacity when:
          // 1. Role is being changed (different role_id)
          // 2. Organization is being changed (member moving to new org) AND member has a role with max_members
          // This ensures per-org capacity is enforced both for role changes and org moves
          const effectiveRoleToCheck = additionalMemberData.role_id !== undefined 
            ? additionalMemberData.role_id 
            : existingMemberRecord?.role_id;
          const targetOrgId = additionalMemberData.organization_id || existingMemberRecord?.organization_id;
          
          const roleIsChanging = additionalMemberData.role_id && additionalMemberData.role_id !== null && 
            (!existingMemberRecord || additionalMemberData.role_id !== existingMemberRecord.role_id);
          const orgIsChanging = targetOrgId && existingMemberRecord?.organization_id && 
            targetOrgId !== existingMemberRecord.organization_id;
          
          // Check capacity if role or org is changing (and member has/will have a role)
          if (effectiveRoleToCheck && effectiveRoleToCheck !== null && (roleIsChanging || orgIsChanging)) {
            console.log('[AppProcessor] Checking capacity for additional member update:', {
              roleIsChanging,
              orgIsChanging,
              from: { role: existingMemberRecord?.role_id, org: existingMemberRecord?.organization_id },
              to: { role: effectiveRoleToCheck, org: targetOrgId }
            });
            const capacityCheck = await checkRoleCapacity(supabase, effectiveRoleToCheck, targetOrgId);
            console.log('[AppProcessor] Additional member update capacity check:', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                console.warn('[AppProcessor] Skipping additional member update - role requires org context:', memberConfig.label);
              } else {
                console.warn('[AppProcessor] Skipping additional member update - role at max capacity:', memberConfig.label, capacityCheck.maxMembers);
              }
              continue;
            }
          }
          
          let trackingUpdated = false;
          if (Object.keys(additionalMemberData).length > 0) {
            const { data: updatedMember, error: updateError } = await supabase
              .from('member')
              .update(additionalMemberData)
              .eq('id', existingMemberId)
              .select('id, role_id, organization_id')
              .single();
            
            if (updateError) {
              console.error('[AppProcessor] Failed to update additional member:', updateError);
            } else {
              console.log('[AppProcessor] Updated member:', existingMemberId);
              // Update in-memory context with authoritative values from DB after mutation
              if (updatedMember) {
                processedEmails.set(normalizedEmail, { 
                  id: updatedMember.id, 
                  role_id: updatedMember.role_id, 
                  organization_id: updatedMember.organization_id 
                });
                trackingUpdated = true;
                console.log('[AppProcessor] Updated tracking (from DB):', { 
                  role_id: updatedMember.role_id, 
                  organization_id: updatedMember.organization_id 
                });
              }
            }
          }
          
          // Always ensure processedEmails has authoritative data - fetch from DB if not already updated
          // This handles cases where no mutations occurred but we still need accurate tracking
          if (!trackingUpdated) {
            const { data: currentMemberState } = await supabase
              .from('member')
              .select('id, role_id, organization_id')
              .eq('id', existingMemberId)
              .single();
            
            if (currentMemberState) {
              processedEmails.set(normalizedEmail, { 
                id: currentMemberState.id, 
                role_id: currentMemberState.role_id, 
                organization_id: currentMemberState.organization_id 
              });
              console.log('[AppProcessor] Refreshed tracking (no mutation):', { 
                role_id: currentMemberState.role_id, 
                organization_id: currentMemberState.organization_id 
              });
            }
          }
          
          additionalMemberIds.push({ id: existingMemberId, label: memberConfig.label, created: false, updated: true });
        } else {
          // CREATE new member
          const additionalOrgId = createdOrganizationId || prefill_organization_id || null;
          // Remove raw organization_id from additionalMemberData (may be a name string, not UUID)
          delete additionalMemberData.organization_id;
          const newMemberData = {
            email: memberEmail,
            login_enabled: additionalMemberData.login_enabled !== undefined ? additionalMemberData.login_enabled : false,
            show_in_directory: additionalMemberData.show_in_directory !== undefined ? additionalMemberData.show_in_directory : true,
            ...additionalMemberData,
            organization_id: additionalOrgId,
          };
          
          // Add tenant_id if provided (from public form submission)
          if (tenant_id) {
            newMemberData.tenant_id = tenant_id;
          }

          // Create-branch only: when the additional-member pipeline is
          // __keep__ (newMemberData.role_id === undefined), fall back to
          // the tenant default. Explicit __clear__ (null) is preserved.
          let additionalRoleSource;
          if (newMemberData.role_id === undefined) {
            additionalRoleSource = 'none';
          } else if (newMemberData.role_id === null) {
            additionalRoleSource = 'pipeline-clear';
          } else {
            additionalRoleSource = 'pipeline-configured';
          }
          if (newMemberData.role_id === undefined) {
            const tenantForDefault = newMemberData.tenant_id || tenant_id || null;
            const { role: tenantDefaultRole, error: defaultLookupError } = await resolveTenantDefaultRole(supabase, tenantForDefault);
            if (defaultLookupError) {
              additionalRoleSource = 'lookup-error';
              console.error('[AppProcessor] Tenant default role lookup failed; additional member created without role:', { label: memberConfig.label, tenant_id: tenantForDefault, error: defaultLookupError });
            } else if (tenantDefaultRole) {
              newMemberData.role_id = tenantDefaultRole.id;
              additionalRoleSource = 'tenant-default';
              console.log('[AppProcessor] Applied tenant default role to new additional member:', { label: memberConfig.label, role_id: tenantDefaultRole.id, role_name: tenantDefaultRole.name, tenant_id: tenantForDefault });
            } else {
              console.warn('[AppProcessor] No default role configured for tenant; additional member created without role. Set one in /RoleManagement.', { label: memberConfig.label, tenant_id: tenantForDefault });
            }
          } else {
            console.log('[AppProcessor] Additional member role source:', additionalRoleSource, 'role_id:', newMemberData.role_id);
          }

          // Cross-tenant guard: a non-null role_id about to be written onto
          // this brand-new additional member must belong to its tenant. Hard
          // fail on mismatch — see validateRoleTenant.
          if (newMemberData.role_id) {
            const tenantCheck = await validateRoleTenant(supabase, newMemberData.role_id, newMemberData.tenant_id || tenant_id || null);
            if (!tenantCheck.ok) {
              return res.status(500).json({
                error: tenantCheck.message,
                code: 'ROLE_TENANT_MISMATCH'
              });
            }
          }

          // Check role capacity before creating additional member (per-organization)
          if (newMemberData.role_id && newMemberData.role_id !== null) {
            const capacityCheck = await checkRoleCapacity(supabase, newMemberData.role_id, additionalOrgId);
            console.log('[AppProcessor] Additional member role capacity check:', JSON.stringify(capacityCheck));
            if (!capacityCheck.hasCapacity) {
              if (capacityCheck.missingOrgContext) {
                console.warn('[AppProcessor] Skipping additional member creation - role requires org context:', memberConfig.label);
              } else {
                console.warn('[AppProcessor] Skipping additional member creation - role at max capacity:', memberConfig.label, capacityCheck.maxMembers);
              }
              continue;
            }
          }
          
          console.log('[AppProcessor] Creating new additional member:', memberConfig.label, newMemberData);
          
          const { data: newMember, error: memberError } = await supabase
            .from('member')
            .insert(newMemberData)
            .select()
            .single();
          
          if (memberError) {
            console.error('[AppProcessor] Failed to create additional member:', memberError);
            continue;
          }
          
          existingMemberId = newMember.id;
          additionalMemberIds.push({ id: newMember.id, label: memberConfig.label, created: true, updated: false });
          // Track with full context from the actual created record (not the input data)
          // This ensures subsequent entries get authoritative role_id/organization_id
          processedEmails.set(normalizedEmail, { 
            id: newMember.id, 
            role_id: newMember.role_id || null, 
            organization_id: newMember.organization_id 
          });
          console.log('[AppProcessor] Created additional member:', newMember.id, 'tracking:', { role_id: newMember.role_id, organization_id: newMember.organization_id });
          
          // Trigger workflows for new additional member creation
          // Must await to ensure completion before Vercel terminates the function
          const addlBaseUrl = process.env.APP_URL || `https://${req.headers.host}`;
          try {
            await triggerWorkflows('member', newMember.id, null, newMember, 'record_create', addlBaseUrl, { formSubmissionId: submission_id });
            console.log('[AppProcessor] Workflow evaluation completed for additional member:', newMember.id);
          } catch (err) {
            console.error('[AppProcessor] Additional member workflow error:', err);
          }
        }
        
        // Process custom field mappings (upsert logic)
        // For new format, custom fields were already collected in additionalCustomFieldsMap
        // For legacy format, process from field_mappings object
        if (memberConfig.mappings && Array.isArray(memberConfig.mappings)) {
          // New format: custom fields already in additionalCustomFieldsMap.
          // Routed through upsertPreferenceValue/clearPreferenceValue so
          // failures get logged to processing_notes instead of being
          // silently dropped (task 653).
          for (const [customFieldId, value] of additionalCustomFieldsMap.entries()) {
            const prefField = prefFieldMap.get(customFieldId);
            if (value === '__clear__') {
              await clearPreferenceValue({
                table: 'member_preference_value',
                parentColumn: 'member_id',
                parentId: existingMemberId,
                fieldId: customFieldId,
                entityScope: 'member',
                prefField,
              });
            } else if (value !== undefined && value !== null && value !== '') {
              await upsertPreferenceValue({
                table: 'member_preference_value',
                parentColumn: 'member_id',
                parentId: existingMemberId,
                fieldId: customFieldId,
                value: coercePreferenceValueForStorage(value),
                entityScope: 'member',
                prefField,
              });
            }
          }
        } else if (memberConfig.field_mappings) {
          // Legacy format: process custom fields from field_mappings
          // object. Same helper-based path as the new format above.
          const customFieldMappings = Object.entries(memberConfig.field_mappings)
            .filter(([key]) => key.startsWith('custom_'));
          
          if (customFieldMappings.length > 0) {
            for (const [key, fieldId] of customFieldMappings) {
              if (!fieldId) continue;
              
              const customFieldId = key.replace('custom_', '');
              const prefField = prefFieldMap.get(customFieldId);
              
              if (fieldId === '__clear__') {
                await clearPreferenceValue({
                  table: 'member_preference_value',
                  parentColumn: 'member_id',
                  parentId: existingMemberId,
                  fieldId: customFieldId,
                  entityScope: 'member',
                  prefField,
                });
              } else {
                const fieldKeyPresent = Object.prototype.hasOwnProperty.call(form_values, fieldId);
                const value = form_values[fieldId];
                if (!fieldKeyPresent) continue; // absent: skip
                if (isExplicitlyClearedValue(value)) {
                  await clearPreferenceValue({
                    table: 'member_preference_value',
                    parentColumn: 'member_id',
                    parentId: existingMemberId,
                    fieldId: customFieldId,
                    entityScope: 'member',
                    prefField,
                  });
                } else {
                  await upsertPreferenceValue({
                    table: 'member_preference_value',
                    parentColumn: 'member_id',
                    parentId: existingMemberId,
                    fieldId: customFieldId,
                    value: coercePreferenceValueForStorage(value),
                    entityScope: 'member',
                    prefField,
                  });
                }
              }
            }
          }
        }
      }
      
      console.log('[AppProcessor] Additional members processed:', additionalMemberIds.length);
    }

    // Persist processing notes (per-field outcomes from upsert/clear
    // helpers) to form_submission so silent failures become visible in
    // the submission viewer. Combined with the linkage update so we make
    // a single round-trip. NOTE: the previous version of this update
    // also wrote `processed_at`, but that column does not exist on
    // form_submission and the entire write was being rejected with a
    // PostgREST error that nothing checked — every "successful" submission
    // since the column was referenced was failing this final update
    // silently. Dropping the bogus column lets the legitimate fields
    // (created_member_id, created_organization_id, organization_id, and
    // processing_notes) actually persist.
    if (submission_id && (createdMemberId || createdOrganizationId || prefill_organization_id || processingNotes.length > 0)) {
      const finalOrganizationId = createdOrganizationId || prefill_organization_id || null;
      const updatePayload = {};
      if (createdMemberId) updatePayload.created_member_id = createdMemberId;
      if (createdOrganizationId) updatePayload.created_organization_id = createdOrganizationId;
      if (finalOrganizationId) updatePayload.organization_id = finalOrganizationId;
      if (processingNotes.length > 0) updatePayload.processing_notes = processingNotes;

      const { error: subUpdateErr } = await supabase
        .from('form_submission')
        .update(updatePayload)
        .eq('id', submission_id);
      if (subUpdateErr) {
        console.error('[AppProcessor] Failed to update form_submission with processing notes/links:', subUpdateErr);
      } else {
        console.log(`[AppProcessor] form_submission ${submission_id} updated with ${processingNotes.length} processing note(s).`);
      }
    }

    // Return the resolved organization_id (whether created or existing)
    const resolvedOrganizationId = createdOrganizationId || prefill_organization_id || null;
    
    return res.json({
      success: true,
      created_member_id: createdMemberId,
      created_organization_id: createdOrganizationId,
      organization_id: resolvedOrganizationId, // Canonical org ID (created or existing)
      additional_member_ids: additionalMemberIds
    });
  } catch (error) {
    console.error('[AppProcessor] Error:', error);
    res.status(500).json({ error: 'Failed to process application' });
  }
}
