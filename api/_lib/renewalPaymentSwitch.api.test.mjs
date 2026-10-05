import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { changeRenewalPaymentMethod, RenewalSwitchError } from './renewalPaymentSwitch.js';

const source = readFileSync(new URL('../forms/membership-payment.js', import.meta.url),'utf8');
const handler = source.slice(source.indexOf('export default async function handler('),
  source.indexOf('\nasync function getMemberById')).replace('export default ','');
const postStart = source.indexOf('async function handlePost(');
const post = source.slice(postStart,source.indexOf('\nasync function ',postStart+1)).replaceAll('import(','__import(');
const response = () => ({ statusCode:200,status(code) {this.statusCode=code;return this;},
  json(value) {this.body=value;return this;} });

for (const [name,tenant,access] of [
  ['unsigned user','tenant',{ok:false}],
  ['cross-tenant session','tenant',{ok:true,tenantId:'other'}],
  ['unresolved tenant',null,{ok:true,tenantId:'tenant'}],
]) test(`actual payment route rejects ${name} before provider reconciliation`,async () => {
  let calls=0;
  const sandbox=vm.createContext({supabase:{},console,
    resolveTenantFromRequest:async()=>tenant ? {id:tenant}:null,
    authorizeMemberAccess:async()=>access,
    handlePost:async()=>{calls++;},
  });
  vm.runInContext(handler,sandbox);
  const res=response();
  await sandbox.handler({method:'POST',body:{memberId:'member',action:'change_renewal_payment_method'}},res);
  assert.equal(res.statusCode,403);
  assert.equal(calls,0);
});
test('actual switch action rejects wrong tenant and missing election identity without provider calls',async()=>{
  const sandbox=vm.createContext({console,supabase:{rpc:()=>{throw new Error('unexpected database call');}},
    getMemberById:async()=>({id:'member',tenant_id:'tenant'}),
    changeRenewalPaymentMethod,RenewalSwitchError,
  });
  vm.runInContext(post,sandbox);
  for (const tenant of ['other','tenant']) {
    const res=response();
    await sandbox.handlePost({body:{memberId:'member',action:'change_renewal_payment_method'}},res,tenant);
    assert.equal(res.statusCode,tenant==='other'?403:409);
  }
});
test('authorized switch binds current owner, payer and the explicit stale-tab election ID',async()=>{
  let received;
  const sandbox=vm.createContext({console,supabase:{},RenewalSwitchError,
    getMemberById:async()=>({id:'member',tenant_id:'tenant',organization_id:'organization'}),
    changeRenewalPaymentMethod:async args=>{received=args;return {released:true};},
  });
  vm.runInContext(post,sandbox);
  const res=response();
  await sandbox.handlePost({body:{memberId:'member',action:'change_renewal_payment_method',
    electionId:'explicit-election',organizationId:'forged-owner'}},res,'tenant');
  assert.equal(res.statusCode,200);
  assert.equal(received.organizationId,'organization');
  assert.equal(received.memberId,'member');
  assert.equal(received.tenantId,'tenant');
  assert.equal(received.electionId,'explicit-election');
});
