import { createClient } from '@supabase/supabase-js';

// Cron backstop for background member/organization imports. Picks up jobs that
// are queued (never kicked, or whose initial kick failed) and jobs stuck in
// 'processing' with a stale heartbeat (a worker died mid-run), and (re)dispatches
// the worker. Mirrors run-form-submission-export-jobs.js.

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const FIVE_MIN_MS = 5 * 60 * 1000;
const MAX_JOBS_PER_RUN = 3;
const DISPATCH_ABORT_MS = 2000;

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

async function dispatchWorker(origin, job) {
  const url = `${origin}/api/imports/process?jobId=${encodeURIComponent(job.id)}&token=${encodeURIComponent(job.worker_token)}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DISPATCH_ABORT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    return { jobId: job.id, ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { jobId: job.id, ok: true };
    }
    console.warn('[cron/run-import-jobs] trigger failed:', err?.message);
    return { jobId: job.id, ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const staleBefore = new Date(Date.now() - FIVE_MIN_MS).toISOString();

  const { data: queued, error: queuedErr } = await supabase
    .from('csv_import_job')
    .select('id, worker_token, status, heartbeat_at')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(MAX_JOBS_PER_RUN);

  if (queuedErr) {
    console.error('[cron/run-import-jobs] queued query error:', queuedErr);
  }

  const remaining = MAX_JOBS_PER_RUN - (queued?.length || 0);
  let stale = [];
  if (remaining > 0) {
    const { data: staleRows, error: staleErr } = await supabase
      .from('csv_import_job')
      .select('id, worker_token, status, heartbeat_at')
      .eq('status', 'processing')
      .or(`heartbeat_at.is.null,heartbeat_at.lt.${staleBefore}`)
      .order('created_at', { ascending: true })
      .limit(remaining);
    if (staleErr) {
      console.error('[cron/run-import-jobs] stale query error:', staleErr);
    }
    stale = staleRows || [];
  }

  const jobs = [...(queued || []), ...stale];
  const origin = getOrigin(req);

  if (!origin) {
    return res.status(500).json({ error: 'No origin available to dispatch workers' });
  }

  const results = await Promise.allSettled(jobs.map((job) => dispatchWorker(origin, job)));
  const triggered = [];
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) triggered.push(r.value.jobId);
    else if (r.status === 'fulfilled') failed.push({ jobId: r.value.jobId, error: r.value.error });
    else failed.push({ error: String(r.reason?.message || r.reason) });
  }

  if (failed.length) {
    console.warn('[cron/run-import-jobs] dispatch failures:', failed);
  }

  return res.status(200).json({ ok: true, triggered, failed });
}
