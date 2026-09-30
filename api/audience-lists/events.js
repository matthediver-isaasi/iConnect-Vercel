import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }

  const { tenantId } = tenantContext;

  try {
    const [eventRes, complexRes] = await Promise.all([
      supabase
        .from('event')
        .select('id, title, start_date, status')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false }),
      supabase
        .from('complex_event')
        .select('id, title, start_date, status')
        .eq('tenant_id', tenantId)
        .order('start_date', { ascending: false }),
    ]);

    if (eventRes.error) {
      console.error('[AudienceListEvents] event query error:', eventRes.error);
      return res.status(500).json({ error: eventRes.error.message });
    }
    if (complexRes.error) {
      console.error('[AudienceListEvents] complex_event query error:', complexRes.error);
    }

    const events = [
      ...(eventRes.data || []).map(e => ({
        id: e.id,
        title: e.title,
        start_date: e.start_date,
        status: e.status,
        source: 'event',
      })),
      ...((complexRes.data) || []).map(e => ({
        id: e.id,
        title: e.title,
        start_date: e.start_date,
        status: e.status,
        source: 'complex_event',
      })),
    ].sort((a, b) => {
      const aDate = a.start_date ? new Date(a.start_date).getTime() : 0;
      const bDate = b.start_date ? new Date(b.start_date).getTime() : 0;
      return bDate - aDate;
    });

    return res.json(events);
  } catch (err) {
    console.error('[AudienceListEvents] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}
