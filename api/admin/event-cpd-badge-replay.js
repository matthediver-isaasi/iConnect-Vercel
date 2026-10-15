import crypto from 'crypto';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';

const TYPES = { simple: 'event', complex: 'complex_event' };

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const context = await getTenantContext(req);
  if (!context?.tenantId || !context.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Event administrator permission is required' });
  }
  const input = req.method === 'GET' ? req.query : req.body;
  if(context.tenantMismatch) return res.status(409).json({error:'Tenant context changed. Reload this page.'});
  if(input?.booking_id && context.roleId && !(await hasFeatureAccess(context.roleId,'events.event-report',context.memberExcludedFeatures))){
    return res.status(403).json({error:'Event Registration Report administrator permission is required'});
  }
  const eventType = TYPES[String(input?.event_type || '')];
  const eventId = String(input?.event_id || '');
  if (!eventType || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return res.status(400).json({ error: 'A valid saved event and event type are required' });
  }
  if (req.method === 'GET') {
    if (input.replay_id && input.booking_id) {
      if (![input.replay_id,input.booking_id].every(v=>/^[0-9a-f-]{36}$/i.test(v))) return res.status(400).json({error:'Invalid replay identity'});
      const {data: run,error:runError}=await supabase.from('event_cpd_badge_replay').select('id,enqueued_count')
        .eq('tenant_id',context.tenantId).eq('id',input.replay_id).eq('event_id',eventId).eq('event_type',eventType).maybeSingle();
      if(runError) return res.status(503).json({error:'Badge progress unavailable'});
      if(!run) return res.status(404).json({error:'Badge replay not found'});
      const {data:jobs,error}=await supabase.from('event_cpd_badge_outbox').select('status')
        .eq('tenant_id',context.tenantId).eq('booking_id',input.booking_id)
        .like('idempotency_key',`badge-replay:${run.id}:%`);
      if(error) return res.status(503).json({error:'Badge progress unavailable'});
      return res.status(200).json({complete:jobs.length===run.enqueued_count&&jobs.every(j=>j.status==='complete'),
        failed:jobs.some(j=>j.status==='dead'),queued:run.enqueued_count});
    }
    const { data, error } = await supabase.rpc('get_latest_event_cpd_badge_replay_status', {
      p_tenant_id: context.tenantId,
      p_event_type: eventType,
      p_event_id: eventId,
    });
    if (error) return res.status(500).json({ error: 'Failed to load CPD badge sync status' });
    return res.status(200).json({ sync: data || null });
  }
  const scoped = input.booking_id != null;
  if(scoped && (input.confirmed!==true || ![input.booking_id,input.request_id].every(v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)))) {
    return res.status(400).json({error:'Confirmed booking and request IDs are required'});
  }
  if(scoped){
    const {data:booking,error}=await supabase.from(eventType==='event'?'booking':'complex_event_booking')
      .select('id').eq('tenant_id',context.tenantId).eq('event_id',eventId).eq('id',input.booking_id).maybeSingle();
    if(error) return res.status(503).json({error:'Booking unavailable'});
    if(!booking) return res.status(404).json({error:'Booking not found'});
    // A scoped key is derived from the complete scope, not just the client UUID.
  }
  const replayId = scoped ? (() => {
    const h=crypto.createHash('sha256').update(`${context.tenantId}:${eventType}:${eventId}:${input.booking_id}:${input.request_id}`).digest('hex');
    return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
  })() : crypto.randomUUID();
  const actor = context.tenantUserId
    ? `tenant_user:${context.tenantUserId}` : `member:${context.memberId}`;
  const { data, error } = await supabase.rpc(scoped?'enqueue_event_cpd_badge_registration_replay':'enqueue_event_cpd_badge_replay', {
    p_tenant_id: context.tenantId,
    p_event_type: eventType,
    p_event_id: eventId,
    p_replay_id: replayId,
    p_actor: actor,
    ...(scoped?{p_booking_id:input.booking_id}:{}),
  });
  if (error) {
    const validation = /event does not belong|complete replay scope/i.test(error.message || '');
    return res.status(validation ? 400 : 500).json({
      error: validation ? error.message : 'Failed to queue CPD badge sync',
    });
  }
  return res.status(202).json({ replay_id: replayId, enqueued_count: data || 0 });
}