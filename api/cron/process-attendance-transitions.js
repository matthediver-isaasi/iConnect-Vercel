import { supabase } from '../_lib/database.js';
import { processAttendanceTransitionOutbox } from '../_lib/attendanceTransitionProcessor.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = host ? `${protocol}://${host}` : undefined;
    const result = await processAttendanceTransitionOutbox(supabase, {
      limit: req.query?.limit,
      baseUrl,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[AttendanceTransitionOutbox] Processing failed:', error);
    return res.status(500).json({ error: error?.message || 'Processing failed' });
  }
}