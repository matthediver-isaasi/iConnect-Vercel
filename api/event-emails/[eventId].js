import { supabase } from '../_lib/database.js';
import {
  scheduleReminderEmails,
  scheduleComplexEventReminderEmails,
} from '../_lib/scheduleReminders.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { eventId } = req.query;

  if (!eventId) {
    return res.status(400).json({ error: 'Event ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('event_email')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[event-emails] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch email configurations' });
      }

      return res.status(200).json(data || []);
    } catch (err) {
      console.error('[event-emails] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { emails, is_complex_event } = req.body;

      if (!Array.isArray(emails)) {
        return res.status(400).json({ error: 'Emails must be an array' });
      }

      const { data: existingEmails, error: fetchError } = await supabase
        .from('event_email')
        .select('id')
        .eq('event_id', eventId);

      if (fetchError) {
        console.error('[event-emails] Fetch existing error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch existing emails' });
      }

      const existingIds = new Set(existingEmails?.map(e => e.id) || []);
      const incomingIds = new Set(emails.filter(e => !e.isNew).map(e => e.id));

      const idsToDelete = [...existingIds].filter(id => !incomingIds.has(id));
      if (idsToDelete.length > 0) {
        const { error: deleteError } = await supabase
          .from('event_email')
          .delete()
          .in('id', idsToDelete);

        if (deleteError) {
          console.error('[event-emails] Delete error:', deleteError);
          return res.status(500).json({ error: 'Failed to delete removed email configurations' });
        }
      }

      const ccEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of emails) {
        if (!email.cc || typeof email.cc !== 'string') continue;
        const parts = email.cc.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = parts.filter(p => !ccEmailRegex.test(p));
        if (invalid.length > 0) {
          return res.status(400).json({
            error: `Invalid CC email address: ${invalid.join(', ')}`
          });
        }
      }

      const savedEmails = [];
      const errors = [];

      for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        const resolvedUnit = email.timing_type === 'custom' ? (email.custom_unit || 'hours') : null;
        const resolvedSendAt = (email.timing_type === 'custom' && resolvedUnit === 'specific_datetime' && email.custom_send_at)
          ? email.custom_send_at : null;

        const normalizedCc = typeof email.cc === 'string'
          ? email.cc.split(',').map(s => s.trim()).filter(Boolean).join(', ')
          : '';

        const emailData = {
          event_id: eventId,
          email_type: email.email_type,
          timing_type: email.timing_type || null,
          custom_hours_before: email.custom_hours_before || null,
          custom_unit: resolvedUnit,
          custom_send_at: resolvedSendAt,
          subject: email.subject,
          body: email.body,
          cc: normalizedCc || null,
          is_enabled: email.is_enabled !== false,
          is_complex_event: is_complex_event || false,
          updated_at: new Date().toISOString()
        };

        if (email.isNew || !existingIds.has(email.id)) {
          const { data: inserted, error: insertError } = await supabase
            .from('event_email')
            .insert(emailData)
            .select()
            .single();

          if (insertError) {
            console.error('[event-emails] Insert error:', insertError);
            errors.push({ email_type: email.email_type, error: insertError.message, request_index: i });
            continue;
          }
          savedEmails.push(inserted);
        } else {
          const { data: updated, error: updateError } = await supabase
            .from('event_email')
            .update(emailData)
            .eq('id', email.id)
            .select()
            .single();

          if (updateError) {
            console.error('[event-emails] Update error:', updateError);
            errors.push({ email_type: email.email_type, error: updateError.message, request_index: i });
            continue;
          }
          savedEmails.push(updated);
        }
      }

      if (errors.length > 0) {
        console.error('[event-emails] Failed to save some emails:', errors);
        return res.status(500).json({
          error: `Failed to save ${errors.length} email configuration(s)`,
          details: errors,
          savedEmails
        });
      }

      const schedulingResult = is_complex_event
        ? await scheduleComplexEventReminderEmails(eventId)
        : await scheduleReminderEmails(eventId);

      // Response body now includes scheduling outcomes alongside the existing
      // `savedEmails` field. Clients that only read `savedEmails` keep working
      // (the previous 200 shape was a bare array; the legacy editor reader
      // tolerates both via `Array.isArray(result) ? result : result.savedEmails`).
      return res.status(200).json({
        savedEmails,
        errors: [],
        requeued: schedulingResult.requeued || 0,
        bookingsScheduled: schedulingResult.bookingsScheduled || 0,
        bookingsConsidered: schedulingResult.bookingsConsidered || 0,
        schedulingFailures: schedulingResult.schedulingFailures || [],
        skipped: schedulingResult.skipped || [],
        schedulerError: schedulingResult.error || null,
      });
    } catch (err) {
      console.error('[event-emails] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
