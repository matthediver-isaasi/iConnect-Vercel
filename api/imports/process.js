import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
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

// Returns the authorization mode for this invocation, or null if unauthorized:
//   'token'   per-job worker token (enqueue kick / cron / self-trigger)
//   'cron'    platform CRON_SECRET (defence in depth for direct cron)
//   'session' a signed-in member of the job's OWN tenant
async function authorizeWorker(req, job) {
  const token = req.query?.token || '';
  if (job?.worker_token && token && token === job.worker_token) return 'token';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization === `Bearer ${cronSecret}`) return 'cron';
  // Session callers are how imports run on Vercel preview deployments:
  // server-to-server worker kicks (enqueue kick, cron, self-trigger) can't
  // reach the protection-gated preview, but the user's authenticated browser
  // request can, so the Import Manager drives each slice itself.
  try {
    const session = await getSession(req);
    const memberId = session?.data?.memberId;
    if (memberId && job?.tenant_id) {
      const { data: member } = await supabase
        .from('member')
        .select('tenant_id')
        .eq('id', memberId)
        .single();
      if (member?.tenant_id && member.tenant_id === job.tenant_id) return 'session';
    }
  } catch {
    /* fall through to deny */
  }
  return null;
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

  const authMode = await authorizeWorker(req, job);
  if (!authMode) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // A session caller is the user's browser driving its own import (preview).
  const browserDriven = authMode === 'session';

  // Terminal jobs need no work. 'cancelled' is terminal: a user aborted the
  // import, so the chain must stop advancing the cursor.
  if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) {
    return res.status(200).json({ ok: true, status: job.status, alreadyDone: true });
  }

  // The handoff fast-path claims by matching the EXACT current heartbeat, which
  // during an active slice would let a kick preempt a worker mid-slice and
  // double-process. Only trusted server-side chain continuations (self-trigger /
  // cron) may use it; the browser driver always takes the safe non-handoff path
  // (which never preempts a fresh heartbeat).
  const isHandoff = !browserDriven && (req.query?.handoff || '') === '1';

  if (!job.storage_bucket || !job.storage_path) {
    await failJob(jobId, 'Import file reference is missing; cannot process.');
    return res.status(200).json({ ok: false, status: 'failed' });
  }

  const nowIso = new Date().toISOString();

  // Atomic claim (compare-and-swap): only the invocation whose predicate still
  // holds at write time wins, guaranteeing exactly one worker processes each
  // cursor slice even under overlapping enqueue / cron / handoff / browser kicks.
  // PostgREST does NOT support .or() on an UPDATE (it fails with "column
  // csv_import_job.status does not exist"), so each runnable state is claimed by
  // its own single-predicate UPDATE; a concurrent claimer then sees the freshly
  // written status/heartbeat and matches zero rows. started_at is set only on
  // the first claim.
  const claimPayload = {
    status: 'processing',
    heartbeat_at: nowIso,
    started_at: job.started_at || nowIso,
    updated_at: nowIso,
  };
  const attemptClaim = async (apply) => {
    const { data, error } = await apply(
      supabase.from('csv_import_job').update(claimPayload).eq('id', jobId)
    ).select('id');
    if (error) return { error };
    return { claimed: !!(data && data.length) };
  };

  let result_claim = { claimed: false };
  if (isHandoff) {
    // Trusted server-chain continuation: claim only by matching the EXACT
    // heartbeat we observed. The non-terminal guard closes the load->claim
    // window where the job was cancelled/finished after we read it but before
    // we claim (cancel changes status but leaves the heartbeat unchanged).
    result_claim = await attemptClaim((q) => {
      q = q.not('status', 'in', '(completed,completed_with_errors,failed,cancelled)');
      return job.heartbeat_at ? q.eq('heartbeat_at', job.heartbeat_at) : q.is('heartbeat_at', null);
    });
  } else {
    // Fresh kick (enqueue / cron / browser driver): claim a runnable job no live
    // worker owns. Each branch pins status to 'queued' or 'processing', which
    // inherently excludes terminal AND 'initializing' rows — so no separate
    // guard is needed, and a cancelled job can never be revived. An active slice
    // keeps a fresh heartbeat and matches none of these, so it is never
    // preempted.
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    // 1) still queued (any heartbeat)
    result_claim = await attemptClaim((q) => q.eq('status', 'queued'));
    // 2) processing with a RELEASED (null) heartbeat — left by a prior browser slice
    if (!result_claim.error && !result_claim.claimed) {
      result_claim = await attemptClaim((q) => q.eq('status', 'processing').is('heartbeat_at', null));
    }
    // 3) processing with a STALE heartbeat — prior owner presumed dead
    if (!result_claim.error && !result_claim.claimed) {
      result_claim = await attemptClaim((q) => q.eq('status', 'processing').lt('heartbeat_at', staleBefore));
    }
  }

  if (result_claim.error) {
    console.error('[Import Worker] Could not claim job:', result_claim.error.message);
    return res.status(500).json({ error: 'Could not claim job' });
  }
  if (!result_claim.claimed) {
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

    // A browser-driven, non-final slice RELEASES the lease (null heartbeat) so
    // the user's next poll-drive can immediately claim the following slice
    // without waiting out the staleness window. Server chains keep a fresh
    // heartbeat and hand off via self-trigger instead.
    const releaseLease = browserDriven && !result.done;

    const update = {
      cursor_offset: result.done ? records.length : result.offset,
      processed_count: processed,
      success_count: processed,
      created_count: result.created,
      updated_count: result.updated,
      skipped_count: result.skipped,
      error_count: result.errors,
      notes_created: result.notes,
      heartbeat_at: releaseLease ? null : heartbeatIso,
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

    // Conditional on the job NOT having been cancelled mid-slice: a user may
    // have cancelled while this slice was running. The cancel endpoint flips the
    // status to 'cancelled'; without this guard our 'processing' write would
    // revert that and the chain would keep going. Excluding 'cancelled' here
    // leaves the terminal state intact and stops the loop.
    const { data: updatedRows, error: updateError } = await supabase
      .from('csv_import_job')
      .update(update)
      .eq('id', jobId)
      .neq('status', 'cancelled')
      .select('id');

    // The progress write must not be swallowed: if the cursor/totals for this
    // slice did not persist, self-triggering would reprocess the same rows and
    // double-insert. Treat a failed progress write as a hard failure instead.
    if (updateError) {
      console.error('[Import Worker] Progress update failed:', updateError.message);
      await failJob(jobId, `Failed to persist import progress: ${updateError.message}`);
      await cleanupImportJobFile(supabase, job);
      return res.status(200).json({ ok: false, status: 'failed' });
    }

    // Zero rows updated means the job was cancelled during this slice. The rows
    // processed this slice are already committed; persist their counts WITHOUT
    // touching the terminal status, then stop the chain (no self-trigger).
    if (!updatedRows || updatedRows.length === 0) {
      try {
        await supabase
          .from('csv_import_job')
          .update({
            processed_count: update.processed_count,
            success_count: update.success_count,
            created_count: update.created_count,
            updated_count: update.updated_count,
            skipped_count: update.skipped_count,
            error_count: update.error_count,
            notes_created: update.notes_created,
            cursor_offset: update.cursor_offset,
            ...(update.errors ? { errors: update.errors } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
          .eq('status', 'cancelled');
      } catch (e) {
        console.warn('[Import Worker] Could not record counts on cancelled job:', e.message);
      }
      return res.status(200).json({ ok: true, status: 'cancelled', cancelled: true });
    }

    if (!result.done) {
      // Server chain (enqueue/cron) hands off to the next slice immediately via
      // a self-trigger. The browser driver instead relies on its own next poll
      // (the lease was just released above), so it must NOT self-trigger — a
      // server-to-server kick can't reach a protected preview deployment anyway.
      if (!browserDriven) {
        await triggerSelf(req, { id: jobId, worker_token: job.worker_token });
      }
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
