import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberChangeAuthorityService } from './memberChangeAuthority.js';
test('confirmation re-resolves evidence and refuses changed or foreign authority', async () => {
  const context={tenantId:'tenant',memberId:'member',actorId:'member',actorKind:'member'};
  const authority={version:1,tenantId:'tenant',memberId:'member',sourceSnapshot:{id:'purchase'},
    calculation:{sourceRecordId:'purchase',entitlementApplied:false,settlementStatus:'not_started'},
    fundingEvidence:{sourceRecordId:'purchase',complete:true},settlement:{approvalRequired:true}};
  let writes=0;
  const service=createMemberChangeAuthorityService({resolve:async()=>structuredClone(authority),
    db:{rpc:async()=>{writes++;return {data:{id:'confirmed'}};}}});
  const preview=await service.preview(context,{});
  assert.deepEqual(await service.confirm(context,{selection:{},fingerprint:preview.fingerprint,key:'request-key'}),{id:'confirmed'});
  authority.fundingEvidence.changed=true;
  await assert.rejects(service.confirm(context,{selection:{},fingerprint:preview.fingerprint,key:'request-key'}),/changed/);
  await assert.rejects(service.preview({...context,actorId:'other'},{}),/foreign/);
  assert.equal(writes,1);
});
