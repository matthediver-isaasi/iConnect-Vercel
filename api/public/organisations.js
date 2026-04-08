import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const VALID_CORE_FIELDS = [
  'name', 'slug', 'description', 'website_url', 'email', 'phone',
  'address', 'city', 'country', 'postcode', 'external_id', 'is_active',
  'status', 'twitter_url', 'linkedin_url', 'facebook_url', 'instagram_url'
];

const normalizePreferenceValue = (rawValue) => {
  if (rawValue === null || rawValue === undefined) return null;

  let val = rawValue;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) { return val; }
  }
  if (val && typeof val === 'object') {
    if (val.value !== undefined) return String(val.value);
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      return typeof first === 'object' && first.value !== undefined ? String(first.value) : String(first);
    }
  }
  return String(val);
};

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
    const { tenant: tenantParam, allowedStatuses: allowedStatusesParam, orgFilter: orgFilterParam } = req.query;
    let tenantId = null;

    let allowedStatuses = [];
    if (allowedStatusesParam) {
      try {
        allowedStatuses = JSON.parse(allowedStatusesParam);
        if (!Array.isArray(allowedStatuses)) allowedStatuses = [];
      } catch (e) { allowedStatuses = []; }
    }

    let orgFilter = null;
    if (orgFilterParam) {
      try {
        const parsed = JSON.parse(orgFilterParam);
        if (parsed && parsed.type && parsed.field && Array.isArray(parsed.values) && parsed.values.length > 0) {
          orgFilter = parsed;
        }
      } catch (e) { orgFilter = null; }
    }

    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }

    if (!tenantId && tenantParam) {
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();

      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
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

    if (orgFilter && orgFilter.type === 'core') {
      if (!VALID_CORE_FIELDS.includes(orgFilter.field)) {
        return res.status(400).json({ error: 'Invalid core field for filtering' });
      }

      const sanitizedValues = orgFilter.values
        .map(v => String(v).replace(/[%_.*+?^${}()|[\]\\,]/g, '').trim())
        .filter(v => v.length > 0 && v.length <= 200);

      if (sanitizedValues.length === 0) {
        return res.status(400).json({ error: 'No valid filter values provided' });
      }

      let query = supabase
        .from('organization')
        .select('id, name, logo_url')
        .eq('tenant_id', tenantId);

      if (orgFilter.field === 'is_active') {
        const boolVal = sanitizedValues[0] === 'true';
        query = query.eq('is_active', boolVal);
      } else if (sanitizedValues.length === 1) {
        query = query.ilike(orgFilter.field, `%${sanitizedValues[0]}%`);
      } else {
        query = query.in(orgFilter.field, sanitizedValues);
      }

      const { data, error } = await query.order('name', { ascending: true });
      if (error) {
        console.error('Error fetching organisations with core filter:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.json(data || []);
    }

    if (orgFilter && orgFilter.type === 'custom') {
      return await filterByCustomField(supabase, tenantId, orgFilter.field, orgFilter.values, res);
    }

    if (allowedStatuses.length > 0) {
      return await filterByCustomField(supabase, tenantId, 'application_status', allowedStatuses, res);
    }

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
  } catch (error) {
    console.error('Public organisations fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisations' });
  }
}

async function filterByCustomField(supabase, tenantId, fieldName, allowedValues, res) {
  const { data: prefField, error: fieldError } = await supabase
    .from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', fieldName)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .single();

  if (fieldError || !prefField) {
    const { data, error } = await supabase
      .from('organization')
      .select('id, name, logo_url')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }

  const { data: allOrgs, error: orgsError } = await supabase
    .from('organization')
    .select('id, name, logo_url')
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true });

  if (orgsError) {
    console.error('Error fetching organisations:', orgsError);
    return res.status(500).json({ error: orgsError.message });
  }

  const orgIds = (allOrgs || []).map(org => org.id);
  if (orgIds.length === 0) return res.json([]);

  const { data: prefValues, error: prefError } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', prefField.id)
    .in('organization_id', orgIds);

  if (prefError) {
    console.error('Error fetching org preference values:', prefError);
    return res.json(allOrgs || []);
  }

  const orgValueMap = {};
  (prefValues || []).forEach(pv => {
    orgValueMap[pv.organization_id] = normalizePreferenceValue(pv.value);
  });

  const normalizedAllowed = allowedValues.map(s => String(s));
  const filteredOrgs = (allOrgs || []).filter(org => {
    const orgVal = orgValueMap[org.id];
    if (orgVal === null || orgVal === undefined) return false;
    return normalizedAllowed.includes(orgVal);
  });

  return res.json(filteredOrgs);
}
