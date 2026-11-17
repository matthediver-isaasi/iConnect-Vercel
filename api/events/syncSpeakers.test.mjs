import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./[id]/sync-speakers.js',import.meta.url),'utf8')
  .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'')
  .replace('export default async function handler','return async function handler');
async function request({admin=true,authenticated=true,mismatch=false,found=true,method='POST'}={}) {
  const filters=[],actions=[];
  const db={from(table){const q={select(){return q;},eq(k,v){filters.push([table,k,v]);return q;},
    maybeSingle:async()=>({data:table==='event'?(found?{zoom_webinar_id:'webinar'}:null):{status:'completed'}})};return q;},
    rpc:async(name,args)=>{actions.push({name,args});return {};}};
  const handler=new Function('supabase','getTenantContext','hasAdminAccess','runZoomSpeakerSync',source)(
    db,async()=>({tenantId:'tenant',isAuthenticated:authenticated,tenantMismatch:mismatch}),
    async()=>admin,async args=>actions.push(args));
  const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};
  await handler({method,query:{id:'event'}},res);return {res,filters,actions};
}
test('only authenticated tenant admins can reconcile panelists',async()=>{
  for(const args of [{admin:false},{authenticated:false},{mismatch:true}]) {
    const f=await request(args);assert.ok([401,403].includes(f.res.statusCode));assert.equal(f.actions.length,0);assert.equal(f.filters.length,0);
  }
});
test('foreign or absent event never queues work',async()=>{
  const f=await request({found:false});assert.equal(f.res.statusCode,404);assert.equal(f.actions.length,0);
  assert.ok(f.filters.some(x=>x[1]==='tenant_id'&&x[2]==='tenant'));
});
test('status reads have no effects; reconciliation queues and processes exact tenant/webinar',async()=>{
  const read=await request({method:'GET'});assert.equal(read.actions.length,0);
  const write=await request();assert.equal(write.res.statusCode,200);
  assert.deepEqual(write.actions[0],{name:'queue_zoom_speakers',args:{p_tenant:'tenant',p_webinar:'webinar'}});
  assert.deepEqual(write.actions[1],{tenantId:'tenant',webinarId:'webinar'});
});
