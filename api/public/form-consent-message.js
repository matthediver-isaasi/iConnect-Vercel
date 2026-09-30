import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(200).json({ message: '' });
  }

  try {
    // Resolve tenant from request (subdomain, header, etc.)
    const tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      // No tenant found - return empty message
      return res.json({ message: '' });
    }

    const { data, error } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'form_default_consent_message')
      .eq('tenant_id', tenant.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching form consent message:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: data?.setting_value || '' });
  } catch (error) {
    console.error('Form consent message fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch consent message' });
  }
}
