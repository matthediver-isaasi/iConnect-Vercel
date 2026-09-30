import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.isAuthenticated || !tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - authentication and tenant context required' });
  }

  const { tenantId } = tenantContext;
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json([]);
  }

  const uniqueIds = [...new Set(ids)].slice(0, 200);

  try {
    const { data: members, error } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, job_title, biography, profile_photo_url, organization (id, name)')
      .eq('tenant_id', tenantId)
      .in('id', uniqueIds);

    if (error) {
      console.error('[Member By IDs] Error:', error);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

    const linkedSpeakersByMemberId = {};
    const { data: linkedSpeakers, error: linkedError } = await supabase
      .from('speaker')
      .select('id, full_name, member_id')
      .eq('tenant_id', tenantId)
      .in('member_id', uniqueIds);
    if (linkedError) {
      console.error('[Member By IDs] Speaker link lookup error:', linkedError);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }
    (linkedSpeakers || []).forEach((speaker) => {
      linkedSpeakersByMemberId[speaker.member_id] = speaker;
    });

    const normalized = (members || []).map((m) => ({
      id: m.id,
      first_name: m.first_name,
      last_name: m.last_name,
      email: m.email,
      job_title: m.job_title || null,
      biography: m.biography || null,
      profile_photo_url: m.profile_photo_url || null,
      organization_id: m.organization?.id || null,
      organization_name: m.organization?.name || null,
      organisation_name: m.organization?.name || null,
      linked_speaker_id: linkedSpeakersByMemberId[m.id]?.id || null,
      linked_speaker_name: linkedSpeakersByMemberId[m.id]?.full_name || null,
    }));

    return res.json(normalized);
  } catch (err) {
    console.error('[Member By IDs] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }
}
