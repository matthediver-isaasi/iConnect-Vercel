import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberStartHandler } from './member-start.js';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(changes = {}) {
  const calls=[];
  const row={id:id(3),tenant_id:id(1),member_id:id(2),term_start_date:'2026-11-08',
    term_end_date:'2028-06-30',term_source_snapshot:{type:'member_date_field'}};
  const db={from(table){const q={select(){return q},eq(k,v){calls.push([table,k,v]);return q},
    maybeSingle:async()=>({data:changes.notFound?null:row,error:null})};return q},
    async rpc(name,args){calls.push({name,args});return {data:{history_id:id(3),audit_id:id(4),term_end_date:'2029-06-30'},error:null}}};
  const context={isAuthenticated:true,tenantId:id(1),tenantUserId:id(5),...changes.context};
  return {calls,handler:createMemberStartHandler({db, getContext:async()=>context,
    isAdmin:async()=>changes.admin!==false,hasFinance:async()=>true,service:{}})};
}
async function invoke(f,body={}) {
  const res={code:200,setHeader(){},status(n){this.code=n;return this},json(v){this.body=v;return this}};
  await f.handler({method:'POST',body:{action:'extend-date-term',memberId:id(2),historyId:id(3),
    expectedEnd:'2028-06-30',newEnd:'2029-06-30',reason:'Course extended',...body}},res);
  return res;
}
test('extension uses authenticated audit identity and exact tenant/member/history scope',async()=>{
  const f=fixture();const r=await invoke(f,{actor:'forged'});
  assert.equal(r.code,200);
  const rpc=f.calls.find(x=>x.name);
  assert.equal(rpc.args.p_actor,id(5));
  for(const [key,value] of [['tenant_id',id(1)],['member_id',id(2)],['id',id(3)]]) {
    assert.ok(f.calls.some(x=>Array.isArray(x)&&x[1]===key&&x[2]===value));
  }
});
test('non-admins, stale dates and cross-tenant missing rows never invoke extension',async()=>{
  for(const [f,body,code] of [[fixture({admin:false}),{},403],
    [fixture(),{expectedEnd:'2027-06-30'},409],[fixture({notFound:true}),{},404],
    [fixture(),{reason:' '},422],[fixture(),{newEnd:'2027-01-01'},422]]) {
    assert.equal((await invoke(f,body)).code,code);
    assert.equal(f.calls.some(x=>x.name),false);
  }
});
