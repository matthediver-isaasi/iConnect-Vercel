import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const tenantId = tenantUser.tenant_id;
  if (!tenantId) {
    return res.status(400).json({ error: 'Tenant context not available' });
  }
  
  try {
    const { data, error } = await supabase
      .from('role')
      .select('id, name, is_system')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });
    
    if (error) {
      throw new Error(error.message);
    }
    
    return res.json({
      data: data || []
    });
  } catch (error) {
    console.error('[Roles List] Error:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch roles' });
  }
}
