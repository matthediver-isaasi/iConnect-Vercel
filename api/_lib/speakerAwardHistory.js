import { supabase } from './database.js';
import { privateSpeakerResponse, speakerAwardStaff, speakerAwardMember, speakerAwardUuid } from './speakerAwardAccess.js';

export function speakerHistoryPagination(query = {}) {
  const parse = (value, fallback, maximum) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new Error('Invalid pagination');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maximum) throw new Error('Invalid pagination');
    return number;
  };
  return { page: parse(query.page, 1, 100000), pageSize: parse(query.page_size, 20, 100) };
}

export async function loadSpeakerAwardHistory(db, { tenantId, speakerId, memberId, page, pageSize }) {
  let query = db.from('speaker_award_history').select(
    'id,event_type,event_id,event_title,awarded_at,status,badge_name,badge_image_url,badge_status,badge_evidence,certificate_status,certificate_available',
    { count: 'exact' },
  ).eq('tenant_id', tenantId);
  // Identity is taken solely from the authenticated member or authorized speaker.
  query = memberId ? query.eq('member_id', memberId) : query.eq('speaker_id', speakerId);
  const { data, error, count } = await query.order('awarded_at', { ascending: false })
    .order('id', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  return {
    awards: (data || []).map(row => ({
      id: row.id, event_type: row.event_type, event_id: row.event_id,
      event_title: row.event_title || 'Event no longer available',
      awarded_at: row.awarded_at, status: row.status,
      badge: row.badge_status ? {
        name: row.badge_name || 'Badge no longer available',
        image_url: row.badge_image_url || null, status: row.badge_status, evidence: row.badge_evidence,
      } : null,
      certificate: {
        status: row.status === 'revoked' ? 'revoked' : row.certificate_status,
        available: row.status !== 'revoked' && row.certificate_available === true,
        // Processing errors can contain private template details; never expose them.
        error: row.certificate_status === 'error' ? 'Certificate generation failed; a retry is pending.' : null,
      },
    })),
    pagination: { page, page_size: pageSize, total: count || 0, total_pages: Math.ceil((count || 0) / pageSize) },
  };
}

export function createSpeakerAwardHistoryHandler({ member = false, ...dependencies } = {}) {
  const db = dependencies.db || supabase;
  return async (req, res) => {
    privateSpeakerResponse(res);
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const actor = await (member ? speakerAwardMember : speakerAwardStaff)(req, dependencies);
      if (!actor) return res.status(403).json({ error: 'Forbidden' });
      let pagination;
      try { pagination = speakerHistoryPagination(req.query); }
      catch { return res.status(400).json({ error: 'Invalid pagination' }); }
      const speakerId = member ? null : req.query.speaker_id;
      if (!member) {
        if (!speakerAwardUuid(speakerId)) return res.status(400).json({ error: 'Valid speaker_id required' });
        const result = await db.from('speaker').select('id').eq('tenant_id', actor.tenantId).eq('id', speakerId).maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) return res.status(404).json({ error: 'Speaker not found' });
      }
      return res.status(200).json(await loadSpeakerAwardHistory(db, { ...actor, speakerId, ...pagination }));
    } catch {
      return res.status(500).json({ error: 'Failed to load speaker award history' });
    }
  };
}