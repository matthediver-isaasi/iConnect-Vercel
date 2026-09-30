import { supabase } from '../_lib/database.js';
import { processAttendanceTransitionOutbox } from '../_lib/attendanceTransitionProcessor.js';
import { processCpdBadgeOutbox } from '../_lib/eventCpdBadgeService.js';
import { processCpdPointsOutbox } from '../_lib/eventCpdPointsService.js';

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
    // Start all three processors independently. A synchronous/rejected workflow
    // processor must not prevent either CPD feature from claiming its work.
    const [workflows, badges, points] = await Promise.allSettled([
      processAttendanceTransitionOutbox(supabase, {
        limit: req.query?.limit,
        baseUrl,
      }),
      processCpdBadgeOutbox(supabase, { limit: req.query?.limit }),
      processCpdPointsOutbox(supabase, { limit: req.query?.limit }),
    ]);
    const result = workflows.status === 'fulfilled'
      ? workflows.value : { error: workflows.reason?.message || 'Workflow processing failed' };
    result.cpdBadges = badges.status === 'fulfilled'
      ? badges.value : { error: badges.reason?.message || 'CPD badge processing failed' };
    result.cpdPoints = points.status === 'fulfilled'
      ? points.value : { error: points.reason?.message || 'CPD points processing failed' };
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[AttendanceTransitionOutbox] Processing failed:', error);
    return res.status(500).json({ error: error?.message || 'Processing failed' });
  }
}