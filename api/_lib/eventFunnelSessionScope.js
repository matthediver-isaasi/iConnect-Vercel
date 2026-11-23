const fail=()=>{throw new Error('Registered session scope could not be verified completely');};
async function complete(query,key=row=>row.id) {
  const rows=[],seen=new Set();
  for(let offset=0;offset<10000;offset+=500) {
    const {data,error}=await query.range(offset,offset+499);
    if(error||!Array.isArray(data))fail();
    for(const row of data) {
      const id=key(row);if(!id||seen.has(id))fail();seen.add(id);rows.push(row);
    }
    if(data.length<500)return rows;
  }
  fail();
}
/**
 * Funnel-only common authority for session QR and reminder targets.
 * Direct legacy links and junction links form one set. Restricted tickets with
 * no tracks grant nothing; common untracked sessions accompany a selected track.
 */
export async function loadFunnelSessionScope({db,tenantId,eventId,ticketClassId}) {
  if(!db||!tenantId||!eventId||!ticketClassId)fail();
  const ticket=await db.from('complex_event_ticket_class').select('id,all_tracks,linked_track_ids')
    .eq('id',ticketClassId).eq('tenant_id',tenantId).eq('complex_event_id',eventId).maybeSingle();
  if(ticket.error||!ticket.data)fail();
  const all=ticket.data.all_tracks===true;
  if(ticket.data.linked_track_ids!=null&&!Array.isArray(ticket.data.linked_track_ids))fail();
  const selected=new Set(ticket.data.linked_track_ids||[]);
  if(!all&&!selected.size)return [];
  const sessions=await complete(db.from('complex_event_session')
    .select('id,title,start_time,end_time,location,is_online,complex_event_track_id,complex_event_id,tenant_id')
    .eq('tenant_id',tenantId).eq('complex_event_id',eventId).order('id'));
  const links=new Map(sessions.map(s=>[s.id,new Set(s.complex_event_track_id?[s.complex_event_track_id]:[])]));
  for(let offset=0;offset<sessions.length;offset+=100) {
    const ids=sessions.slice(offset,offset+100).map(s=>s.id);
    const junctions=await complete(db.from('complex_event_session_track')
      .select('complex_event_session_id,complex_event_track_id')
      .in('complex_event_session_id',ids).order('complex_event_session_id').order('complex_event_track_id'),
    row=>row.complex_event_session_id&&row.complex_event_track_id?`${row.complex_event_session_id}:${row.complex_event_track_id}`:null);
    for(const j of junctions) {
      if(!ids.includes(j.complex_event_session_id))fail();
      links.get(j.complex_event_session_id).add(j.complex_event_track_id);
    }
  }
  const ids=[...new Set([...selected,...[...links.values()].flatMap(value=>[...value])])],names=new Map();
  for(let offset=0;offset<ids.length;offset+=100) {
    const batch=ids.slice(offset,offset+100);
    const result=await db.from('complex_event_track').select('id,name')
      .eq('tenant_id',tenantId).eq('complex_event_id',eventId).in('id',batch);
    if(result.error||!Array.isArray(result.data)||result.data.length!==batch.length)fail();
    for(const row of result.data)names.set(row.id,row.name);
  }
  return sessions.filter(s=>all||!links.get(s.id).size||[...links.get(s.id)].some(id=>selected.has(id)))
    .map(s=>({...s,track_name:[...links.get(s.id)].map(id=>names.get(id)).filter(Boolean).join(' / ')||null}));
}
