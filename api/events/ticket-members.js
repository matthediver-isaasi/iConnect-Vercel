import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getCallerGroupEventsAccess } from '../_lib/memberGroupEventsAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const context = await getTenantContext(req);
    if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context changed. Refresh and try again.' });
    if (!context?.isAuthenticated || !context.tenantId) return res.status(401).json({ error: 'Authentication required' });
    const { event_id: eventId, event_type: type = 'simple', group_id: groupId } = req.query;
    if (!['simple', 'complex'].includes(type) || (eventId && !UUID.test(eventId)) || (groupId && !UUID.test(groupId))) return res.status(400).json({ error: 'Invalid event context' });
    let parentGroup = groupId;
    if (eventId) {
      const { data, error } = await supabase.from(type === 'complex' ? 'complex_event' : 'event').select('id, member_group_id').eq('tenant_id', context.tenantId).eq('id', eventId).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Event not found' });
      parentGroup = data.member_group_id;
    }
    if (!await hasAdminAccess(context)) {
      const access = await getCallerGroupEventsAccess(req);
      if (access.error || !access.groups?.some(group => group.groupId === parentGroup && (type === 'complex' ? group.complexEnabled : group.simpleEnabled))) return res.status(403).json({ error: 'Event management permission required' });
    }
    const ids = [...new Set(String(req.query.ids || '').split(',').filter(Boolean))];
    const query = String(req.query.q || '').trim();
    if (ids.length > 100 || ids.some(id => !UUID.test(id)) || query.length > 100) return res.status(400).json({ error: 'Search is limited to 100 characters and 100 selected members' });
    const base = () => supabase.from('member').select('id, first_name, last_name, email').eq('tenant_id', context.tenantId);
    let selected = [], results = [];
    if (ids.length) {
      const result = await base().in('id', ids).limit(100);
      if (result.error) throw result.error;
      selected = result.data || [];
    }
    if (query.length >= 2) {
      // Strip PostgREST filter syntax and wildcard characters.
      const term = query.replace(/[^\p{L}\p{N}@ .'-]/gu, '').trim();
      if (term.length >= 2) {
        const result = await base().or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`).order('last_name').limit(25);
        if (result.error) throw result.error;
        results = result.data || [];
      }
    }
    return res.status(200).json({ results, selected });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to load ticket members' });
  }
}
