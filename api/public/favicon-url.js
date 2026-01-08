import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getSessionMember } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (!supabase) {
    return res.status(200).json({ faviconUrl: null });
  }

  try {
    let tenant = await resolveTenantFromRequest(req);
    
    if (!tenant) {
      const sessionMember = await getSessionMember(req);
      if (sessionMember?.tenant_id) {
        const { data: tenantData } = await supabase
          .from('tenant')
          .select('favicon_url')
          .eq('id', sessionMember.tenant_id)
          .single();
        
        if (tenantData?.favicon_url) {
          return res.status(200).json({ faviconUrl: tenantData.favicon_url });
        }
      }
    } else if (tenant.favicon_url) {
      return res.status(200).json({ faviconUrl: tenant.favicon_url });
    }

    const { data } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'site_favicon_url')
      .single();

    return res.status(200).json({ faviconUrl: data?.setting_value || null });
  } catch (error) {
    return res.status(200).json({ faviconUrl: null });
  }
}
