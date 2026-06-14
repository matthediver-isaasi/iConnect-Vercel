// Best-effort dispatch of the background import worker (api/imports/process.js).
//
// On Vercel PREVIEW deployments scheduled crons do not run, so the cron backstop
// (api/cron/run-import-jobs.js) never revives a stuck job. The enqueue endpoint's
// initial fire-and-forget kick is also not guaranteed to land. To keep imports
// progressing without cron, the session-authed job-status endpoints (which the
// Import Manager polls) opportunistically nudge the worker whenever a job looks
// stuck. The worker's atomic compare-and-swap claim makes repeated nudges safe:
// if a worker is already actively processing (fresh heartbeat) the nudge's claim
// matches zero rows and simply defers.

const DISPATCH_ABORT_MS = 2000;
// A job whose heartbeat is fresher than this is considered actively owned by a
// running worker; mirrors STALE_AFTER_MS in api/imports/process.js.
const STALE_AFTER_MS = 90 * 1000;

export function getOriginFromReq(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

// A job needs a worker kick when it is runnable but not actively being worked:
// still 'queued', or 'processing' with an absent/stale heartbeat (prior owner
// presumed dead). Non-runnable states ('initializing', terminal) never qualify.
export function jobNeedsKick(job) {
  if (!job || !job.worker_token) return false;
  if (job.status === 'queued') return true;
  if (job.status === 'processing') {
    if (!job.heartbeat_at) return true;
    const last = new Date(job.heartbeat_at).getTime();
    return Number.isFinite(last) && Date.now() - last > STALE_AFTER_MS;
  }
  return false;
}

// Fire the worker for a single job. Fire-and-forget: we abort our side after a
// short window (the worker invocation runs to completion independently on the
// server). Never throws.
export async function dispatchImportWorker(req, job) {
  const origin = getOriginFromReq(req);
  if (!origin || !job?.id || !job?.worker_token) return;
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
    if (!err || err.name !== 'AbortError') {
      console.warn('[Import Dispatch] worker nudge failed:', err?.message);
    }
  } finally {
    clearTimeout(t);
  }
}

// Nudge every stuck job in a list, in parallel, bounded by a cap so a single
// poll never fans out unboundedly. Best-effort; never throws.
export async function nudgeStuckJobs(req, jobs, max = 3) {
  const stuck = (Array.isArray(jobs) ? jobs : []).filter(jobNeedsKick).slice(0, max);
  if (stuck.length === 0) return;
  await Promise.allSettled(stuck.map((job) => dispatchImportWorker(req, job)));
}
