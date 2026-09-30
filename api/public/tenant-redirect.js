import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug } = req.query;
  
  if (!slug) {
    return res.json({ redirectTo: null });
  }

  try {
    const { data: tenant, error } = await supabase
      .from('tenant')
      .select('domain')
      .eq('slug', slug)
      .eq('status', 'active')
      .single();

    if (error || !tenant) {
      return res.json({ redirectTo: null });
    }

    const customDomain = tenant.domain?.trim();
    
    if (customDomain) {
      return res.json({ redirectTo: customDomain });
    }

    return res.json({ redirectTo: null });

  } catch (err) {
    console.error('[TenantRedirect] Error:', err);
    return res.json({ redirectTo: null });
  }
}
