import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';
import { parseImportFile } from '../_lib/importFileParser.js';
import { addTenantStorageBytes } from '../_lib/tenantStorageUsage.js';

// Starts a member/organization import as a background job. The file is uploaded
// once to tenant-scoped storage and a csv_import_job row is created in the
// 'queued' state; a worker (api/imports/process.js, kicked here and backstopped
// by the cron) then processes the whole file headlessly. Returns immediately so
// the user can close the tab — the Import Manager polls job status for progress.

const STORAGE_BUCKET = 'private-uploads';
// How long to wait for the initial worker kick before abandoning the caller's
// side of the connection. The worker invocation runs to completion independent
// of this signal; the cron backstop also picks up the queued job regardless.
const DISPATCH_ABORT_MS = 2000;

function sanitizeFileName(name) {
  return String(name || 'import.csv')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

async function dispatchWorker(origin, job) {
  if (!origin) return;
  const url = `${origin}/api/imports/process?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(job.worker_token)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DISPATCH_ABORT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError is expected (we deliberately don't wait for the worker to
    // finish). Any other failure is non-fatal: the cron will pick it up.
    if (!err || err.name !== 'AbortError') {
      console.warn('[Import Enqueue] worker kick failed (cron will retry):', err?.message);
    }
  } finally {
    clearTimeout(t);
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let tenantId = null;
  try {
    const { data: member } = await supabase
      .from('member')
      .select('tenant_id')
      .eq('id', session.data.memberId)
      .single();
    tenantId = member?.tenant_id || null;
  } catch (e) {
    console.log('[Import Enqueue] Could not resolve tenant_id:', e.message);
  }
  if (!tenantId) {
    return res.status(400).json({
      error: 'Could not determine your organisation for this import. Please sign out and back in, then try again.',
    });
  }

  let jobId = null;
  try {
    const { file, fields } = await parseMultipartForm(req);
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { entityType, identifierField, mappings: mappingsStr } = fields;
    const mappings = mappingsStr ? JSON.parse(mappingsStr) : [];
    if (!entityType || !identifierField || !mappings.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const identifierMapping = mappings.find((m) => m.targetField === identifierField);
    if (!identifierMapping) {
      return res.status(400).json({ error: `No mapping for identifier field: ${identifierField}` });
    }

    // Parse once up-front so the job knows its total row count immediately (the
    // worker re-parses the stored file each slice). This validates the file too.
    const { records, isXlsx } = await parseImportFile(file);
    const totalRows = records.length;
    if (totalRows === 0) {
      return res.status(400).json({ error: 'The uploaded file has no data rows.' });
    }

    const activeMappings = mappings.filter((m) => m && m.targetField);

    // Create the job in a non-runnable 'initializing' state so we have an id for
    // a stable storage path WITHOUT exposing it to the worker/cron before the
    // file is actually stored. It is flipped to 'queued' only after a successful
    // upload — otherwise the minute cron could grab a queued-but-fileless row and
    // permanently fail a valid import.
    const { data: job, error: insertError } = await supabase
      .from('csv_import_job')
      .insert({
        tenant_id: tenantId,
        entity_type: entityType,
        status: 'initializing',
        file_name: file.originalname || (isXlsx ? 'import.xlsx' : 'import.csv'),
        total_rows: totalRows,
        identifier_field: identifierField,
        mappings: activeMappings,
        requested_by_member_id: session.data.memberId,
        cursor_offset: 0,
      })
      .select('id, worker_token')
      .single();

    if (insertError || !job) {
      console.error('[Import Enqueue] Could not create job:', insertError?.message);
      return res.status(500).json({ error: 'Could not start the import job. Please try again.' });
    }
    jobId = job.id;

    // Persist the uploaded file to tenant-scoped private storage.
    const storagePath = `${tenantId}/imports/${jobId}/${sanitizeFileName(file.originalname)}`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        cacheControl: '3600',
        upsert: true,
      });

    if (uploadError) {
      console.error('[Import Enqueue] Storage upload failed:', uploadError.message);
      await supabase
        .from('csv_import_job')
        .update({
          status: 'failed',
          errors: [{ error: `Could not store the uploaded file: ${uploadError.message}` }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return res.status(500).json({ error: 'Could not store the uploaded file. Please try again.' });
    }

    // File is stored: atomically flip the job to runnable. Only now can the
    // worker/cron claim it, and the storage refs are guaranteed present.
    const { error: readyError } = await supabase
      .from('csv_import_job')
      .update({
        storage_bucket: STORAGE_BUCKET,
        storage_path: storagePath,
        status: 'queued',
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (readyError) {
      console.error('[Import Enqueue] Could not mark job ready:', readyError.message);
      // Roll back the orphaned upload so it doesn't linger in storage.
      try { await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch { /* best effort */ }
      await supabase
        .from('csv_import_job')
        .update({
          status: 'failed',
          errors: [{ error: `Could not finalise the import job: ${readyError.message}` }],
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      return res.status(500).json({ error: 'Could not start the import job. Please try again.' });
    }

    // Count the stored source file against the tenant's storage usage. The
    // worker (or cron backstop) decrements this again once the job finishes and
    // the file is cleaned up. Best-effort: nightly recompute re-baselines drift.
    addTenantStorageBytes(tenantId, file.buffer.length).catch(() => {});

    // Kick the worker immediately; the cron backstop will also pick it up.
    await dispatchWorker(getOrigin(req), job);

    return res.status(202).json({
      success: true,
      jobId,
      status: 'queued',
      totalRows,
    });
  } catch (error) {
    console.error('[Import Enqueue] Error:', error);
    if (jobId) {
      try {
        await supabase
          .from('csv_import_job')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', jobId);
      } catch { /* best effort */ }
    }
    return res.status(500).json({ error: error.message || 'Failed to start import' });
  }
}
