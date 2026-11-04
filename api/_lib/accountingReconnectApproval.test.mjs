import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeAccountingReconnect} from './accountingReconnectApproval.js';
const row={id:'request',tenant_id:'tenant',provider:'xero',company_id:'company',connection_id:'old'};
const binding={tenantId:'tenant',provider:'xero',companyId:'company',connectionId:'new',accessToken:'fixture'};
function db(approval,error=null){
  const filters={};
  const q={select(){return q;},eq(k,v){filters[k]=v;return q;},is(k,v){filters[k]=v;return q;},
    async maybeSingle(){return {data:approval&&Object.entries(filters).every(([k,v])=>approval[k]===v)?approval:null,error};}};
  return {from(name){assert.equal(name,'accounting_reconnect_approval');return q;}};
}
const approval={request_id:'request',tenant_id:'tenant',provider:'xero',company_id:'company',
  previous_connection_id:'old',new_connection_id:'new',revoked_at:null};
test('unchanged connection needs no approval lookup',async()=>{
  const original={...binding,connectionId:'old'};
  assert.equal(await authorizeAccountingReconnect({db:null,row,binding:original}),original);
});
test('approved exact reconnection retains frozen authority with current credentials',async()=>{
  const result=await authorizeAccountingReconnect({db:db(approval),row,binding});
  assert.equal(result.connectionId,'old');
  assert.equal(result.accessToken,'fixture');
  assert.equal(binding.connectionId,'new');
});
test('other requests, companies, tenants, providers, revoked or missing approvals fail closed',async()=>{
  for(const changed of [{...approval,request_id:'another'},{...approval,revoked_at:'today'},
    {...approval,new_connection_id:'another'},{...approval,previous_connection_id:'another'},
    {...approval,tenant_id:'another'},{...approval,company_id:'another'},null]){
    await assert.rejects(authorizeAccountingReconnect({db:db(changed),row,binding}),/BINDING_CHANGED/);
  }
  for(const changed of [{...binding,companyId:'another'},{...binding,tenantId:'another'},{...binding,provider:'quickbooks'}]){
    await assert.rejects(authorizeAccountingReconnect({db:db(approval),row,binding:changed}),/BINDING_CHANGED/);
  }
  await assert.rejects(authorizeAccountingReconnect({db:db(approval,{message:'unavailable'}),row,binding}),/BINDING_CHANGED/);
});
