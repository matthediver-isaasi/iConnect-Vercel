import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./[id]/change-zoom.js', import.meta.url),'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace('export default async function handler','return async function handler');
async function run({enabled=true,admin=true,lookupFailure=false,registerOutcome='existing',foreign=false}={}) {
  const writes=[], filters=[];
  const record={id:'local',tenant_id:foreign?'other':'tenant',zoom_meeting_id:'123',registration_required:false};
  const db={from(table){let update=false;const chain={then(resolve){return Promise.resolve({data:table==='event'?{id:'event',zoom_meeting_id:'local',zoom_webinar_id:null}:record,error:null}).then(resolve);}};
    for(const op of ['select','eq','single','maybeSingle','update']) chain[op]=(...args)=>{if(op==='update'){update=true;writes.push([table,args[0]]);}if(op==='eq')filters.push(args);return chain;};return chain;}};
  let cancels=0,emails=0;
  const handler = new Function('supabase','getTenantContext','hasAdminAccess','cancelZoomRegistrant','cancelZoomMeetingRegistrant','confirmedZoomBookings','zoomAuthority','zoomEvidence','listZoomRegistrations','registerWithZoom','sendConfirmationEmailsFromTemplate',source)(
    db,async()=>({isAuthenticated:true,tenantId:'tenant'}),async()=>admin,async()=>{cancels++;return false;},async()=>{cancels++;return false;},
    async()=>{if(lookupFailure)throw new Error('Booking lookup failed');return [{id:'b',attendee_email:'a@example.invalid'}];},
    async()=>({live:{registration_required:enabled},kind:'meetings',id:'123',token:'t'}),async()=>({}),async()=>new Map(),
    async()=>({success:registerOutcome==='existing',outcome:registerOutcome,join_url:registerOutcome==='existing'?'personal':null}),
    async()=>{emails++;return [{success:true}];});
  const res={status(n){this.code=n;return this;},json(d){this.body=d;return this;}};
  await handler({method:'POST',query:{id:'event'},body:{zoom_meeting_id:'local',cancelOld:true,registerNew:true,resendConfirmations:true}},res);
  return {res,writes,filters,cancels,emails};
}
test('disabled registration and failed booking lookup perform no writes',async()=>{
  for(const options of [{enabled:false},{lookupFailure:true}]){const r=await run(options);assert.ok(r.res.code>=400);assert.equal(r.writes.length,0);}
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
