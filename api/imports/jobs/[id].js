import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

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
    const { id } = req.query;
    
    const { data: job, error } = await supabase
      .from('csv_import_job')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(job);
  } catch (error) {
    console.error('[Import Job] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to get job' });
  }
}
