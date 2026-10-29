import { supabase } from '../_lib/database.js';
import { assertEventCodeOfConduct } from '../_lib/eventCodeOfConduct.js';
import { getSessionMember } from '../_lib/session.js';
import { waitingListAccess, normalizeWaitingRequest, buildWaitingEntries, listWaitingEntries, validWaitingId } from '../_lib/eventWaitingList.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control','private, no-store');
  if (!['GET','POST','PATCH'].includes(req.method)) return res.status(405).json({ error:'Method not allowed' });
  try {
    const member = await getSessionMember(req);
    if (!member) return res.status(401).json({ error:'Please sign in to manage your waiting lists' });
    const excluded = await waitingListAccess(supabase, member);
    if (!excluded) return res.status(403).json({ error:'My Tickets access is required' });
    if (req.method === 'GET') return res.json({ entries: await listWaitingEntries(supabase, member.tenant_id, { memberId:member.id }) });
    if (req.method === 'PATCH') {
      if (!validWaitingId(req.body?.entry_id) || !['attendee','registration'].includes(req.body?.scope)) return res.status(400).json({ error:'Choose an entry and withdrawal scope' });
      const { data, error } = await supabase.rpc('withdraw_event_waiting_entry', {
        p_tenant_id:member.tenant_id,p_member_id:member.id,p_entry_id:req.body.entry_id,p_scope:req.body.scope,
      });
      if (error) {
        if (error.code === 'P0001') return res.status(403).json({ error:'Entry not found or you cannot remove it' });
        throw error;
      }
      return res.json({ withdrawn:data });
    }
    await assertEventCodeOfConduct(supabase, member.tenant_id, req.body);
    const request = normalizeWaitingRequest(req.body);
    const { data: previous, error: previousError } = await supabase.from('event_waiting_registration')
      .select('id,request_hash').eq('tenant_id',member.tenant_id).eq('booker_member_id',member.id)
      .eq('idempotency_key',request.idempotency_key).maybeSingle();
    if (previousError) throw previousError;
    if (previous) {
      if (previous.request_hash !== request.request_hash) return res.status(409).json({ error:'This attempt was already submitted with different details' });
      return res.json({ registration_id:previous.id, entries:await listWaitingEntries(supabase,member.tenant_id,{memberId:member.id,registrationId:previous.id}) });
    }
    const entries = await buildWaitingEntries(supabase,req,member,request,excluded);
    const { data:id, error } = await supabase.rpc('create_event_waiting_registration', {
      p_tenant_id:member.tenant_id,p_member_id:member.id,p_event_id:request.event_id,p_event_kind:request.event_kind,
      p_idempotency_key:request.idempotency_key,p_request_hash:request.request_hash,p_entries:entries,
    });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error:'An attendee is already on this waiting list for the selected ticket' });
      if (error.code === 'P0001') return res.status(409).json({ error:'Waiting list registration changed. Refresh and try again.' });
      throw error;
    }
    return res.status(201).json({registration_id:id,entries:await listWaitingEntries(supabase,member.tenant_id,{memberId:member.id,registrationId:id})});
  } catch (error) {
    console.error('[Waiting list]',error.code || error.message);
    return res.status(error.statusCode || 503).json({ error:error.statusCode ? error.message : 'Waiting lists are temporarily unavailable. Please retry the same registration.' });
  }
}
