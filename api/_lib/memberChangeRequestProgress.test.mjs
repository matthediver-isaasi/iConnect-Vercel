import test from 'node:test';
import assert from 'node:assert/strict';
import {attachMemberRequestProgress} from './memberChangeRequestProgress.js';
test('member progress reports persisted application rather than approval or provider acceptance',async()=>{
 const records=['paid','refund','done','monthly','uncertain','not-started'].map(id=>({id,authorityId:id,state:'approved'}));
 const rows={financialChanges:[
  {id:'paid',execution:{},settlement:{state:'awaiting_payment',evidence:{secret:'private'}}},
  {id:'refund',execution:{},settlement:{state:'awaiting_refund'}},
  {id:'done',application:{id:'private-application'}},
 ],monthlyChanges:[
  {id:'monthly',operation:{state:'provider_applied',evidence:{application:null}}},
  {id:'uncertain',operation:{state:'uncertain'}},
 ]};
 const result=await attachMemberRequestProgress({}, {tenantId:'tenant',memberId:'member'},records,
  async(db,tenant,member)=>{assert.equal(tenant,'tenant');assert.equal(member,'member');return rows;});
 assert.deepEqual(result.map(r=>r.progress.state),['awaiting_payment','awaiting_refund','applied','processing','awaiting_reconciliation','approved']);
 assert.equal(JSON.stringify(result).includes('secret'),false);
 assert.equal(JSON.stringify(result).includes('private-application'),false);
});
test('failed progress reads remain explicitly unknown; pending requests need no finance read',async()=>{
 const read=async()=>{throw Error('offline')};
 const pending={id:'pending',state:'pending'};
 assert.deepEqual(await attachMemberRequestProgress({}, {},[pending],read),[pending]);
 const result=await attachMemberRequestProgress({}, {},[{state:'approved',authorityId:'id'}],read);
 assert.equal(result[0].progress.state,'unavailable');
});
