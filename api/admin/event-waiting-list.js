import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { getCallerGroupEventsAccess, getCallerGroupMembershipIds } from '../_lib/memberGroupEventsAccess.js';
import { filterCountableEvents } from '../_lib/eventAttendeeCountAccess.js';
import { listWaitingEntries, validWaitingId } from '../_lib/eventWaitingList.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  try {
    const context = await getTenantContext(req);
    if (!context.isAuthenticated || !context.tenantId) return res.status(401).json({error:'Authentication required'});
    if (!validWaitingId(req.query.event_id) || !['simple','complex'].includes(req.query.event_kind)) return res.status(400).json({error:'A valid event is required'});
    const [isTenantAdmin, hasGlobalAttendeeAccess, memberships, groups, eventResult] = await Promise.all([
      hasAdminAccess(context),
      hasFeatureAccess(context.roleId, 'events.browse-events.view-attendees', context.memberExcludedFeatures),
      getCallerGroupMembershipIds(req),
      getCallerGroupEventsAccess(req),
      supabase.from(req.query.event_kind === 'simple' ? 'event' : 'complex_event')
        .select('id,tenant_id,member_group_id,group_event_public').eq('tenant_id', context.tenantId).eq('id', req.query.event_id).maybeSingle(),
    ]);
    if (eventResult.error) throw eventResult.error;
    const allowed = filterCountableEvents({
      rows: eventResult.data ? [eventResult.data] : [], tenantId: context.tenantId,
      isTenantAdmin, hasGlobalAttendeeAccess, memberGroupIds: memberships.groupIds,
      administeredGroupIds: (groups.groups || []).map(group => group.groupId),
    });
    if (!allowed.length) return res.status(403).json({error:'Event attendee access required'});
    return res.json({entries:await listWaitingEntries(supabase,context.tenantId,{eventId:req.query.event_id,eventKind:req.query.event_kind})});
  } catch(error) {
    console.error('[Admin waiting list]',error.code || error.message);
    return res.status(503).json({error:'Unable to load waiting list. Please retry.'});
  }
}
