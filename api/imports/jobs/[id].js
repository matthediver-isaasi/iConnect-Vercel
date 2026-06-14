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
  
  // Resolve the caller's tenant so a job can only be read by its own tenant.
  let tenantId = null;
  try {
    const { data: member } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', session.data.memberId)
      .single();
    tenantId = member?.tenant_id || null;
  } catch (e) {
    console.log('[Import Job] Could not resolve tenant_id:', e.message);
  }
  if (!tenantId) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const { id } = req.query;
    
    const { data: job, error } = await supabase
      .from('csv_import_job')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
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
