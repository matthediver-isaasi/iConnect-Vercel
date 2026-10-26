import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemberChangeAuthorityService } from './memberChangeAuthority.js';
import {monthlyAmendmentFingerprint} from './memberAmendmentMonthly.js';
import {normalizeAmendmentRequest} from './memberAmendments.js';
test('confirmation re-resolves evidence and refuses changed or foreign authority', async () => {
  const context={tenantId:'tenant',memberId:'member',actorId:'member',actorKind:'member'};
  const authority={version:1,tenantId:'tenant',memberId:'member',sourceSnapshot:{id:'purchase'},
    calculation:{sourceRecordId:'purchase',entitlementApplied:false,settlementStatus:'not_started'},
    fundingEvidence:{sourceRecordId:'purchase',complete:true},settlement:{approvalRequired:true}};
  let writes=0;
  const service=createMemberChangeAuthorityService({resolve:async()=>structuredClone(authority),
    db:{from(){const q={select(){return q},eq(){return q},async maybeSingle(){return {data:null}}};return q},
      rpc:async()=>{writes++;return {data:{id:'confirmed'}};}}});
  const preview=await service.preview(context,{});
  assert.deepEqual(await service.confirm(context,{selection:{},fingerprint:preview.fingerprint,key:'request-key'}),{id:'confirmed'});
  authority.fundingEvidence.changed=true;
  await assert.rejects(service.confirm(context,{selection:{},fingerprint:preview.fingerprint,key:'request-key'}),/changed/);
  await assert.rejects(service.preview({...context,actorId:'other'},{}),/foreign/);
  assert.equal(writes,1);
});
test('lost confirmation responses recover unchanged without provider reads or second writes',async()=>{
 const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const context={tenantId:id(1),memberId:id(2),actorId:id(3),actorKind:'admin'};
 const selection={configId:id(4),reason:'Requested change'};
 const request=normalizeAmendmentRequest({...selection,memberId:context.memberId,settlementChoice:'defer'});
 const authority={version:1,action:'change',request,settlement:{status:'pending_approval'}};
 const record={id:id(5),tenant_id:id(1),member_id:id(2),actor_id:id(3),actor_kind:'admin',authority};
 let available=record,reads=0,writes=0;
 const db={from(){const q={select(){return q},eq(){return q},async maybeSingle(){return {data:available}}};return q},
   async rpc(){writes++;throw Error('Must not write')}};
 const service=createMemberChangeAuthorityService({db,resolve:async()=>{reads++;throw Error('Provider unavailable')}});
 const confirmation={key:'request-key',fingerprint:monthlyAmendmentFingerprint(authority),selection};
 assert.deepEqual(await service.confirm(context,confirmation),record);
 assert.deepEqual(await service.recover(context,confirmation),record);
 await assert.rejects(service.confirm(context,{...confirmation,selection:{...selection,reason:'Different'}}),/different selection/);
 await assert.rejects(service.recover({...context,actorId:id(99)},confirmation),/different evidence or actor/);
 await assert.rejects(service.recover(context,{...confirmation,fingerprint:'f'.repeat(64)}),/different evidence or actor/);
 assert.equal(reads,0);assert.equal(writes,0);
 available=null;
 assert.equal(await service.recover(context,confirmation),null);
});
