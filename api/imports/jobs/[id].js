import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';

// Non-terminal statuses a job can be cancelled from.
const CANCELLABLE_STATUSES = ['initializing', 'queued', 'processing'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Resolve the caller's tenant so a job can only be read/changed by its own tenant.
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

  const { id } = req.query;

  try {
    const { data: job, error } = await supabase
      .from('csv_import_job')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.method === 'GET') {
      return res.json(job);
    }

    // PATCH: only cancellation is supported.
    const action = req.body?.action || (req.body?.status === 'cancelled' ? 'cancel' : null);
    if (action !== 'cancel') {
      return res.status(400).json({ error: 'Unsupported action' });
    }

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      // Already terminal (or unknown) — nothing to cancel. Return the current
      // row so the client can reconcile its view.
      return res.status(409).json({ error: 'Job is no longer running', job });
    }

    const nowIso = new Date().toISOString();
    // Tenant-scoped conditional update: only flip a still-cancellable row. A
    // worker that finalises the job between our read and write wins the race and
    // this affects zero rows, in which case we report the job's real state.
    const { data: updatedRows, error: updateError } = await supabase
      .from('csv_import_job')
      .update({
        status: 'cancelled',
        completed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .in('status', CANCELLABLE_STATUSES)
      .select('*');

    if (updateError) {
      console.error('[Import Job] Cancel failed:', updateError.message);
      return res.status(500).json({ error: 'Could not cancel the import job' });
    }

    if (!updatedRows || updatedRows.length === 0) {
      const { data: fresh } = await supabase
        .from('csv_import_job')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();
      return res.status(409).json({ error: 'Job is no longer running', job: fresh || job });
    }

    return res.json(updatedRows[0]);
  } catch (error) {
    console.error('[Import Job] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process job request' });
  }
}
