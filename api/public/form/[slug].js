import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

// Fields safe to return publicly - excludes internal config like field_mappings
const PUBLIC_FORM_FIELDS = [
  'id', 'name', 'slug', 'description', 'fields', 'is_active', 
  'layout_type', 'submit_button_text', 'success_message', 'redirect_url',
  'send_email', 'email_templates', 'prefill_source',
  'visibility_rules', 'pages',  // Needed for conditional logic and multi-page forms
  'entity_pipelines'  // Needed for role capacity checking
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Form slug is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      console.error('[Public Form API] Tenant not found');
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // Fetch form scoped to tenant
    const { data: form, error } = await supabase
      .from('form')
      .select('*')
      .eq('slug', slug)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Form not found or inactive' });
      }
      console.error('Error fetching form:', error);
      return res.status(500).json({ error: error.message });
    }

    if (!form) {
      return res.status(404).json({ error: 'Form not found' });
    }

    // Reject forms that require authentication - these cannot be embedded publicly
    if (form.require_authentication) {
      return res.status(403).json({ 
        error: 'This form requires authentication and cannot be embedded publicly',
        require_authentication: true
      });
    }

    // Return only public-safe fields
    const publicForm = {};
    for (const field of PUBLIC_FORM_FIELDS) {
      if (form[field] !== undefined) {
        publicForm[field] = form[field];
      }
    }

    return res.json(publicForm);
  } catch (error) {
    console.error('Form fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch form' });
  }
}
