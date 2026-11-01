// Read-only verification of saved repairs, including the real renewal pricing path.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir='generated-artifacts/bnms-expiry-only-audit';
const receipts=JSON.parse(fs.readFileSync(`${dir}/reconstruction-second-apply.json`)).receipts;
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {supabase}=await import('../api/_lib/database.js');
const {loadFormMembershipRenewalContext}=await import('../api/_lib/formMembershipRenewalContext.js');
const {createMembershipSimulator}=await import('../api/_lib/membershipSimulationCore.js');
const {selectCanvasCommitment,buildCanvasSummary}=await import('../api/membership/canvas-summary.js');
const simulate=createMembershipSimulator(supabase).simulateMembershipForMember;
const results=[];
for(let offset=0;offset<receipts.length;offset+=4){
  results.push(...await Promise.all(receipts.slice(offset,offset+4).map(async r=>{
    const tenantId='ff2df806-b321-4254-b651-3af11fccf1db';
    const {data,error}=await supabase.from('member_membership_history').select('*').eq('tenant_id',tenantId).eq('member_id',r.memberId);
    assert.ifError(error);assert.equal(data.length,1);
    assert.equal(data[0].term_start_date,r.start);assert.equal(data[0].term_end_date,r.end);
    assert.equal(data[0].accounting_invoice_number,r.invoice);
    const today=new Date().toISOString().slice(0,10);
    const summary=buildCanvasSummary({selected:selectCanvasCommitment(data.map(h=>({...h,membership_source:'personal'})),[],today),today});
    assert.equal(summary.payment.state,'paid');assert.equal(summary.membership.state,'active');
    const scope={tenantId,memberId:r.memberId,simulate};
    const current=await loadFormMembershipRenewalContext(supabase,scope);
    const inWindow=new Date(`${r.end}T12:00:00Z`);inWindow.setUTCDate(inWindow.getUTCDate()-60);
    const renewal=await loadFormMembershipRenewalContext(supabase,{...scope,now:inWindow});
    return {name:r.name,memberId:r.memberId,invoice:r.invoice,start:r.start,end:r.end,amount:r.amount,
      paymentState:summary.payment.state,currentRenewal:current.renewal.state,
      windowState:renewal.renewal.state,pricingSuccess:renewal.simulation?.success===true,
      eligible:renewal.renewal.eligible,reason:renewal.renewal.message||renewal.renewal.reason||null};
  })));
}
fs.writeFileSync(`${dir}/second-renewal-verification.json`,JSON.stringify(results,null,2),{mode:0o600});
console.log(JSON.stringify({checked:results.length,activePaid:results.length,
  renewalPriced:results.filter(r=>r.eligible&&r.pricingSuccess).length,
  exceptions:results.filter(r=>!r.eligible||!r.pricingSuccess)}));
