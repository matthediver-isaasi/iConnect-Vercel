import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePaginatedMembers } from '../members/paginated.js';
import { handlePaginatedOrganizations } from '../organizations/paginated.js';
import { makeResponse } from './paginatedFakeSupabase.mjs';

const tenant='00000000-0000-4000-8000-000000000001';
const id='00000000-0000-4000-8000-000000000002';
const context=async()=>({isAuthenticated:true,tenantId:tenant,tenantUserId:'admin'});
for (const [entity,handler,field] of [['member',handlePaginatedMembers,'first_name'],['organization',handlePaginatedOrganizations,'name']]) {
  test(`${entity}: metadata uses one bounded RPC, authenticated tenant, POST IDs and no page enrichment`,async()=>{
    let call;
    const db={
      from(){throw new Error('Unexpected row enumeration or enrichment');},
      async rpc(name,args){call={name,args};return {data:{total:1201,buckets:[{label:'A',count:1201,offset:0,id}]},error:null};},
    };
    const req={method:'POST',body:{ids:[id]},query:{alphabet:'1',sortField:field,sortDir:'asc',tenantId:'attacker',search:'Ada',page:'99',limit:'10',fields:'unrelated'}};
    const res=makeResponse();
    await handler(req,res,{db,getContext:context});
    assert.equal(res.statusCode,200);
    assert.equal(call.name,'crm_alphabet_metadata');
    assert.equal(call.args.p_tenant,tenant);
    assert.equal(call.args.p_entity,entity);
    assert.ok(call.args.p_filters.base.some(n=>n.column==='id' && n.value[0]===id));
    assert.equal(call.args.p_filters.base.some(n=>n.column==='tenant_id' && n.value==='attacker'),false);
    assert.equal(JSON.stringify(call.args).includes('unrelated'),false);
  });
  test(`${entity}: denied and anonymous requests never reach metadata or rows`,async()=>{
    for (const ctx of [{},{isAuthenticated:true,tenantId:tenant,tenantMismatch:true},{isAuthenticated:true,tenantId:tenant,memberId:'m'}]) {
      const res=makeResponse();
      await handler({method:'GET',query:{alphabet:'1',sortField:field,sortDir:'asc'}},res,{
        db:{from(){throw new Error('Unexpected read');},rpc(){throw new Error('Unexpected RPC');}},getContext:async()=>ctx,
      });
      assert.ok([401,403].includes(res.statusCode));
    }
  });
  test(`${entity}: metadata failures and unsupported sorts are explicit without changing list mode`,async()=>{
    for (const [sortDir,status] of [['asc',503],['desc',400]]) {
      const res=makeResponse();
      await handler({method:'GET',query:{alphabet:'1',sortField:field,sortDir}},res,{
        db:{rpc:async()=>({data:null,error:{message:'unavailable'}})},getContext:context,
      });
      assert.equal(res.statusCode,status);
    }
  });
}
