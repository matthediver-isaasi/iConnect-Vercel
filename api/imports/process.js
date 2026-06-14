import { supabase } from '../_lib/database.js';
import { parseImportFile } from '../_lib/importFileParser.js';
import { processImportSlice } from '../_lib/importProcessor.js';
import { cleanupImportJobFile } from '../_lib/importFileCleanup.js';

// Headless background worker for member/organization imports. Invoked by the
// enqueue endpoint and backstopped by the cron (api/cron/run-import-jobs.js).
// Each invocation claims a single job, processes one time-budgeted slice of
// rows from the stored file using the shared slice processor, advances the
// cursor + running totals, and either self-triggers the next slice or finalises
// the job. Concurrency is guarded by a heartbeat: a fresh heartbeat means
// another invocation is already working the job.

// Stop processing new batches after this many ms so download + final writes +
// self-trigger comfortably fit under the 60s function ceiling.
const SLICE_TIME_BUDGET_MS = 40000;
// A job whose heartbeat is fresher than this is considered actively owned by
// another invocation; we back off instead of double-processing.
const STALE_AFTER_MS = 90 * 1000;
const DISPATCH_ABORT_MS = 2000;

export const config = {
  maxDuration: 60,
};

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

function isAuthorized(req, job) {
  // Either the per-job worker token (used by enqueue + cron dispatch) or the
  // platform CRON_SECRET (defence in depth for direct cron invocation).
  const token = req.query?.token || '';
  if (job?.worker_token && token && token === job.worker_token) return true;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`) return true;
  return false;
}

async function triggerSelf(req, job) {
  const origin = getOrigin(req);
  if (!origin) return;
  // handoff=1 marks this as the legitimate continuation of the chain so the
  // next invocation bypasses the freshness lock (which exists to reject
  // duplicate/cron kicks, not the chain's own next slice).
  const url = `${origin}/api/imports/process?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(job.worker_token)}&handoff=1`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DISPATCH_ABORT_MS);
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal });
  } catch (err) {
    if (!err || err.name !== 'AbortError') {
      console.warn('[Import Worker] self-trigger failed (cron will resume):', err?.message);
    }
  } finally {
    clearTimeout(t);
  }
}

async function failJob(jobId, message) {
  try {
    const { data: existing } = await supabase
      .from('csv_import_job')
      .select('errors')
      .eq('id', jobId)
      .single();
    const prev = Array.isArray(existing?.errors) ? existing.errors : [];
    await supabase
      .from('csv_import_job')
      .update({
        status: 'failed',
        errors: prev.concat([{ error: message }]).slice(0, 100),
        completed_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (e) {
    console.error('[Import Worker] Could not mark job failed:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const jobId = req.query?.jobId || req.body?.jobId;
  if (!jobId) {
    return res.status(400).json({ error: 'Missing jobId' });
  }

  const { data: job, error: loadError } = await supabase
    .from('csv_import_job')
    .select('*')
    .eq('id', jobId)
    .single();

  if (loadError || !job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (!isAuthorized(req, job)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Terminal jobs need no work.
  if (['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
    return res.status(200).json({ ok: true, status: job.status, alreadyDone: true });
  }

  const isHandoff = (req.query?.handoff || '') === '1';

  if (!job.storage_bucket || !job.storage_path) {
    await failJob(jobId, 'Import file reference is missing; cannot process.');
    return res.status(200).json({ ok: false, status: 'failed' });
  }

  const nowIso = new Date().toISOString();

  // Atomic claim (compare-and-swap). The claim is a single conditional UPDATE
  // with RETURNING; only the invocation whose predicate still holds at write
  // time wins, which guarantees exactly one worker processes each cursor slice
  // even under overlapping enqueue / cron / handoff kicks.
  //  - handoff: the continuation must match the EXACT heartbeat it observed
  //    (the predecessor's). Concurrent duplicate handoffs race on the same
  //    heartbeat value; the first flips it, the rest match zero rows and defer.
  //  - otherwise (enqueue/cron/manual): claim only if the job is still queued
  //    or its heartbeat is stale (the prior owner is presumed dead).
  // started_at is set only on the first claim.
  let claimQuery = supabase
    .from('csv_import_job')
    .update({
      status: 'processing',
      heartbeat_at: nowIso,
      started_at: job.started_at || nowIso,
      updated_at: nowIso,
    })
    .eq('id', jobId);

  if (isHandoff) {
    claimQuery = job.heartbeat_at
      ? claimQuery.eq('heartbeat_at', job.heartbeat_at)
      : claimQuery.is('heartbeat_at', null);
  } else {
    // Only a runnable job is claimable here: still 'queued', or 'processing'
    // with a stale heartbeat (prior owner presumed dead). A non-runnable row
    // (e.g. 'initializing' before its file is stored) is never claimed, even
    // though its heartbeat is null.
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    claimQuery = claimQuery.or(
      `status.eq.queued,heartbeat_at.lt.${staleBefore}`
    );
  }

  const { data: claimedRows, error: claimError } = await claimQuery.select('id');
  if (claimError) {
    console.error('[Import Worker] Could not claim job:', claimError.message);
    return res.status(500).json({ error: 'Could not claim job' });
  }
  if (!claimedRows || claimedRows.length === 0) {
    // Lost the race: another invocation owns this job (or it advanced/finished
    // between our read and our claim). Defer — never process without the claim.
    return res.status(200).json({ ok: true, status: job.status, skipped: 'already-running' });
  }

  try {
    // Download + parse the stored file.
    const { data: blob, error: downloadError } = await supabase.storage
      .from(job.storage_bucket)
      .download(job.storage_path);

    if (downloadError || !blob) {
      await failJob(jobId, `Could not download the import file: ${downloadError?.message || 'unknown error'}`);
      await cleanupImportJobFile(supabase, job);
      return res.status(200).json({ ok: false, status: 'failed' });
    }

    const buffer = Buffer.from(await blob.arrayBuffer());
    const { records } = await parseImportFile({
      originalname: job.file_name || 'import.csv',
      buffer,
    });

    const offset = Math.max(0, parseInt(job.cursor_offset, 10) || 0);
    const mappings = Array.isArray(job.mappings) ? job.mappings : [];

    const result = await processImportSlice({
      supabase,
      records,
      offset,
      mappings,
      entityType: job.entity_type,
      identifierField: job.identifier_field,
      tenantId: job.tenant_id,
      authorMemberId: job.requested_by_member_id || null,
      forceJsPath: job.force_path === 'js',
      running: {
        created: job.created_count,
        updated: job.updated_count,
        skipped: job.skipped_count,
        errors: job.error_count,
        notes: job.notes_created,
      },
      timeBudgetMs: SLICE_TIME_BUDGET_MS,
    });

    const processed = result.created + result.updated;
    const heartbeatIso = new Date().toISOString();

    const update = {
      cursor_offset: result.done ? records.length : result.offset,
      processed_count: processed,
      success_count: processed,
      created_count: result.created,
      updated_count: result.updated,
      skipped_count: result.skipped,
      error_count: result.errors,
      notes_created: result.notes,
      heartbeat_at: heartbeatIso,
      updated_at: heartbeatIso,
      status: result.done ? (result.errors > 0 ? 'completed_with_errors' : 'completed') : 'processing',
    };
    // Pin the path once we've fallen back to / are on the JS path.
    if (result.path === 'js' && job.force_path !== 'js') {
      update.force_path = 'js';
    }
    if (result.done) {
      update.completed_at = heartbeatIso;
    }
    // Append this slice's errors to the persisted sample (capped).
    if (Array.isArray(result.errorLog) && result.errorLog.length > 0) {
      const prev = Array.isArray(job.errors) ? job.errors : [];
      update.errors = prev.concat(result.errorLog).slice(0, 100);
    }

    const { error: updateError } = await supabase
      .from('csv_import_job')
      .update(update)
      .eq('id', jobId);

    // The progress write must not be swallowed: if the cursor/totals for this
    // slice did not persist, self-triggering would reprocess the same rows and
    // double-insert. Treat a failed progress write as a hard failure instead.
    if (updateError) {
      console.error('[Import Worker] Progress update failed:', updateError.message);
      await failJob(jobId, `Failed to persist import progress: ${updateError.message}`);
      await cleanupImportJobFile(supabase, job);
      return res.status(200).json({ ok: false, status: 'failed' });
    }

    if (!result.done) {
      // Keep the loop going. Use the freshest token in case it changed.
      await triggerSelf(req, { id: jobId, worker_token: job.worker_token });
      return res.status(200).json({ ok: true, status: 'processing', offset: update.cursor_offset });
    }

    // Job reached a terminal state: the stored source file is no longer needed,
    // so delete it and release the storage it claimed against the tenant quota.
    await cleanupImportJobFile(supabase, job);
    return res.status(200).json({ ok: true, status: update.status, done: true });
  } catch (error) {
    console.error('[Import Worker] Error processing job:', error);
    await failJob(jobId, error.message || 'Import failed while processing.');
    await cleanupImportJobFile(supabase, job);
    return res.status(200).json({ ok: false, status: 'failed' });
  }
}
