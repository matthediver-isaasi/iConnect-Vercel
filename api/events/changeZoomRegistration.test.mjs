import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./[id]/change-zoom.js', import.meta.url),'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace('export default async function handler','return async function handler');
const helperSource = readFileSync(new URL('../_lib/eventZoomRegistration.js', import.meta.url),'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replaceAll('export async function', 'async function');
async function run({enabled=true,admin=true,lookupFailure=false,registerOutcome='existing',foreign=false,method='POST'}={}) {
  const writes=[], filters=[];
  const record={id:'local',tenant_id:foreign?'other':'tenant',zoom_meeting_id:'123',registration_required:false};
  const db={from(table){let update=false;const chain={then(resolve){return Promise.resolve(table==='booking' ? {data:lookupFailure?null:[{id:'b',attendee_email:'a@example.invalid'}],error:lookupFailure?{code:'42703'}:null} : {data:table==='event'?{id:'event',zoom_meeting_id:'local',zoom_webinar_id:null}:record,error:null}).then(resolve);}};
    for(const op of ['select','eq','single','maybeSingle','update','order','range']) chain[op]=(...args)=>{if(op==='update'){update=true;writes.push([table,args[0]]);}if(op==='eq')filters.push(args);return chain;};return chain;}};
  const realBookings = new Function('supabase', helperSource+'; return confirmedZoomBookings;')(db);
  let cancels=0,emails=0,authorities=0,registrations=0;
  const realEvidence = new Function('getZoomAccessTokenForTenant','readZoomRegistration','listZoomRegistrations',
    helperSource+'; return zoomEvidence;')(
      async()=> 't', async()=>({topic:'Live meeting',numericId:'123',registration_required:enabled}), async()=>new Map());
  const handler = new Function('supabase','getTenantContext','hasAdminAccess','cancelZoomRegistrant','cancelZoomMeetingRegistrant','confirmedZoomBookings','zoomAuthority','zoomEvidence','listZoomRegistrations','registerWithZoom','sendConfirmationEmailsFromTemplate',source)(
    db,async()=>({isAuthenticated:true,tenantId:'tenant'}),async()=>admin,async()=>{cancels++;return false;},async()=>{cancels++;return false;},
    realBookings,
    async()=>{authorities++;return {live:{registration_required:enabled},kind:'meetings',id:'123',token:'t'};},realEvidence,async()=>new Map(),
    async()=>{registrations++;return {success:registerOutcome==='existing',outcome:registerOutcome,join_url:registerOutcome==='existing'?'personal':null};},
    async()=>{emails++;return [{success:true}];});
  const res={status(n){this.code=n;return this;},json(d){this.body=d;return this;}};
  await handler({method,query:{id:'event'},body:{zoom_meeting_id:'local',cancelOld:true,registerNew:true,resendConfirmations:true}},res);
  return {res,writes,filters,cancels,emails,authorities,registrations};
}
test('disabled registration and failed booking lookup perform no writes',async()=>{
   for(const options of [{enabled:false},{lookupFailure:true}]){const r=await run(options);assert.ok(r.res.code>=400);assert.equal(r.writes.length,0);assert.equal(r.cancels,0);assert.equal(r.emails,0);}
});
test('GET retains current target and unavailable count when real booking helper fails', async()=>{
  const r=await run({method:'GET',lookupFailure:true});
  assert.equal(r.res.code,200);
  assert.equal(r.res.body.current.zoom_meeting_id,'local');
  assert.equal(r.res.body.confirmedBookings,null);
  assert.equal(r.res.body.live.topic,'Live meeting');
  assert.equal(r.res.body.cached.numericId,'123');
  assert.equal(r.res.body.counts,null);
  assert.match(r.res.body.bookingError,/lookup failed/);
  assert.equal(r.writes.length,0);
});
test('POST booking failure precedes all provider calls including registration enablement',async()=>{
  const r=await run({lookupFailure:true});
  assert.equal(r.authorities,0);
  assert.equal(r.registrations,0);
  assert.equal(r.cancels,0);
  assert.equal(r.emails,0);
  assert.equal(r.writes.length,0);
});
test('admin and tenant gates deny writes',async()=>{
  for(const options of [{admin:false},{foreign:true}]){const r=await run(options);assert.ok(r.res.code>=400);assert.equal(r.writes.length,0);}
});
test('same target preserves registrations; pending does not send false confirmation',async()=>{
  const r=await run();assert.equal(r.cancels,0);assert.equal(r.res.body.registered,0);assert.equal(r.res.body.existing,1);assert.equal(r.emails,1);
  const p=await run({registerOutcome:'pending'});assert.equal(p.emails,0);assert.equal(p.res.body.pending,1);
  assert.ok(p.filters.some(([key,val])=>key==='tenant_id'&&val==='tenant'));
  assert.equal(r.res.body.eventPatch.online_provider,'zoom');
});
test('editor syncs provider and selected meeting without a reload',()=>{
  const editor=readFileSync(new URL('../../client/src/pages/EditEvent.jsx',import.meta.url),'utf8');
  assert.match(editor,/if \(patch\.zoom_meeting_id \|\| patch\.zoom_webinar_id\) setOnlineProvider\('zoom'\)/);
  assert.match(editor,/setSelectedMeetingId\(patch\.zoom_meeting_id \|\| ''\)/);
  assert.doesNotMatch(editor,/window\.location\.reload\(\)/);
});
