import { createClient } from '@supabase/supabase-js';
import { getSession } from '../../_lib/session.js';

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
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const entityType = req.query.entity;
    
    let query = supabase
      .from('csv_import_job')
      .select('*')
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
