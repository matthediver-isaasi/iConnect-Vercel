import { createClient } from '@supabase/supabase-js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const VALID_CORE_FIELDS = [
  'name', 'slug', 'description', 'website_url', 'email', 'invoicing_email', 'phone',
  'address', 'city', 'country', 'postcode', 'external_id', 'is_active',
  'status', 'twitter_url', 'linkedin_url', 'facebook_url', 'instagram_url'
];

export const normalizePreferenceValues = (rawValue) => {
  if (rawValue === null || rawValue === undefined) return [];

  let val = rawValue;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (e) {
      const trimmed = val.trim();
      return trimmed ? [trimmed] : [];
    }
  }
  if (Array.isArray(val)) {
    return val.flatMap(normalizePreferenceValues);
  }
  if (val && typeof val === 'object' && val.value !== undefined) {
    return normalizePreferenceValues(val.value);
  }
  const normalized = String(val).trim();
  return normalized ? [normalized] : [];
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
    const { fieldType, fieldName } = req.query;

    if (!fieldType || !fieldName) {
      return res.status(400).json({ error: 'fieldType and fieldName are required' });
    }

    if (fieldType !== 'core' && fieldType !== 'custom') {
      return res.status(400).json({ error: 'fieldType must be "core" or "custom"' });
    }

    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) return res.status(401).json({ error: 'Authentication required' });
    if (!(await hasAdminAccess(tenantContext))) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const tenantId = tenantContext.tenantId;

    if (fieldType === 'core') {
      if (!VALID_CORE_FIELDS.includes(fieldName)) {
        return res.status(400).json({ error: 'Invalid core field name' });
      }

      const orgs = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from('organization')
          .select(`id,${fieldName}`)
          .eq('tenant_id', tenantId)
          .not(fieldName, 'is', null)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) {
          console.error('Error fetching distinct core field values:', error);
          return res.status(500).json({ error: error.message });
        }
        orgs.push(...(data || []));
        if ((data || []).length < pageSize) break;
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

      const orgIds = [];
      const pageSize = 500;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from('organization')
          .select('id')
          .eq('tenant_id', tenantId)
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) {
          console.error('Error fetching tenant organisations:', error);
          return res.status(500).json({ error: error.message });
        }
        orgIds.push(...(data || []).map((organization) => organization.id));
        if ((data || []).length < pageSize) break;
      }
      if (orgIds.length === 0) return res.json([]);

      const prefValues = [];
      for (let index = 0; index < orgIds.length; index += 200) {
        const { data, error } = await supabase
          .from('organization_preference_value')
          .select('value')
          .eq('field_id', prefField.id)
          .in('organization_id', orgIds.slice(index, index + 200));
        if (error) {
          console.error('Error fetching custom field values:', error);
          return res.status(500).json({ error: error.message });
        }
        prefValues.push(...(data || []));
      }

      const uniqueValues = [...new Set(
        prefValues.flatMap((preference) => normalizePreferenceValues(preference.value))
      )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      return res.json(uniqueValues);
    }

    return res.json([]);
  } catch (error) {
    console.error('Organisation field values fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch field values' });
  }
}
