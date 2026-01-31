import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { tenant: tenantParam, allowedStatuses: allowedStatusesParam } = req.query;
    let tenantId = null;
    
    // Parse allowedStatuses filter if provided
    let allowedStatuses = [];
    if (allowedStatusesParam) {
      try {
        allowedStatuses = JSON.parse(allowedStatusesParam);
        if (!Array.isArray(allowedStatuses)) {
          allowedStatuses = [];
        }
      } catch (e) {
        allowedStatuses = [];
      }
    }
    
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

    // If no status filter is applied, just fetch all organisations
    if (allowedStatuses.length === 0) {
      const { data, error } = await supabase
        .from('organization')
        .select('id, name, logo_url')
        .eq('tenant_id', tenantId)
        .order('name', { ascending: true });

      if (error) {
        console.error('Error fetching organisations:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data || []);
    }

    // Status filter is applied - find the application_status field first
    const { data: statusField, error: fieldError } = await supabase
      .from('preference_field')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('name', 'application_status')
      .eq('entity_scope', 'organization')
      .eq('is_active', true)
      .single();
    
    if (fieldError || !statusField) {
      // No application_status field found, return all organisations
      const { data, error } = await supabase
        .from('organization')
        .select('id, name, logo_url')
        .eq('tenant_id', tenantId)
        .order('name', { ascending: true });

      if (error) {
        console.error('Error fetching organisations:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data || []);
    }

    // Fetch all organisations and their application_status preference values
    const { data: allOrgs, error: orgsError } = await supabase
      .from('organization')
      .select('id, name, logo_url')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });

    if (orgsError) {
      console.error('Error fetching organisations:', orgsError);
      return res.status(500).json({ error: orgsError.message });
    }

    // Get all org IDs from this tenant to scope the preference values query
    const orgIds = (allOrgs || []).map(org => org.id);
    
    if (orgIds.length === 0) {
      return res.json([]);
    }

    // Fetch application_status values for orgs in this tenant only (prevents cross-tenant leakage)
    const { data: statusValues, error: statusError } = await supabase
      .from('organization_preference_value')
      .select('organization_id, value')
      .eq('field_id', statusField.id)
      .in('organization_id', orgIds);

    if (statusError) {
      console.error('Error fetching org status values:', statusError);
      // On error, return all orgs (fail open)
      return res.json(allOrgs || []);
    }

    // Helper to normalize status value to a primitive string for comparison
    const normalizeStatusValue = (rawValue) => {
      if (rawValue === null || rawValue === undefined) return null;
      
      let statusValue = rawValue;
      
      // Handle JSON-encoded strings
      if (typeof statusValue === 'string') {
        try {
          const parsed = JSON.parse(statusValue);
          statusValue = parsed;
        } catch (e) {
          // Keep as-is (plain string)
          return statusValue;
        }
      }
      
      // Handle {value: "X"} or {value: "X", label: "Y"} format
      if (statusValue && typeof statusValue === 'object') {
        if (statusValue.value !== undefined) {
          return String(statusValue.value);
        }
        // Handle array values (take first element)
        if (Array.isArray(statusValue) && statusValue.length > 0) {
          const first = statusValue[0];
          if (typeof first === 'object' && first.value !== undefined) {
            return String(first.value);
          }
          return String(first);
        }
      }
      
      return String(statusValue);
    };

    // Build a map of org_id -> normalized status value
    const orgStatusMap = {};
    (statusValues || []).forEach(pv => {
      orgStatusMap[pv.organization_id] = normalizeStatusValue(pv.value);
    });

    // Normalize allowedStatuses for comparison
    const normalizedAllowedStatuses = allowedStatuses.map(s => String(s));

    // Filter organisations by allowed statuses
    const filteredOrgs = (allOrgs || []).filter(org => {
      const orgStatus = orgStatusMap[org.id];
      if (orgStatus === null || orgStatus === undefined) return false; // No status set, exclude
      return normalizedAllowedStatuses.includes(orgStatus);
    });

    return res.json(filteredOrgs);
  } catch (error) {
    console.error('Public organisations fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisations' });
  }
}
