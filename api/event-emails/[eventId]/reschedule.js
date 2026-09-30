import { supabase } from '../../_lib/database.js';
import { scheduleRemindersForEvent } from '../../_lib/scheduleReminders.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { eventId } = req.query;
  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  try {
    const { mode, requeued, bookingsScheduled, bookingsConsidered, schedulingFailures, skipped, error } =
      await scheduleRemindersForEvent(eventId);

    return res.status(200).json({
      mode,
      requeued: requeued || 0,
      bookingsScheduled: bookingsScheduled || 0,
      bookingsConsidered: bookingsConsidered || 0,
      schedulingFailures: schedulingFailures || [],
      skipped: skipped || [],
      error: error || null,
    });
  } catch (err) {
    console.error('[event-emails/reschedule] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
