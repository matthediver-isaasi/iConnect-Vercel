import test from 'node:test';
import assert from 'node:assert/strict';
import {returnBackedMemberCredit as restore} from './memberCreditReturn.js';
const input={tenantId:'tenant',allocationId:'allocation',refundKey:'refund',cumulativeMinor:500};
function fixture(){
 const context={applicable:true,amendment:{tenant_id:'tenant'},settlement:{tenant_id:'tenant'},
  binding:{accountId:'liability'},entries:[],expectedActiveMinor:500};
 const calls=[];
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='member_credit_return_context'?context:{amountMinor:500}}}};
 const finance={inspect:async()=>({state:'settled',evidence:{kind:'member_credit_backed',liabilityAccountId:'liability'}}),
  verifyCreditReturn:async()=>({verified:true,activeMinor:500})};
 return {context,calls,db,finance};
}
test('cash refund authority is insufficient without independently verified liability restoration',async()=>{
 const f=fixture();
 f.finance.verifyCreditReturn=async()=>({verified:false,activeMinor:500});
 await assert.rejects(restore(f.db,input,f),/not verified/);
 assert.deepEqual(f.calls.map(c=>c.name),['member_credit_return_context']);
 f.finance.verifyCreditReturn=async()=>({verified:true,activeMinor:500});
 assert.equal((await restore(f.db,input,f)).result.amountMinor,500);
 assert.equal(f.calls.at(-1).name,'apply_verified_member_credit_return');
});
test('already-applied returns recover without another external or balance write',async()=>{
 const f=fixture();f.context.alreadyApplied=true;f.context.result={amountMinor:500};
 f.finance.inspect=()=>assert.fail('Completed replay must not initiate financial work');
 assert.equal((await restore(f.db,input,f)).result.amountMinor,500);
 assert.equal(f.calls.length,1);
});
test('foreign ownership and uncertain backing cannot restore credit',async()=>{
 const f=fixture();f.context.amendment.tenant_id='other';
 await assert.rejects(restore(f.db,input,f),/ownership/);
 f.context.amendment.tenant_id='tenant';f.finance.inspect=async()=>({state:'uncertain'});
 await assert.rejects(restore(f.db,input,f),/financial review/);
 assert.ok(f.calls.every(c=>c.name==='member_credit_return_context'));
});
