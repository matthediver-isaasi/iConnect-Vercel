import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMemberCreditRedemption} from './memberCreditRedemption.js';
function fixture(){
 const proof={amendment:{tenant_id:'tenant'},settlement:{tenant_id:'tenant'},binding:{accountCode:'850',accountId:'liability'}};
 let result={state:'settled',evidence:{kind:'member_credit_backed',liabilityAccountId:'liability'}};
 const db={rpc:async()=>({data:[proof]}),from(){return {select(){return this},eq(){return this},
  maybeSingle:async()=>({data:{setting_value:'850'}}),limit:async()=>({data:[{id:'backed-credit'}]})}}};
 let reads=0;
 const options={finance:{inspect:async()=>{reads++;return result;}}};
 return {proof,db,options,setResult:v=>{result=v},reads:()=>reads};
}
test('redemption rechecks backing against the original liability before any funding payment',async()=>{
 const f=fixture();
 await verifyMemberCreditRedemption(f.db,'tenant',[{id:'allocation'}],{name:'xero'},f.options);
 assert.equal(f.reads(),1);
 f.setResult({state:'awaiting_payment',evidence:{kind:'awaiting_member_credit_backing'}});
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'allocation'}],{name:'xero'},f.options),/backing has changed/);
});
test('accounting provider, mapping, owner and missing proofs fail closed',async()=>{
 const f=fixture();
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'quickbooks'},f.options),/another accounting provider/);
 f.proof.binding.accountCode='999';
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'xero'},f.options),/original accounting liability/);
 f.proof.binding.accountCode='850';f.proof.amendment.tenant_id='other';
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'xero'},f.options),/original accounting liability/);
 f.db.rpc=async()=>({error:{code:'PGRST202'}});
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'xero'},f.options),/proof could not be loaded/);
 assert.equal(f.reads(),0);
});
test('legacy vouchers need no liability-account or provider read',async()=>{
 await verifyMemberCreditRedemption({
  rpc:async()=>({data:[]}),from(){assert.fail('No member-credit mapping needed');},
 },'tenant',[{id:'a'}],{name:'quickbooks'});
});
test('missing migration permits legacy-only tenants, never tenants with generated membership credit',async()=>{
 const f=fixture();f.db.rpc=async()=>({error:{code:'PGRST202'}});
 await assert.rejects(verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'xero'},f.options),/proof could not be loaded/);
 f.db.from=()=>({select(){return this},eq(){return this},limit:async()=>({data:[]})});
 await verifyMemberCreditRedemption(f.db,'tenant',[{id:'a'}],{name:'quickbooks'});
 assert.equal(f.reads(),0);
});
