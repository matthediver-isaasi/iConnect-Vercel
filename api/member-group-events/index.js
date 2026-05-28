import { supabase } from '../_lib/database.js';
import {
  getCallerGroupEventsAccess,
  requireGroupEventsAccess,
} from '../_lib/memberGroupEventsAccess.js';

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

function validate(payload, { creating }) {
  if (creating && (!payload.title || !String(payload.title).trim())) {
    return 'title is required';
  }
  if (creating && !payload.start_date) {
    return 'start_date is required';
  }
  if (payload.is_online === true) {
    if (!isValidUrl(payload.online_meeting_url || '')) {
      return 'online_meeting_url must be a valid http(s) URL when is_online is true';
    }
  }
  return null;
}

/**
 * POST /api/member-group-events
 * Body: { memberGroupId, ...eventFields }
 * Creates a new group event. Caller must have canCreate on the group.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { memberGroupId } = req.body || {};
  if (!memberGroupId) return res.status(400).json({ error: 'memberGroupId is required' });

  const groupAccess = requireGroupEventsAccess(access.groups, memberGroupId);
  if (!groupAccess) {
    return res.status(403).json({ error: 'You do not qualify to create events for this group' });
  }
  if (!groupAccess.canCreate) {
    return res.status(403).json({ error: 'Your role cannot create events for this group' });
  }

  const payload = pickPayload(req.body);
  const err = validate(payload, { creating: true });
  if (err) return res.status(400).json({ error: err });

  const insertRow = {
    ...payload,
    tenant_id: access.tenantContext.tenantId,
    member_group_id: memberGroupId,
    status: 'published',
    event_state: payload.event_state || 'active',
    is_complex: false,
    created_by: access.identityId || null,
  };

  const { data: event, error: insErr } = await supabase
    .from('event')
    .insert(insertRow)
    .select()
    .single();
  if (insErr || !event) {
    console.error('[member-group-events] create failed:', insErr?.message);
    return res.status(500).json({ error: 'Failed to create event' });
  }

  return res.status(201).json({ event });
}
