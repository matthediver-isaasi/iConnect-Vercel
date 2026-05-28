import { supabase } from '../_lib/database.js';
import { loadGroupEventForCaller } from '../_lib/memberGroupEventsAccess.js';

const ALLOWED_FIELDS = new Set([
  'title', 'summary', 'description', 'start_date', 'end_date', 'location',
  'image_url', 'image_focal_point', 'event_type', 'program_tag', 'event_state',
  'timezone', 'is_online', 'online_meeting_url', 'attached_documents',
  'documents_section_title',
]);

function isValidUrl(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function pickPayload(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (ALLOWED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const loaded = await loadGroupEventForCaller(req, id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
  const { event, access, groupAccess } = loaded;

  if (req.method === 'GET') {
    const { data: rsvp } = access.identityId
      ? await supabase.from('event_rsvp').select('response, responded_at').eq('event_id', id).eq('identity_id', access.identityId).maybeSingle()
      : { data: null };

    const showMeetingUrl =
      groupAccess.canCreate ||
      (rsvp?.response === 'going');

    const out = { ...event };
    if (!showMeetingUrl) {
      delete out.online_meeting_url;
    }
    return res.json({
      event: out,
      group: { id: groupAccess.groupId, name: groupAccess.groupName },
      canEdit: groupAccess.canCreate,
      myRsvp: rsvp || null,
    });
  }

  if (req.method === 'PATCH') {
    if (!groupAccess.canCreate) {
      return res.status(403).json({ error: 'Your role cannot edit events for this group' });
    }
    const payload = pickPayload(req.body);
    if (payload.is_online === true && !isValidUrl(payload.online_meeting_url || '')) {
      return res.status(400).json({ error: 'online_meeting_url must be a valid http(s) URL when is_online is true' });
    }
    if (payload.is_online === false) {
      payload.online_meeting_url = null;
    }
    const { data: updated, error: updErr } = await supabase
      .from('event')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (updErr) return res.status(500).json({ error: 'Failed to update event' });
    return res.json({ event: updated });
  }

  if (req.method === 'DELETE') {
    if (!groupAccess.canCreate) {
      return res.status(403).json({ error: 'Your role cannot delete events for this group' });
    }
    const { error: delErr } = await supabase.from('event').delete().eq('id', id);
    if (delErr) return res.status(500).json({ error: 'Failed to delete event' });
    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
