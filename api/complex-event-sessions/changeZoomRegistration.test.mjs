import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./[id]/change-zoom.js',import.meta.url),'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace('export default async function handler','return async function handler');
async function run({same=true,afterBookingId=null,registerNew=true,cancelOld=true,resendConfirmations=false}={}) {
  const writes=[];let cancelled=0,registered=0;
  const rows=Array.from({length:51},(_,i)=>({id:String(i).padStart(3,'0'),attendee_email:`test${i}@example.invalid`}));
  const db={from(table){let slice=null;const chain={then(resolve){let data = table==='complex_event_session'?{id:'session',complex_event_id:'event',zoom_meeting_id:same?'123':'456',zoom_webinar_id:null}
    :table==='zoom_meeting'?{id:'local',tenant_id:'tenant',zoom_meeting_id:'123'}
    :table==='complex_event_session_track'?[]
    :table==='complex_event_ticket_class'?[{id:'ticket',all_tracks:true}]
    :slice?rows.slice(slice[0],slice[1]+1):rows;
    return Promise.resolve({data,error:null}).then(resolve);}};
    for(const op of ['select','eq','in','order','single','maybeSingle','update','range'])chain[op]=(...args)=>{if(op==='update')writes.push([table,args[0]]);if(op==='range')slice=args;return chain;};return chain;}};
  const handler=new Function('supabase','getTenantContext','hasAdminAccess','cancelZoomRegistrant','cancelZoomMeetingRegistrant','zoomAuthority','listZoomRegistrations','registerWithZoom','sendConfirmationEmailsFromTemplate',source)(
    db,async()=>({isAuthenticated:true,tenantId:'tenant'}),async()=>true,async()=>{cancelled++;return true;},async()=>{cancelled++;return true;},
    async()=>({kind:'meetings',id:'123',token:'t',live:{registration_required:true}}),async()=>new Map(),async()=>{registered++;return {success:true,outcome:'existing',already_registered:true,join_url:'personal'};},async()=>[]);
  const res={status(n){this.code=n;return this;},json(d){this.body=d;return this;}};
  await handler({method:'POST',query:{id:'session'},body:{zoom_meeting_id:'local',afterBookingId,registerNew,cancelOld,resendConfirmations}},res);
  return {res,writes,cancelled,registered};
}
test('session bulk different-target actions are refused before provider or database writes',async()=>{
  const r=await run({same:false});assert.equal(r.res.code,409);assert.equal(r.writes.length,0);assert.equal(r.cancelled,0);assert.equal(r.registered,0);
  const a=await run({same:false,registerNew:false,cancelOld:false});assert.equal(a.res.code,200);assert.equal(a.registered,0);
});
test('session current-target reconciliation is bounded, resumable and never cancels',async()=>{
  const a=await run();assert.equal(a.registered,25);assert.equal(a.cancelled,0);assert.equal(a.res.body.nextCursor,'024');
  const b=await run({afterBookingId:a.res.body.nextCursor});assert.equal(b.registered,25);assert.equal(b.cancelled,0);assert.equal(b.res.body.nextCursor,'049');
  const c=await run({afterBookingId:b.res.body.nextCursor});assert.equal(c.registered,1);assert.equal(c.res.body.nextCursor,null);
});
