import { supabase } from '../_lib/database.js';
import { sendEmail } from '../_lib/emailService.js';

/**
 * Sends a single 24-hour reminder to every "going" RSVP for any group event
 * starting in the next 24 hours. Dedup via event_rsvp.reminder_sent_at —
 * once stamped, a row is never re-sent. Group-event-only (member_group_id
 * IS NOT NULL); regular events go through send-event-reminders.
 *
 * Schedule (vercel.json): every 30 minutes. Guarded by CRON_SECRET.
 */
export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const { data: events, error: eventsErr } = await supabase
    .from('event')
    .select('id, title, start_date, end_date, location, is_online, online_meeting_url, member_group_id, tenant_id')
    .not('member_group_id', 'is', null)
    .gte('start_date', now.toISOString())
    .lte('start_date', horizon.toISOString());

  if (eventsErr) {
    console.error('[cron/send-group-event-reminders] events query failed:', eventsErr.message);
    return res.status(500).json({ error: 'Failed to load events' });
  }

  if (!events || events.length === 0) {
    return res.json({ success: true, processed: 0, sent: 0 });
  }

  let totalSent = 0;
  let processed = 0;

  for (const ev of events) {
    processed++;
    const { data: rsvps } = await supabase
      .from('event_rsvp')
      .select('id, identity_id')
      .eq('event_id', ev.id)
      .eq('response', 'going')
      .is('reminder_sent_at', null);

    if (!rsvps || rsvps.length === 0) continue;

    const identityIds = rsvps.map((r) => r.identity_id);
    const { data: identities } = await supabase
      .from('tenant_identity')
      .select('id, email, first_name')
      .in('id', identityIds);
    const identityById = new Map((identities || []).map((i) => [i.id, i]));

    let groupName = '';
    if (ev.member_group_id) {
      const { data: g } = await supabase
        .from('member_group')
        .select('name')
        .eq('id', ev.member_group_id)
        .maybeSingle();
      groupName = g?.name || '';
    }

    const whenStr = ev.start_date
      ? new Date(ev.start_date).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })
      : '';
    const locationLine = ev.is_online
      ? (ev.online_meeting_url ? `Online: <a href="${ev.online_meeting_url}">${ev.online_meeting_url}</a>` : 'Online event')
      : (ev.location ? `Location: ${ev.location}` : '');

    for (const rsvp of rsvps) {
      const ident = identityById.get(rsvp.identity_id);
      if (!ident?.email) {
        await supabase.from('event_rsvp').update({ reminder_sent_at: new Date().toISOString() }).eq('id', rsvp.id);
        continue;
      }
      const html = `
        <p>Hi ${ident.first_name || ''},</p>
        <p>This is a reminder that <strong>${ev.title}</strong>${groupName ? ` (${groupName})` : ''} starts in less than 24 hours.</p>
        ${whenStr ? `<p>When: ${whenStr}</p>` : ''}
        ${locationLine ? `<p>${locationLine}</p>` : ''}
      `;
      const result = await sendEmail({
        to: ident.email,
        subject: `Reminder: ${ev.title}`,
        html,
        tenantId: ev.tenant_id,
      });
      if (result?.success) totalSent++;
      else console.warn('[cron/send-group-event-reminders] send failed:', result?.error);
      await supabase.from('event_rsvp').update({ reminder_sent_at: new Date().toISOString() }).eq('id', rsvp.id);
    }
  }

  return res.json({ success: true, processed, sent: totalSent });
}
