import { getSessionTenantUser } from '../_lib/session.js';
import { supabase } from '../_lib/database.js';
import { clearTenantCache } from '../_lib/tenantResolver.js';
import { clearTenantEmailCache } from '../_lib/emailService.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantUser = await getSessionTenantUser(req);
  
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantUser.tenant_id;

  if (req.method === 'GET') {
    try {
      const { data: tenant, error } = await supabase
        .from('tenant')
        .select('*')
        .eq('id', tenantId)
        .single();

      if (error || !tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      res.json({ success: true, tenant });
    } catch (error) {
      console.error('[Admin] Get tenant error:', error);
      res.status(500).json({ error: 'Failed to get tenant' });
    }
  } else if (req.method === 'PATCH') {
    try {
      const allowedFields = [
        'name', 
        'logo_url', 
        'favicon_url', 
        'primary_color',
        'billing_email',
        'settings'
      ];
      
      const updates = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      if (updates.settings) {
        const { data: currentTenant } = await supabase
          .from('tenant')
          .select('settings')
          .eq('id', tenantId)
          .single();
        
        const currentSettings = currentTenant?.settings || {};
        const incomingSettings = updates.settings;
        
        if (incomingSettings.email_from_name || incomingSettings.email_from_address) {
          const currentEmailDomain = currentSettings.email_domain || {};
          updates.settings = {
            ...currentSettings,
            ...incomingSettings,
            email_domain: {
              ...currentEmailDomain,
              from_name: incomingSettings.email_from_name || currentEmailDomain.from_name,
              from_email: incomingSettings.email_from_address || currentEmailDomain.from_email
            }
          };
        } else {
          updates.settings = {
            ...currentSettings,
            ...incomingSettings,
            email_domain: currentSettings.email_domain
          };
        }
      }

      updates.updated_at = new Date().toISOString();

      const { data: tenant, error } = await supabase
        .from('tenant')
        .update(updates)
        .eq('id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('[Admin] Update tenant error:', error);
        return res.status(500).json({ error: 'Failed to update tenant' });
      }

      // Clear tenant cache so updated settings take effect immediately
      if (tenant.slug) {
        clearTenantCache(tenant.slug);
      }
      if (tenant.domain) {
        clearTenantCache(tenant.domain);
      }
      
      // Clear email config cache if email settings were updated
      clearTenantEmailCache(tenantId);

      console.log('[Admin] Tenant updated:', tenantId);
      res.json({ success: true, tenant });
    } catch (error) {
      console.error('[Admin] Update tenant error:', error);
      res.status(500).json({ error: 'Failed to update tenant' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
