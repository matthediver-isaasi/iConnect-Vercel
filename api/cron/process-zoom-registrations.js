import { supabase } from '../_lib/database.js';
import { processZoomJob } from '../_lib/zoomRegistrationJobProcessor.js';
import { zoomAuthority } from '../_lib/eventZoomRegistration.js';
import { listZoomRegistrations, registerWithZoom } from '../_lib/zoomRegistration.js';
import { sendConfirmationEmailsFromTemplate } from '../_lib/eventConfirmationEmail.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now();
  let processed = 0;
  try {
    while (Date.now() - started < 20000 && processed < 20) {
      const { data, error } = await supabase.rpc('claim_zoom_registration_job');
      if (error) throw new Error('Could not claim registration work');
      const job = data?.[0];
      if (!job) break;
      const io = {
        async save(job, patch) {
          const { data, error } = await supabase.from('zoom_registration_job').update(patch)
            .eq('id', job.id).eq('tenant_id', job.tenant_id).eq('lease_token', job.lease_token)
            .gt('lease_until', new Date().toISOString())
            .select('id').maybeSingle();
          if (error || !data) throw new Error('Registration checkpoint could not be saved');
        },
        async targetMatches(job) {
          const { data, error } = await supabase.from(job.resource_kind === 'event' ? 'event' : 'complex_event_session')
            .select('zoom_meeting_id,zoom_webinar_id').eq('id', job.resource_id).eq('tenant_id', job.tenant_id).maybeSingle();
          if (error) throw new Error('Could not verify current Zoom target');
          return !!data && (data.zoom_meeting_id || null) === job.target.current.zoom_meeting_id
            && (data.zoom_webinar_id || null) === job.target.current.zoom_webinar_id;
        },
        async booking(job, id) {
          const { data, error } = await supabase.from(job.resource_kind === 'event' ? 'booking' : 'complex_event_booking')
            .select('*').eq('id', id).eq('tenant_id', job.tenant_id).eq('event_id', job.target.eventId).maybeSingle();
          if (error) throw new Error('Could not read booking');
          return data;
        },
        async register(job, booking) {
          const { data, error } = await supabase.from(job.target.kind === 'meetings' ? 'zoom_meeting' : 'zoom_webinar')
            .select('*').eq('id', job.target.localId).eq('tenant_id', job.tenant_id).single();
          if (error || !data || String(data[job.target.kind === 'meetings' ? 'zoom_meeting_id' : 'zoom_webinar_id']) !== job.target.providerId) throw new Error('Zoom target is no longer available');
          const authority = await zoomAuthority(job.tenant_id, data, job.target.kind);
          if (!authority.live.registration_required) throw new Error('Registration is now disabled in Zoom');
          const records = await listZoomRegistrations(authority.token, authority.kind, authority.id);
          // Listing a large Zoom target can outlive a lease. Fence again
          // immediately before a provider write, not just at the checkpoint.
          await io.save(job, { lease_until: new Date(Date.now() + 360000).toISOString() });
          if (!await io.targetMatches(job)) throw new Error('Zoom target changed before registration');
          return registerWithZoom(authority.token, authority.kind, authority.id, {
            email: booking.attendee_email, first_name: booking.attendee_first_name, last_name: booking.attendee_last_name,
          }, records);
        },
        async email(job, booking, url) {
          const results = await sendConfirmationEmailsFromTemplate(job.target.eventId, booking, {
            email: booking.attendee_email, first_name: booking.attendee_first_name, last_name: booking.attendee_last_name,
          }, url, null, job.tenant_id);
          return results?.some(r => r.success) || false;
        },
      };
      await processZoomJob(job, io);
      processed++;
    }
    return res.status(200).json({ processed });
  } catch {
    return res.status(500).json({ error: 'Background Zoom registration could not continue' });
  }
}
