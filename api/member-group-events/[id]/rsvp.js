import { supabase } from '../../_lib/database.js';
import { loadGroupEventForCaller } from '../../_lib/memberGroupEventsAccess.js';
import { sendEmail } from '../../_lib/emailService.js';

const VALID_RESPONSES = new Set(['going', 'not_going', 'maybe']);

async function sendRsvpConfirmation({ tenantId, identityId, event, groupName }) {
  try {
    const { data: identity } = await supabase
      .from('tenant_identity')
      .select('email, first_name')
      .eq('id', identityId)
      .maybeSingle();
    if (!identity?.email) return;

    const when = event.start_date ? new Date(event.start_date).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) : '';
    const locationLine = event.is_online
      ? (event.online_meeting_url ? `Online: <a href="${event.online_meeting_url}">${event.online_meeting_url}</a>` : 'Online event')
      : (event.location ? `Location: ${event.location}` : '');

    const html = `
      <p>Hi ${identity.first_name || ''},</p>
      <p>Your RSVP to <strong>${event.title}</strong> (${groupName || 'group event'}) is confirmed.</p>
      ${when ? `<p>When: ${when}</p>` : ''}
      ${locationLine ? `<p>${locationLine}</p>` : ''}
      <p>You can update your response any time on the event page.</p>
    `;

    await sendEmail({
      to: identity.email,
      subject: `RSVP confirmed: ${event.title}`,
      html,
      tenantId,
    });
  } catch (e) {
    console.error('[group-event rsvp] confirmation email failed:', e.message || e);
  }
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const loaded = await loadGroupEventForCaller(req, id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
  const { event, access, groupAccess } = loaded;

  if (!access.identityId) {
    return res.status(403).json({ error: 'Caller has no identity record' });
  }

  if (req.method === 'POST') {
    const { response } = req.body || {};
    if (!VALID_RESPONSES.has(response)) {
      return res.status(400).json({ error: 'response must be going|not_going|maybe' });
    }

    if (event.start_date && new Date(event.start_date) < new Date()) {
      return res.status(400).json({ error: 'Event has already started' });
    }

    const { error: upErr } = await supabase
      .from('event_rsvp')
      .upsert({
        event_id: id,
        identity_id: access.identityId,
        tenant_id: access.tenantContext.tenantId,
        response,
        responded_at: new Date().toISOString(),
      }, { onConflict: 'event_id,identity_id' });
    if (upErr) {
      console.error('[group-event rsvp] upsert failed:', upErr.message);
      return res.status(500).json({ error: 'Failed to save RSVP' });
    }

    if (response === 'going') {
      sendRsvpConfirmation({
        tenantId: access.tenantContext.tenantId,
        identityId: access.identityId,
        event,
        groupName: groupAccess.groupName,
      });
    }

    return res.json({ success: true, response });
  }

  if (req.method === 'DELETE') {
    const { error: delErr } = await supabase
      .from('event_rsvp')
      .delete()
      .eq('event_id', id)
      .eq('identity_id', access.identityId);
    if (delErr) return res.status(500).json({ error: 'Failed to clear RSVP' });
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
