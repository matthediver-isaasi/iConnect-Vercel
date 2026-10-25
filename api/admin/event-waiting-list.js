import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { listWaitingEntries, validWaitingId } from '../_lib/eventWaitingList.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','private, no-store');
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  try {
    const context = await getTenantContext(req);
    if (!context.tenantId || !await hasAdminAccess(context)) return res.status(403).json({error:'Administrator access required'});
    if (!validWaitingId(req.query.event_id) || !['simple','complex'].includes(req.query.event_kind)) return res.status(400).json({error:'A valid event is required'});
    return res.json({entries:await listWaitingEntries(supabase,context.tenantId,{eventId:req.query.event_id,eventKind:req.query.event_kind})});
  } catch(error) {
    console.error('[Admin waiting list]',error.code || error.message);
    return res.status(503).json({error:'Unable to load waiting list. Please retry.'});
  }
}
