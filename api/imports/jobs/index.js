import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

// Terminal statuses eligible for bulk removal from the Recent Imports list.
const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Resolve the caller's tenant so each tenant only sees its own import history.
  let tenantId = null;
  try {
    const { data: member } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', session.data.memberId)
      .single();
    tenantId = member?.tenant_id || null;
  } catch (e) {
    console.log('[Import Jobs] Could not resolve tenant_id:', e.message);
  }
  if (!tenantId) {
    return req.method === 'DELETE'
      ? res.status(404).json({ error: 'No import jobs found' })
      : res.json([]);
  }

  if (req.method === 'DELETE') {
    // Bulk-clear all terminal jobs for this tenant (optionally scoped to one
    // entity type). In-flight jobs are left untouched.
    try {
      const entityType = req.query.entity;
      let deleteQuery = supabase
        .from('csv_import_job')
        .delete()
        .eq('tenant_id', tenantId)
        .in('status', TERMINAL_STATUSES);

      if (entityType) {
        deleteQuery = deleteQuery.eq('entity_type', entityType);
      }

      const { error: deleteError } = await deleteQuery;
      if (deleteError) {
        if (deleteError.message?.includes('Could not find the table') ||
            deleteError.code === '42P01' ||
            (deleteError.message?.includes('relation') && deleteError.message?.includes('does not exist'))) {
          return res.json({ success: true });
        }
        console.error('[Import Jobs] Bulk delete failed:', deleteError.message);
        return res.status(500).json({ error: 'Could not clear import jobs' });
      }
      return res.json({ success: true });
    } catch (error) {
      console.error('[Import Jobs] Bulk delete error:', error);
      return res.status(500).json({ error: error.message || 'Could not clear import jobs' });
    }
  }

  try {
    const entityType = req.query.entity;
    
    let query = supabase
      .from('csv_import_job')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (entityType) {
      query = query.eq('entity_type', entityType);
    }
    
    const { data: jobs, error } = await query;
    
    if (error) {
      if (error.message?.includes('Could not find the table') || 
          error.code === '42P01' || 
          (error.message?.includes('relation') && error.message?.includes('does not exist'))) {
        console.log('[Import] csv_import_job table does not exist yet - returning empty array');
        return res.json([]);
      }
      throw error;
    }
    
    res.json(jobs || []);
  } catch (error) {
    if (error.message?.includes('Could not find the table') || 
        (error.message?.includes('relation') && error.message?.includes('does not exist'))) {
      console.log('[Import] csv_import_job table does not exist yet - returning empty array');
      return res.json([]);
    }
    console.error('[Import Jobs] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to get jobs' });
  }
}
