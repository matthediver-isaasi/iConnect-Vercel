import { supabase } from '../../_lib/database.js';
import { getSession } from '../../_lib/session.js';
import { cleanupImportJobFile } from '../../_lib/importFileCleanup.js';

// Non-terminal statuses a job can be cancelled from.
const CANCELLABLE_STATUSES = ['initializing', 'queued', 'processing'];

// Terminal statuses a job can be removed from the Recent Imports list once in.
const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'DELETE') {
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

    if (req.method === 'DELETE') {
      // Only terminal jobs can be removed from the list; in-flight jobs must be
      // cancelled first.
      if (!TERMINAL_STATUSES.includes(job.status)) {
        return res.status(409).json({ error: 'Cannot remove a running import. Cancel it first.', job });
      }

      const { error: deleteError } = await supabase
        .from('csv_import_job')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .in('status', TERMINAL_STATUSES);

      if (deleteError) {
        console.error('[Import Job] Delete failed:', deleteError.message);
        return res.status(500).json({ error: 'Could not remove the import job' });
      }

      return res.json({ success: true, id });
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

    // The job is now terminal ('cancelled'): its stored source file is dead
    // weight that keeps counting against the tenant's storage quota, so delete
    // it and release the storage like the worker does on completion. Best-effort
    // and idempotent (clears the job's storage refs); the cancelled job is
    // terminal so the worker/cron will never reprocess it. A worker mid-slice
    // already holds the file in memory, so removing it here is safe.
    const cancelledJob = updatedRows[0];
    await cleanupImportJobFile(supabase, cancelledJob).catch((e) => {
      console.warn('[Import Job] Cancel cleanup failed (cron/recompute will reconcile):', e?.message || e);
    });

    return res.json(cancelledJob);
  } catch (error) {
    console.error('[Import Job] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to process job request' });
  }
}
