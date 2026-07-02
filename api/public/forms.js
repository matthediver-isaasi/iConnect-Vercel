import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

const PUBLIC_FORM_FIELDS = [
  'id', 'name', 'slug', 'description', 'is_active', 
  'layout_type', 'submit_button_text', 'success_message',
  'require_authentication'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { data: forms, error } = await supabase
      .from('form')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('[Public Forms] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch forms' });
    }

    const publicForms = (forms || []).map(form => {
      const publicForm = {};
      for (const field of PUBLIC_FORM_FIELDS) {
        if (form[field] !== undefined) {
          publicForm[field] = form[field];
        }
      }
      return publicForm;
    });

    return res.status(200).json(publicForms);
  } catch (error) {
    console.error('[Public Forms] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
