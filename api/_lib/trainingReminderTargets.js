import { formatInTimeZone } from 'date-fns-tz';
import { agendaInstant } from '../../shared/trainingAgendaBounds.js';
import { calculateScheduledTime, isAbsoluteReminder } from './scheduleReminders.js';
import { safeHttpUrl } from './trainingAgenda.js';
import { createHash } from 'node:crypto';

export function trainingTargetSnapshot(event, email, target) {
  const line = target.line;
  return createHash('sha256').update(JSON.stringify([
    event.id, event.timezone || 'Europe/London',
    email.timing_type, email.custom_unit, email.custom_hours_before, email.custom_send_at,
    target.sessionId, target.anchor?.toISOString(), target.scheduledTime.toISOString(),
    line && [line.start_date, line.end_date, line.start_time, line.end_time, line.item_type,
      line.description, line.location, line.lms_url, line.zoom_meeting_id, line.zoom_webinar_id],
  ])).digest('hex');
}

// Day offsets are elapsed 24-hour periods, not local calendar-day subtraction.
export function trainingReminderTargets(event, email, lines, now = new Date()) {
  const timezone = event.timezone || 'Europe/London';
  const targets = [];
  const skipped = [];
  if (isAbsoluteReminder(email)) {
    const send = calculateScheduledTime(null, email);
    if (Number.isFinite(send?.getTime())) targets.push({ sessionId: null, scheduledTime: send, anchor: null, line: null });
  } else {
    const fallback = event.start_date
      ? formatInTimeZone(new Date(event.start_date), timezone, 'HH:mm') : '09:00';
    for (const line of lines || []) {
      if (!line.start_date) continue;
      try {
        const anchor = new Date(agendaInstant(line.start_date, line.start_time, fallback, timezone));
        const scheduledTime = calculateScheduledTime(anchor, email);
        if (!Number.isFinite(scheduledTime?.getTime())) throw new Error('Invalid reminder timing');
        targets.push({ sessionId: line.id, anchor, scheduledTime, line, legacyTime: !line.start_time });
      } catch (error) {
        skipped.push({ session_id: line.id, reason: error.message });
      }
    }
  }
  targets.sort((a, b) => a.scheduledTime - b.scheduledTime || String(a.sessionId).localeCompare(String(b.sessionId)));
  return {
    targets,
    eligible: targets.filter(t => t.scheduledTime > now && (!t.anchor || t.anchor > now)),
    skipped,
    timezone,
  };
}

export function trainingReminderEvent(event, target) {
  if (!target?.line) return event;
  return {
    ...event,
    start_date: target.anchor.toISOString(),
    location: target.line.location || '',
    is_online: !!safeHttpUrl(target.line.zoom_join_url),
    // Never substitute an unrelated parent meeting for a session.
    zoom_join_url: safeHttpUrl(target.line.zoom_join_url),
  };
}

export function validateTrainingReminder(event, email, row, lines, now = new Date()) {
  if (!email.is_enabled || email.email_type !== 'reminder') return { reason: 'Reminder disabled or removed' };
  const { targets } = trainingReminderTargets(event, email, lines, now);
  const target = targets.find(t => (t.sessionId || null) === (row.session_id || null));
  if (!target) return { reason: 'Training agenda target removed or invalid' };
  if (target.scheduledTime.getTime() !== new Date(row.scheduled_send_time).getTime()) {
    return { reason: 'Reminder timing changed; use Re-queue reminders' };
  }
  if (row.training_target_snapshot !== trainingTargetSnapshot(event, email, target)) {
    return { reason: 'Training target changed or is a legacy target; use Re-queue reminders' };
  }
  if (target.anchor && target.anchor <= now) return { reason: 'Training session has already started' };
  return { target };
}
