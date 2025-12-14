import { createClient } from '@supabase/supabase-js';

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
    // Fetch organisation basic info
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select('id, name')
      .eq('id', id)
      .single();

    if (orgError) {
      console.error('Error fetching organisation:', orgError);
      return res.status(500).json({ error: orgError.message });
    }

    if (!org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Find the verified_domains custom field definition
    const { data: fieldDef, error: fieldError } = await supabase
      .from('preference_field')
      .select('id')
      .eq('name', 'verified_domains')
      .eq('entity_scope', 'organization')
      .eq('is_active', true)
      .single();

    let verifiedDomains = [];

    if (fieldDef && !fieldError) {
      // Fetch the organization's custom field value
      const { data: fieldValue, error: valueError } = await supabase
        .from('organization_preference_value')
        .select('value')
        .eq('organization_id', id)
        .eq('field_id', fieldDef.id)
        .single();

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

    return res.json({
      id: org.id,
      name: org.name,
      verified_domains: verifiedDomains
    });
  } catch (error) {
    console.error('Public organisation domains fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisation domains' });
  }
}
