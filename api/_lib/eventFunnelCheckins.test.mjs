import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureBookingToken,ensureComplexSessionTokens,getComplexRegisteredSessions} from './checkinService.js';
function fixture({sessions=2}={}) {
  const tables={
    booking:[{id:'simple-booking',tenant_id:'tenant',event_id:'simple',status:'confirmed',check_in_token:null}],
    event:[{id:'simple',tenant_id:'tenant',is_online:false}],
    complex_event_booking:[{id:'complex-booking',tenant_id:'tenant',event_id:'complex',ticket_class_id:'ticket',status:'confirmed'}],
    complex_event_ticket_class:[{id:'ticket',tenant_id:'tenant',complex_event_id:'complex',all_tracks:true,linked_track_ids:[]}],
    complex_event_session:Array.from({length:sessions},(_,i)=>({id:`session-${String(i).padStart(4,'0')}`,
      tenant_id:'tenant',complex_event_id:'complex',is_online:false,title:`Session ${i}`})),
    complex_event_track:[],complex_event_session_track:[],complex_event_session_checkin:[],
  };
  const calls=[],failures=new Map();
  const db={from(table){
    const filters=[],call={table,filters,operation:'read'};calls.push(call);
    let payload,range;
    const q={select:()=>q,order:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},
      is:(k,v)=>{filters.push([k,v]);return q;},in:(k,v)=>{filters.push([k,v]);return q;},
      range:(from,to)=>{range=[from,to];return q;},
      update:value=>{payload=value;call.operation='update';return q;},
      insert:value=>{payload=value;call.operation='insert';return q;},
      maybeSingle:async()=>execute(true),then:(resolve,reject)=>Promise.resolve(execute()).then(resolve,reject)};
    function execute(single=false) {
      if(failures.has(`${table}:${call.operation}`)) {
        const failure=failures.get(`${table}:${call.operation}`);
        return typeof failure==='function'?failure(payload):{error:{code:failure}};
      }
      let rows=tables[table].filter(row=>filters.every(([k,v])=>Array.isArray(v)?v.includes(row[k]):(row[k]??null)===v));
      if(call.operation==='update') rows.forEach(row=>Object.assign(row,payload));
      if(call.operation==='insert') {
        const row={id:`token-${tables[table].length}`,...payload};tables[table].push(row);rows=[row];
      }
      if(range)rows=rows.slice(range[0],range[1]+1);else if(!single)rows=rows.slice(0,500);
      return {data:structuredClone(single?rows[0]||null:rows)};
    }
    return q;
  }};
  return {db,tables,calls,failures,options:{db,strict:true}};
}
test('simple check-in tokens are tenant-scoped, persisted once and reused on retry',async()=>{
  const f=fixture(),token=await ensureBookingToken('simple-booking','tenant',f.options);
  assert.match(token,/^[0-9a-f]{48}$/);
  assert.equal(await ensureBookingToken('simple-booking','tenant',f.options),token);
  assert.equal(f.calls.filter(c=>c.operation==='update').length,1);
  assert.ok(f.calls.every(c=>c.filters.some(([key,value])=>key==='tenant_id'&&value==='tenant')));
  await assert.rejects(ensureBookingToken('simple-booking','other',f.options),/unavailable/);
});
test('failed token writes or reads cannot masquerade as no QR needed',async()=>{
  const f=fixture();f.failures.set('booking:update','NETWORK');
  await assert.rejects(ensureBookingToken('simple-booking','tenant',f.options),/verified/);
  f.failures.clear();f.failures.set('event:read','NETWORK');
  await assert.rejects(ensureBookingToken('simple-booking','tenant',f.options),/unavailable/);
  assert.equal(await ensureBookingToken('simple-booking','tenant',{db:f.db}),null);
});
test('complex tokens preserve successful partial work and recover without replacement',async()=>{
  const f=fixture(),booking=f.tables.complex_event_booking[0];
  const first=await ensureComplexSessionTokens(booking,'tenant',f.options);
  assert.equal(first.length,2);
  f.tables.complex_event_session.push({id:'new-session',tenant_id:'tenant',complex_event_id:'complex',is_online:false});
  f.failures.set('complex_event_session_checkin:insert','NETWORK');
  await assert.rejects(ensureComplexSessionTokens(booking,'tenant',f.options),/saved/);
  f.failures.clear();
  const retried=await ensureComplexSessionTokens(booking,'tenant',f.options);
  assert.equal(retried.length,3);assert.equal(retried[0].token,first[0].token);
  assert.equal(f.tables.complex_event_session_checkin.length,3);
});
test('strict session discovery reads beyond the API cap and rejects unavailable ticket scope',async()=>{
  const f=fixture({sessions:501});
  assert.equal((await getComplexRegisteredSessions('complex','ticket','tenant',f.options)).length,501);
  f.failures.set('complex_event_ticket_class:read','NETWORK');
  await assert.rejects(getComplexRegisteredSessions('complex','ticket','tenant',f.options),/scope could not be verified/);
  f.failures.clear();f.failures.set('complex_event_session:read','NETWORK');
  await assert.rejects(getComplexRegisteredSessions('complex','ticket','tenant',f.options),/completely/);
});
test('valid empty and online-only scopes remain empty without creating tokens',async()=>{
  const f=fixture();f.tables.complex_event_session.forEach(s=>s.is_online=true);
  assert.deepEqual(await ensureComplexSessionTokens(f.tables.complex_event_booking[0],'tenant',f.options),[]);
  assert.equal(f.tables.complex_event_session_checkin.length,0);
  f.tables.complex_event_ticket_class[0].all_tracks=false;
  assert.deepEqual(await getComplexRegisteredSessions('complex','ticket','tenant',f.options),[]);
});
test('simple update races return the persisted winner, never an unpersisted generated token',async()=>{
  const f=fixture(),winner='c'.repeat(48);
  f.failures.set('booking:update',()=>{
    f.tables.booking[0].check_in_token=winner;
    return {data:null};
  });
  assert.equal(await ensureBookingToken('simple-booking','tenant',f.options),winner);
});
test('complex unique-conflict races adopt the persisted winner',async()=>{
  const f=fixture({sessions:1}),winner='d'.repeat(48);
  f.failures.set('complex_event_session_checkin:insert',payload=>{
    f.tables.complex_event_session_checkin.push({...payload,id:'winner',token:winner});
    return {error:{code:'23505'}};
  });
  const tokens=await ensureComplexSessionTokens(f.tables.complex_event_booking[0],'tenant',f.options);
  assert.equal(tokens[0].token,winner);assert.equal(f.tables.complex_event_session_checkin.length,1);
});
test('funnel session scope includes direct, junction and common sessions without granting unrelated tracks',async()=>{
  const f=fixture({sessions:4});
  f.tables.complex_event_ticket_class[0]={...f.tables.complex_event_ticket_class[0],all_tracks:false,linked_track_ids:['a']};
  f.tables.complex_event_track.push(...['a','b'].map(id=>({id,tenant_id:'tenant',complex_event_id:'complex',name:id})));
  f.tables.complex_event_session[0].complex_event_track_id='a';
  f.tables.complex_event_session[1].complex_event_track_id='b';
  f.tables.complex_event_session_track.push({complex_event_session_id:'session-0002',complex_event_track_id:'a'});
  const result=await getComplexRegisteredSessions('complex','ticket','tenant',f.options);
  assert.deepEqual(result.map(s=>s.id),['session-0000','session-0002','session-0003']);
  assert.equal(result[1].track_name,'a');
  f.failures.set('complex_event_session_track:read','NETWORK');
  await assert.rejects(getComplexRegisteredSessions('complex','ticket','tenant',f.options),/completely/);
  f.failures.clear();f.tables.complex_event_track[0].tenant_id='other';
  await assert.rejects(getComplexRegisteredSessions('complex','ticket','tenant',f.options),/completely/);
});
