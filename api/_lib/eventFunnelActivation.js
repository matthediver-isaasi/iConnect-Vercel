import { timingSafeEqual } from 'node:crypto';

// Authenticate before recording health. A Vercel preview must never claim the
// production worker's heartbeat or process production queues.
export function withFunnelWorkerActivation({ db, worker, handler,
  getRuntime = () => ({ environment: process.env.VERCEL_ENV, release: process.env.VERCEL_GIT_COMMIT_SHA }),
  getSecret = () => process.env.CRON_SECRET }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const secret = getSecret(), supplied = req.headers?.authorization;
    const expected = typeof secret === 'string' && secret ? `Bearer ${secret}` : null;
    if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const runtime = getRuntime();
    if (runtime?.environment !== 'production' || !/^[a-f0-9]{40,64}$/.test(runtime?.release || '')) {
      return res.status(200).json({ status: 'disabled', reason: 'No verified production runtime' });
    }
    try {
      const admission = await db.rpc('event_funnel_worker_admission', {
        p_worker: worker, p_version: 1, p_release: runtime.release,
      });
      if (admission.error || admission.data?.version !== 1 || typeof admission.data.enabled !== 'boolean') {
        return res.status(503).json({ error: 'Funnel worker activation could not be verified' });
      }
      if (!admission.data.enabled) return res.status(200).json({ status: 'disabled' });
    } catch {
      return res.status(503).json({ error: 'Funnel worker activation could not be verified' });
    }
    return handler(req, res);
  };
}
