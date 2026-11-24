import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPaymentGraceExitEvidence } from './paymentGraceExitEvidence.js';
const history = { id:'h',tenant_id:'t',member_id:'m',config_id:'c',billing_agreement_id:'a',
  status:'expired',payment_grace_exit_id:'e',term_start_date:'2026-01-01',term_end_date:'2026-12-31' };
const receipt = { id:'e',tenant_id:'t',member_id:'m',history_id:'h',agreement_id:'a',config_id:'c',
  original_term_start_date:'2026-01-01',original_term_end_date:'2026-12-31' };
test('only exact server-verified receipts attach to expired owned history', async () => {
  const calls=[];
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:receipt};}};
  const [result] = await attachPaymentGraceExitEvidence(db,'t','m',[history]);
  assert.deepEqual(result.paymentGraceExit,receipt);
  assert.equal(history.paymentGraceExit,undefined);
  assert.deepEqual(calls,[{name:'membership_payment_grace_exit_evidence',
    args:{p_tenant_id:'t',p_member_id:'m',p_history_id:'h'}}]);
  for(const change of [{id:'other'},{tenant_id:'other'},{member_id:'other'},{history_id:'other'},
    {agreement_id:'other'},{config_id:'other'},{original_term_end_date:'2025-01-01'}]) {
    await assert.rejects(attachPaymentGraceExitEvidence({rpc:async()=>({data:{...receipt,...change}})},'t','m',[history]),
      /could not be verified/);
  }
  await assert.rejects(attachPaymentGraceExitEvidence({rpc:async()=>({error:{code:'PGRST202'}})},'t','m',[history]),
    /could not be verified/);
  await assert.rejects(attachPaymentGraceExitEvidence(db,'other','m',[history]),/ownership mismatch/);
});
test('ordinary histories do not query or acquire a new eligibility mechanism', async () => {
  const ordinary = {...history,payment_grace_exit_id:null};
  assert.deepEqual(await attachPaymentGraceExitEvidence({rpc(){assert.fail('unexpected read');}},'t','m',[ordinary]),[ordinary]);
});
