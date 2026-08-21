// Task #3285: tell the event editor which selected speakers are matched to a
// member (and organisation) so admins can see upfront who is voucher-eligible.
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { matchSpeakersToMembers } from '../_lib/speakerAwards.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const isAdmin = await hasAdminAccess(ctx);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const speakerIds = Array.isArray(req.body?.speaker_ids)
    ? [...new Set(req.body.speaker_ids.filter(id => typeof id === 'string'))]
    : [];
  if (speakerIds.length === 0) {
    return res.status(200).json({ eligibility: {} });
  }
  if (speakerIds.length > 200) {
    return res.status(400).json({ error: 'Too many speakers' });
  }

  try {
    const { data: speakers, error } = await supabase
      .from('speaker')
      .select('id, full_name, email, member_id')
      .in('id', speakerIds)
      .eq('tenant_id', ctx.tenantId);
    if (error) throw new Error(error.message);

    const matches = await matchSpeakersToMembers(supabase, ctx.tenantId, speakers || []);
    const eligibility = {};
    (speakers || []).forEach(s => {
      const m = matches[s.id] || null;
      eligibility[s.id] = {
        member_id: m?.member_id || null,
        organization_id: m?.organization_id || null,
        organization_name: m?.organization_name || null,
        voucher_eligible: Boolean(m?.organization_id),
        badge_eligible: Boolean(m?.member_id),
      };
    });
    return res.status(200).json({ eligibility });
  } catch (err) {
    console.error('[admin/speaker-award-eligibility]', err.message);
    return res.status(500).json({ error: 'Failed to check eligibility' });
  }
}
