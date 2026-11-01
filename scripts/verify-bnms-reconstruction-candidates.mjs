import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir='generated-artifacts/bnms-expiry-only-audit';
const review=JSON.parse(fs.readFileSync(`${dir}/live-review.json`));
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const {getValidXeroAccessToken}=await import('../api/_lib/xero.js');
const auth=await getValidXeroAccessToken('ff2df806-b321-4254-b651-3af11fccf1db');
assert.equal(auth.tenantId,'3d57dce6-2205-462f-abf6-9c7cbf00be23');
const results=[];
for(const r of review.reports.filter(r=>r.outcome==='Candidate for reconstruction')){
  const candidate=r.evidence.find(i=>!i.issues.length);
  const invoice=review.invoices.find(i=>i.InvoiceID===candidate.id);
  const payments=[];
  for(const p of invoice.Payments||[]){
    const response=await fetch(`https://api.xero.com/api.xro/2.0/Payments/${p.PaymentID}`,{
      headers:{Authorization:`Bearer ${auth.accessToken}`,'xero-tenant-id':auth.tenantId,Accept:'application/json'},
      signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200,'Payment verification failed');
    const actual=(await response.json()).Payments[0];
    assert.equal(actual.Invoice.InvoiceID,invoice.InvoiceID);
    payments.push({id:actual.PaymentID,amount:actual.Amount,status:actual.Status,
      reconciled:actual.IsReconciled,date:actual.Date});
  }
  const verified=payments.length>0&&payments.every(p=>p.status==='AUTHORISED'&&p.reconciled===true)
    && Math.abs(payments.reduce((n,p)=>n+p.amount,0)-invoice.Total)<0.005;
  results.push({memberId:r.memberId,name:r.name,start:r.proposedStart,end:r.expiry,
    invoice:candidate.number,membershipLine:candidate.membershipLine,schedule:r.schedule,verified,payments});
}
fs.writeFileSync(`${dir}/candidate-payment-verification.json`,JSON.stringify({checkedAt:new Date().toISOString(),results},null,2),{mode:0o600});
const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;
const rows=[['Member','Member ID','Schedule','Proposed start','Retained expiry','Xero invoice','Membership line amount','Tax amount','Payment reconciled']];
for(const r of results) rows.push([r.name,r.memberId,r.schedule,r.start,r.end,r.invoice,r.membershipLine.amount,r.membershipLine.tax,r.verified?'Yes':'Review required']);
fs.writeFileSync(`${dir}/BNMS-reconstruction-candidates.csv`,rows.map(r=>r.map(quote).join(',')).join('\r\n'),{mode:0o600});
console.log(JSON.stringify({candidates:results.length,paymentVerified:results.filter(r=>r.verified).length,unverified:results.filter(r=>!r.verified).map(r=>r.name)}));
