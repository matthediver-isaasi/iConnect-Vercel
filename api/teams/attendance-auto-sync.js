import { supabase } from '../_lib/database.js';
import { syncTeamsAttendanceBinding } from '../_lib/teamsAttendanceService.js';

const AUTO_SYNC_SECRET = process.env.ATTENDANCE_AUTO_SYNC_SECRET
  || process.env.CRON_SECRET
  || process.env.ZOOM_AUTO_SYNC_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  if (!AUTO_SYNC_SECRET || bearer !== AUTO_SYNC_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing attendance auto-sync secret' });
  }
  try {
    const now = Date.now();
    const reportDelayCutoff = new Date(now - 30 * 60 * 1000).toISOString();
    const maxAge = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.from('teams_attendance_binding').select('*')
      .eq('enabled', true)
      .is('terminal_error', null)
      .lt('scheduled_end_at', reportDelayCutoff)
      .gt('scheduled_end_at', maxAge)
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date(now).toISOString()}`)
      .order('scheduled_end_at', { ascending: true })
      .limit(100);
    if (error) throw new Error(`Failed to load Teams attendance queue: ${error.message}`);
    const results = [];
    for (const binding of data || []) {
      try {
        results.push({
          bindingId: binding.id, targetType: binding.target_type, targetId: binding.target_id,
          ...await syncTeamsAttendanceBinding(binding),
        });
      } catch (syncError) {
        results.push({
          bindingId: binding.id, targetType: binding.target_type, targetId: binding.target_id,
          success: false, error: syncError.message,
        });
      }
    }
    return res.json({
      success: true, totalProcessed: results.length,
      synced: results.filter(item => item.success && !item.skipped).length,
      pending: results.filter(item => item.pending).length,
      failed: results.filter(item => !item.success && !item.pending).length,
      results,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Teams attendance auto-sync failed' });
  }
}