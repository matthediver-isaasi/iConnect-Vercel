import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const VALID_CORE_FIELDS = [
  'name', 'slug', 'description', 'website_url', 'email', 'invoicing_email', 'phone',
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
    const { tenant: tenantParam, fieldType, fieldName } = req.query;

    if (!fieldType || !fieldName) {
      return res.status(400).json({ error: 'fieldType and fieldName are required' });
    }

    if (fieldType !== 'core' && fieldType !== 'custom') {
      return res.status(400).json({ error: 'fieldType must be "core" or "custom"' });
    }

    let tenantId = null;
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

    if (fieldType === 'core') {
      if (!VALID_CORE_FIELDS.includes(fieldName)) {
        return res.status(400).json({ error: 'Invalid core field name' });
      }

      const { data: orgs, error } = await supabase
        .from('organization')
        .select(fieldName)
        .eq('tenant_id', tenantId)
        .not(fieldName, 'is', null);

      if (error) {
        console.error('Error fetching distinct core field values:', error);
        return res.status(500).json({ error: error.message });
      }

      const uniqueValues = [...new Set(
        (orgs || [])
          .map(o => o[fieldName])
          .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
          .map(v => String(v).trim())
      )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      return res.json(uniqueValues);
    }

    if (fieldType === 'custom') {
      const { data: prefField, error: fieldError } = await supabase
        .from('preference_field')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('name', fieldName)
        .eq('entity_scope', 'organization')
        .eq('is_active', true)
        .single();

      if (fieldError || !prefField) {
        return res.json([]);
      }

      const { data: orgIds, error: orgError } = await supabase
        .from('organization')
        .select('id')
        .eq('tenant_id', tenantId);

      if (orgError || !orgIds || orgIds.length === 0) {
        return res.json([]);
      }

      const ids = orgIds.map(o => o.id);
      const { data: prefValues, error: prefError } = await supabase
        .from('organization_preference_value')
        .select('value')
        .eq('field_id', prefField.id)
        .in('organization_id', ids);

      if (prefError) {
        console.error('Error fetching custom field values:', prefError);
        return res.json([]);
      }

      const uniqueValues = [...new Set(
        (prefValues || [])
          .map(pv => normalizePreferenceValue(pv.value))
          .filter(v => v !== null && v !== undefined && v.trim() !== '')
      )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      return res.json(uniqueValues);
    }

    return res.json([]);
  } catch (error) {
    console.error('Organisation field values fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch field values' });
  }
}
