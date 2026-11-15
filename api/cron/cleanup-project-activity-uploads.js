import { supabase } from '../_lib/database.js';
import { cleanupProjectActivityUploads } from '../_lib/projectActivityUploadCleanup.js';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    return res.json(await cleanupProjectActivityUploads(supabase));
  } catch (error) {
    console.error('[Activity upload cleanup]', error.code || 'cleanup_failed');
    return res.status(503).json({ error: 'Cleanup failed; pending uploads retained for retry' });
  }
}
