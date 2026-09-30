import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';
import { resolveTenantOrganisationGroupId } from '../../_lib/formOrganisationGroups.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, tenant: tenantParam } = req.query;

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
    let tenantId = null;
    
    // First try: centralized tenant resolver (subdomain and custom domain)
    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }
    
    // Second try: explicit tenant query parameter (for local dev, embedded forms, etc.)
    if (!tenantId && tenantParam) {
      // Try slug first
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();
      
      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        // Fallback to subdomain field for legacy tenants
        const { data: tenantBySubdomain } = await supabase
          .from('tenant')
          .select('id')
          .eq('subdomain', tenantParam)
          .eq('status', 'active')
          .single();
        
        if (tenantBySubdomain) {
          tenantId = tenantBySubdomain.id;
        }
      }
    }
    
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    // Fetch organization - use select(*) and filter sensitive fields after
    // This avoids errors from non-existent columns in the whitelist
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (orgError) {
      console.error('Error fetching organization:', orgError);
      return res.status(404).json({ error: 'Organisation not found' });
    }
    
    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Enforce tenant isolation - org must belong to requesting tenant
    if (org.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // A stale or forged parent-group reference must never cross tenant
    // boundaries through public organisation prefill.
    const organizationGroupId = await resolveTenantOrganisationGroupId({
      db: supabase,
      tenantId,
      groupId: org.organization_group_id,
    });

    // Remove sensitive/internal fields from response.
    // Note: `training_fund_balance` is intentionally exposed here because the
    // FormBuilder prefill UI offers it as a selectable organisation prefill
    // field (see ORG_CORE_FIELDS / ORG_PREFILL_FIELDS in
    // client/src/pages/FormBuilder.jsx and WHITELISTED_ORG_FIELDS in
    // api/public/form/prefill-booking.js). Keep `internal_notes` and `notes`
    // hidden — they are not in the prefill whitelist.
    const {
      tenant_id,
      internal_notes,
      notes,
      organization_group_id,
      ...publicOrg
    } = org;

    return res.json({
      ...publicOrg,
      organization_group_id: organizationGroupId,
    });
  } catch (error) {
    console.error('Public organization fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organization' });
  }
}
