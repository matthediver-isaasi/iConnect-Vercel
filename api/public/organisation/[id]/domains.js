import { createClient } from '@supabase/supabase-js';
import { resolveEffectiveOrgGuestAccess } from '../../../_lib/orgGuestAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Organisation ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Fetch organisation basic info, including its tenant_id and per-org guest
    // access fields so /FormView can decide whether to bypass the verified
    // domain check for guests. Falls back gracefully when the optional
    // columns aren't present (e.g. on a database without the migration).
    let org = null;
    {
      const { data, error } = await supabase
        .from('organization')
        .select('id, name, tenant_id, guest_access_enabled, guest_access_period_days, guest_access_unlimited')
        .eq('id', id)
        .single();
      if (!error) {
        org = data;
      } else if (error.code === '42703') {
        // Postgres "undefined_column" - the optional guest_access / tenant_id
        // columns aren't on this database yet. Fall back to a basic select so
        // existing /FormView callers keep working.
        const { data: basicData, error: basicErr } = await supabase
          .from('organization')
          .select('id, name')
          .eq('id', id)
          .single();
        if (basicErr) {
          console.error('Error fetching organisation:', basicErr);
          return res.status(500).json({ error: basicErr.message });
        }
        org = basicData;
      } else {
        console.error('Error fetching organisation:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Find the verified_domains custom field definition. preference_field is
    // tenant-scoped, so when we know the org's tenant_id we MUST filter by it
    // — otherwise multiple tenants with their own verified_domains field would
    // collide on the lookup (PGRST116 from .single()) and silently return an
    // empty domain list, or pick the wrong tenant's field_id and resolve to
    // nothing on the follow-up value lookup.
    let fieldDefQuery = supabase
      .from('preference_field')
      .select('id')
      .eq('name', 'verified_domains')
      .eq('entity_scope', 'organization')
      .eq('is_active', true);

    if (org.tenant_id) {
      fieldDefQuery = fieldDefQuery.eq('tenant_id', org.tenant_id);
    }

    // Use maybeSingle() so a zero-row result returns null+no-error (instead
    // of PGRST116). On the legacy fallback path (where the org row didn't
    // expose tenant_id) a multi-row result still surfaces as an error, but
    // the `if (fieldDef && !fieldError)` guard below safely collapses that
    // to "no domains configured" rather than crashing the request.
    const { data: fieldDef, error: fieldError } = await fieldDefQuery.maybeSingle();

    let verifiedDomains = [];

    if (fieldDef && !fieldError) {
      // Fetch the organization's custom field value
      const { data: fieldValue, error: valueError } = await supabase
        .from('organization_preference_value')
        .select('value')
        .eq('organization_id', id)
        .eq('field_id', fieldDef.id)
        .maybeSingle();

      if (fieldValue && !valueError && fieldValue.value) {
        const val = fieldValue.value;
        // Handle different storage formats: native array (jsonb), JSON string, or comma-separated string
        if (Array.isArray(val)) {
          verifiedDomains = val.filter(Boolean);
        } else if (typeof val === 'string') {
          try {
            const parsed = JSON.parse(val);
            verifiedDomains = Array.isArray(parsed) ? parsed.filter(Boolean) : [parsed].filter(Boolean);
          } catch {
            // If not JSON, treat as comma-separated or single value
            verifiedDomains = val.split(',').map(d => d.trim()).filter(Boolean);
          }
        }
      }
    }

    // Resolve effective guest access settings via the shared helper so the
    // wire response stays aligned with the backend's guest-stamping decision
    // in api/forms/process-application.js.
    const guestAccess = await resolveEffectiveOrgGuestAccess(supabase, org);

    return res.json({
      id: org.id,
      name: org.name,
      verified_domains: verifiedDomains,
      guest_access: guestAccess,
    });
  } catch (error) {
    console.error('Public organisation domains fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisation domains' });
  }
}
