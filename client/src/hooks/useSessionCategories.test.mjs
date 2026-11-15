import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise hook query ownership without constructing unrelated auth/UI providers.
function hookFixture() {
  const state={tenantIntent:null,generation:1,paused:false,query:null,requests:[],response:[]};
  const source=readFileSync(new URL('./useSessionCategories.js',import.meta.url),'utf8')
    .replace(/import[\s\S]*?from\s+['"][^'"]+['"];?/g,'').replace('export function useSessionCategories','function useSessionCategories');
  const dependencies={
    useSyncExternalStore:(_subscribe,get)=>get(), useQuery:options=>{state.query=options;return {data:state.cached};},
    subscribeToActiveTenantId:()=>{},getActiveTenantId:()=>state.tenantIntent,
    subscribeToViewerProtectedWork:()=>{},getViewerProtectedWorkGeneration:()=>state.generation,isViewerProtectedWorkPaused:()=>state.paused,
    activeSessionCategories:value=>value,
    adminFetch:async(url,options,tenant)=>{state.requests.push({url,tenant});return {ok:true,json:async()=>state.response};},
  };
  const hook=new Function(...Object.keys(dependencies),`${source}; return useSessionCategories;`)(...Object.values(dependencies));
  return {state,hook};
}
test('cold portal editor discovers categories without the dashboard tenant singleton',async()=>{
  const {state,hook}=hookFixture();
  hook({memberInfo:{id:'member',tenant_id:'portal-tenant',role_id:'role'},isAccessReady:true});
  assert.equal(state.query.enabled,true);
  state.response=[{id:'category:Name',name:'Name',category_id:'category',category_name:'Parent'}];
  assert.deepEqual(await state.query.queryFn({}),state.response);
  assert.equal(state.requests[0].tenant,'portal-tenant');
  assert.deepEqual(state.query.queryKey,['session-resource-subcategories-v2','portal-tenant','member','role',1]);
});
test('context changes and recovery cannot publish an old catalogue or expose cached labels',async()=>{
  const {state,hook}=hookFixture();
  const input={memberInfo:{id:'m',tenant_id:'a'},isAccessReady:true};
  hook(input); const pending=state.query.queryFn({});
  state.generation++;
  await assert.rejects(pending,/association changed/);
  state.cached=[{name:'Old label'}]; state.tenantIntent='b';
  assert.equal(hook(input).data,undefined);
  assert.equal(state.query.enabled,false);
  state.tenantIntent=null;state.paused=true;
  assert.equal(hook(input).data,undefined);
  assert.equal(state.query.enabled,false);
});
test('malformed category discovery is an error, not an empty catalogue',async()=>{
  const {state,hook}=hookFixture();
  state.tenantIntent='admin-tenant';state.response={unexpected:[]};
  hook({isAccessReady:true});
  await assert.rejects(state.query.queryFn({}),/Invalid category catalogue/);
});
