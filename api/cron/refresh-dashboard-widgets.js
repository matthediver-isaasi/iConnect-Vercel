import { timingSafeEqual } from 'node:crypto';
import { supabase } from '../_lib/database.js';
import { runCacheScheduler } from '../dashboard/_lib/resultCache.js';

export function createHandler(overrides = {}) {
  const deps = { supabase, runCacheScheduler, secret: process.env.CRON_SECRET, ...overrides };
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const expected = Buffer.from(`Bearer ${deps.secret || ''}`);
    const actual = Buffer.from(String(req.headers?.authorization || ''));
    if (!deps.secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!deps.supabase) return res.status(503).json({ error: 'Database not configured' });
    try {
      return res.status(200).json(await deps.runCacheScheduler(deps.supabase));
    } catch (error) {
      console.error('[Dashboard cache] scheduler failed', error);
      return res.status(503).json({ error: 'Dashboard cache scheduler failed' });
    }
  };
}

export default async function handler(req, res) {
  return createHandler()(req, res);
}