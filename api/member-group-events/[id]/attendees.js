import { supabase } from '../../_lib/database.js';
import { loadGroupEventForCaller } from '../../_lib/memberGroupEventsAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  const loaded = await loadGroupEventForCaller(req, id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
  const { groupAccess } = loaded;

  if (!groupAccess.canCreate) {
    return res.status(403).json({ error: 'Only event creators can see the attendee list' });
  }

  const { data: rsvps, error } = await supabase
    .from('event_rsvp')
    .select('identity_id, response, responded_at')
    .eq('event_id', id);
  if (error) return res.status(500).json({ error: 'Failed to load attendees' });

  const identityIds = [...new Set((rsvps || []).map((r) => r.identity_id))];
  let identities = [];
  if (identityIds.length > 0) {
    const { data } = await supabase
      .from('tenant_identity')
      .select('id, email, first_name, last_name')
      .in('id', identityIds);
    identities = data || [];
  }
  const byId = new Map(identities.map((i) => [i.id, i]));

  const grouped = { going: [], not_going: [], maybe: [] };
  for (const r of rsvps || []) {
    const ident = byId.get(r.identity_id) || {};
    grouped[r.response]?.push({
      identity_id: r.identity_id,
      email: ident.email || null,
      name: [ident.first_name, ident.last_name].filter(Boolean).join(' ') || null,
      responded_at: r.responded_at,
    });
  }

  return res.json({ success: true, attendees: grouped });
}
