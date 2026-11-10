import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

const result = await build({
 entryPoints:['api/functions/sync-mailgun-events.js'],bundle:true,write:false,platform:'node',format:'cjs',
 plugins:[{name:'dependencies',setup(b){
  b.onResolve({filter:/\/_lib\//},args=>({path:args.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:
   path.includes('database')?'export const supabase={from:(...a)=>globalThis.syncTest.db.from(...a)};':
   path.includes('tenantContext')?'export const getTenantContext=async()=>globalThis.syncTest.context; export const hasAdminAccess=async()=>globalThis.syncTest.admin;':
   path.includes('mailgunEventSync')?'export const fetchMailgunEvents=()=>{}; export const syncCampaignEvents=async()=>{globalThis.syncTest.calls.push("events");return {processed:4,skipped:0,totalEvents:4,errors:0,timedOut:false};};':
   path.includes('campaignAcceptanceRecovery')?'export const recoverCampaignAcceptance=async(_db,campaign)=>{globalThis.syncTest.calls.push("acceptance"); if(globalThis.syncTest.fail)throw Error("provider denied");return {checked:10,recovered:8};};':
   'export const finalizeCampaignDelivery=async()=>{globalThis.syncTest.calls.push("finalize");};'
  }));
 }}],
});
const compiled=new Module(`${process.cwd()}/sync-events-test.cjs`);
compiled.filename=`${process.cwd()}/sync-events-test.cjs`;
compiled.paths=Module._nodeModulePaths(process.cwd());
compiled._compile(result.outputFiles[0].text,compiled.filename);
function fixture({context={tenantId:'tenant'},admin=true,missing=false,fail=false}={}){
 const state={context,admin,fail,calls:[],db:{from(table){
  const filters=[];
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},
   single:async()=>{
    if(table==='email_campaign'){
     assert.ok(filters.some(([k,v])=>k==='tenant_id'&&v==='tenant'));
     return {data:missing?null:{id:'campaign',tenant_id:'tenant',sent_at:'2026-11-09'}};
    }
    return {data:{settings:{email_domain:{domain:'example.test'}}}};
   },
   then(resolve){return Promise.resolve({count:2}).then(resolve);}};
  return q;
 }}};
 globalThis.syncTest=state;
 const res={code:200,setHeader(){},status(c){this.code=c;return this;},json(body){this.body=body;return this;},end(){}};
 return {state,res,req:{method:'POST',headers:{},body:{campaignId:'campaign'}}};
}
test('resync checks acceptance, syncs events, finalizes and reports unresolved recipients',async()=>{
 const f=fixture();await compiled.exports.default(f.req,f.res);
 assert.equal(f.res.code,200);
 assert.deepEqual(f.state.calls,['acceptance','events','finalize']);
 assert.equal(f.res.body.summary.acceptance_recovered,8);
 assert.equal(f.res.body.summary.awaiting_reconciliation,2);
});
test('resync requires admin and tenant-scoped campaign before provider work',async()=>{
 for(const [options,status] of [[{context:{}},401],[{admin:false},403],[{missing:true},404]]){
  const f=fixture(options);await compiled.exports.default(f.req,f.res);
  assert.equal(f.res.code,status);assert.deepEqual(f.state.calls,[]);
 }
});
test('failed provider check reports failure without proceeding or pretending completion',async()=>{
 const f=fixture({fail:true});await compiled.exports.default(f.req,f.res);
 assert.equal(f.res.code,503);assert.match(f.res.body.error,/No emails were resent/);
 assert.deepEqual(f.state.calls,['acceptance']);
});
