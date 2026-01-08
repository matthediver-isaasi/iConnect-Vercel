import { getSessionMember, getSessionTenantUser } from '../_lib/session.js';
import { createClient } from '@supabase/supabase-js';
import { isResourceExcluded } from '../_lib/roleVisibility.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

async function verifyAdminPermission(req) {
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser) {
    return { isAdmin: true, tenantId: tenantUser.tenant_id };
  }

  const sessionMember = await getSessionMember(req);
  
  if (!sessionMember) {
    return { isAdmin: false, error: 'Not authenticated' };
  }

  if (!sessionMember.role_id) {
    return { isAdmin: false };
  }

  if (!supabase) {
    return { isAdmin: false, error: 'Database not configured' };
  }

  try {
    const { data: role, error: roleError } = await supabase
      .from('role')
      .select('excluded_features')
      .eq('id', sessionMember.role_id)
      .single();

    if (roleError || !role) {
      return { isAdmin: false };
    }

    const excludedFeatures = role.excluded_features || [];
    return { 
      isAdmin: !isResourceExcluded(excludedFeatures, 'admin.role-management'),
      tenantId: sessionMember.tenant_id
    };
  } catch (error) {
    console.error('[Admin Verify] Error:', error);
    return { isAdmin: false, error: 'Verification failed' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { isAdmin, error, tenantId } = await verifyAdminPermission(req);

  if (error) {
    return res.status(401).json({ error });
  }

  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { date } = req.body || {};
    const backfillDate = date ? new Date(date).toISOString() : new Date().toISOString();
    
    let query = supabase
      .from('organization')
      .update({ created_at: backfillDate })
      .is('created_at', null);
    
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    }
    
    const { data, error: updateError } = await query.select('id');

    if (updateError) {
      console.error('[Backfill Org Dates] Error:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    const count = data?.length || 0;
    console.log(`[Backfill Org Dates] Updated ${count} organizations with created_at: ${backfillDate} for tenant ${tenantId || 'all'}`);
    
    return res.json({ 
      success: true, 
      updated: count,
      backfillDate 
    });
  } catch (error) {
    console.error('[Backfill Org Dates] Error:', error);
    return res.status(500).json({ error: 'Failed to backfill organization dates' });
  }
}
