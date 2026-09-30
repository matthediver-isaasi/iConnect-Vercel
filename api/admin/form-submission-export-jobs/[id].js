import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const SIGNED_URL_EXPIRY_SECONDS = 60 * 60; // 1 hour

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) return res.status(401).json({ error: 'Not authenticated' });

  const tenantId = sessionMember.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });

  const jobId = req.query.id;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const { data: job, error } = await supabase
    .from('form_submission_export_job')
    .select('id, tenant_id, status, phase, processed, total, file_name, storage_bucket, storage_path, file_size_bytes, error_message, created_at, started_at, completed_at')
    .eq('id', jobId)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Export job not found' });
  if (job.tenant_id !== tenantId) return res.status(403).json({ error: 'Access denied' });

  let downloadUrl = null;
  if (job.status === 'complete' && job.storage_bucket && job.storage_path) {
    const { data: signed, error: signError } = await supabase.storage
      .from(job.storage_bucket)
      .createSignedUrl(job.storage_path, SIGNED_URL_EXPIRY_SECONDS, {
        download: job.file_name || true,
      });
    if (signError) {
      console.error('[form-submission-export-jobs/:id] signed URL error:', signError);
    } else {
      downloadUrl = signed?.signedUrl || null;
    }
  }

  return res.status(200).json({
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    processed: job.processed,
    total: job.total,
    fileName: job.file_name,
    fileSizeBytes: job.file_size_bytes,
    error: job.error_message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    downloadUrl,
  });
}
