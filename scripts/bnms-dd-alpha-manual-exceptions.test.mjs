import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hash} from './bnms-dd-beta-invoices.mjs';
import {alphaManualApproval,ALPHA_MANUAL_APPROVAL_SHA256,approvedAlphaFailedPayment,
  approvedAlphaUnpaidInvoice,unrelatedAlphaEventInvoice,assertAlphaManualEvidence,
  alphaPaymentHistoryRequiresReconciliation} from './bnms-dd-alpha-manual-exceptions.mjs';
import {parseAlphaReleaseArgs} from './run-bnms-dd-alpha-release.mjs';
import {alphaReleaseManifest} from './bnms-dd-alpha-release.mjs';
import {alphaAccountingMapping} from '../api/_lib/bnmsAlphaAccounting.js';

test('approval is an exact immutable 2-invoice/5-attempt manual-only scope',()=>{
  const a=alphaManualApproval();
  assert.equal(hash(a),ALPHA_MANUAL_APPROVAL_SHA256);
  assert.equal(a.invoices.length,2);assert.equal(a.payments.length,5);
  assert.equal(new Set(a.payments.map(p=>p.memberId)).size,3);
  assert.equal(a.events.length,6);
  assert.equal(a.provenance.approvedAt,null);
  assert.equal(a.version,2);
  assert.deepEqual(a.renewals,[{
    kind:'unrelated_event',invoiceNumber:'200008893',id:'1ade600c-0a15-444c-bd25-842a5fd5aa70',
    approvalDate:'2026-09-22',approvedAt:null,
    source:'User explicitly approved renewed exception in current BNMS Alpha readiness task',
    disposition:'keep_collections_held_manual_follow_up_no_financial_mutation',
    previousDigest:'66b6c69bb31a3ba61cd0c040fe2c75c0d166da8b1566d9f0973f3e3d06a8a97a',
    digest:'ca9971af3b504171078ad1cd8910f323242d7179e73f878063b66387a2a035a7',
    observedChange:{creditNoteNumber:'200008893C',creditAmount:60,currency:'GBP',amountDue:207.27},
    evidence:'exports/private-bnms-alpha-attestation-20260922/readiness-only-resume-0935.json; exports/private-bnms-alpha-readiness/checkpoint.json',
  }]);
  a.payments.length=0;assert.equal(alphaManualApproval().payments.length,5);
  assert.throws(()=>assertAlphaManualEvidence([]),/changed or missing/);
});

test('independent read-only warmup cannot authorize apply, replay, schema or fake proof',()=>{
  const args=['--readiness-only','--manifest','manifest.json','--handover','handover.json','--out','exports/test.json'];
  assert.equal(parseAlphaReleaseArgs(args)['readiness-only'],true);
  for(const extra of [['--apply'],['--schema'],['--replay','report.json'],['--proof','proof.json'],
    ['--attestation','attestation.json'],[`--review-sha256=${'a'.repeat(64)}`]])
    assert.throws(()=>parseAlphaReleaseArgs([...args,...extra]));
  assert.throws(()=>parseAlphaReleaseArgs(args.filter(a=>a!=='--readiness-only')));
});

// Authentic saved evidence only; private exports are intentionally not copied
// into source control. CI still executes the independent scope/CLI tests above.
let report,entries;
try{
  report=JSON.parse(await readFile('exports/private-bnms-alpha-attestation-20260921/readiness-dryrun-renewed.json','utf8')).report;
  entries=JSON.parse(await readFile('exports/private-bnms-alpha-readiness/checkpoint.json','utf8')).state.entries;
}catch(error){if(error.code!=='ENOENT')throw error;}
test('authentic exception evidence: exact positives and owner/amount/status/new resource negatives',{skip:!report},async()=>{
  const allInvoices=Object.values(entries).flatMap(e=>e.body.Invoices||[]);
  const accounts=Object.values(entries).flatMap(e=>e.body.Accounts||[]);
  const a=alphaManualApproval(),members=structuredClone(report.members);
  for(const m of members)m.exceptionInvoices=allInvoices.filter(i=>[...a.invoices,...a.events].some(p=>p.memberId===m.memberId&&p.id===i.InvoiceID));
  assert.doesNotThrow(()=>assertAlphaManualEvidence(members));
  assert.equal(report.manifest.members.reduce((n,m)=>n+m.history.length,0),2137);
  for(const m of members){
    const stored=report.manifest.members.find(s=>s.identity.memberId===m.memberId).history;
    assert.equal(alphaPaymentHistoryRequiresReconciliation(m,m.provider.payments,stored),false);
    const raw=m.provider.payments[0];
    for(const delta of [{id:'NEW_FAILED',status:'failed'},{id:'NEW_PENDING',status:'pending_submission'},
      {id:'NEW_SUBMITTED',status:'submitted'},{id:'NEW_CONFIRMED',status:'confirmed'},
      {id:'NEW_FUTURE',charge_date:'2026-10-01'}])
      assert.equal(alphaPaymentHistoryRequiresReconciliation(m,[...m.provider.payments,{...raw,...delta}],stored),true);
    const paid=m.provider.payments.find(p=>stored.some(h=>h.provider_payment_id===p.id));
    for(const delta of [{amount:paid.amount+1},{amount_refunded:1},{currency:'EUR'},{status:'failed'}])
      assert.equal(alphaPaymentHistoryRequiresReconciliation(m,m.provider.payments.map(p=>p.id===paid.id?{...p,...delta}:p),stored),true);
  }
  for(const p of a.payments){
    const m=members.find(m=>m.memberId===p.memberId),raw=m.provider.payments.find(r=>r.id===p.id);
    assert.equal(approvedAlphaFailedPayment(m,raw),true);
    for(const delta of [{amount:raw.amount+1},{status:'pending_submission'},{status:'submitted'},
      {status:'confirmed'},{status:'paid_out'},{id:'NEW_FAILED'},{charge_date:'2026-10-01'},
      {links:{...raw.links,mandate:'OTHER'}}])
      assert.equal(approvedAlphaFailedPayment(m,{...raw,...delta}),false);
    for(const key of ['memberId','customerId','mandateId'])
      assert.equal(approvedAlphaFailedPayment({...m,[key]:'OTHER'},raw),false);
  }
  for(const p of a.invoices){
    const raw=allInvoices.find(i=>i.InvoiceID===p.id),owner={memberId:p.memberId,contactId:p.contactId};
    assert.equal(approvedAlphaUnpaidInvoice(owner,raw),true);
    for(const delta of [{AmountDue:13.05},{Total:13.05},{Status:'PAID'},{Status:'VOIDED'},
      {InvoiceID:'NEW_INVOICE'},{DateString:'2026-10-01T00:00:00'},{Contact:{ContactID:'OTHER'}}])
      assert.equal(approvedAlphaUnpaidInvoice(owner,{...raw,...delta}),false);
    assert.equal(approvedAlphaUnpaidInvoice({...owner,memberId:'OTHER'},raw),false);
  }
  for(const p of a.events){
    const raw=allInvoices.find(i=>i.InvoiceID===p.id),owner={memberId:p.memberId,contactId:p.contactId};
    assert.equal(unrelatedAlphaEventInvoice(owner,raw,accounts),true);
    for(const codes of [[],['200'],['210','200'],['210',undefined],['999']])
      assert.equal(unrelatedAlphaEventInvoice(owner,{...raw,LineItems:codes.map(AccountCode=>({AccountCode}))},accounts),false);
    assert.equal(unrelatedAlphaEventInvoice(owner,raw,[]),false);
    assert.equal(unrelatedAlphaEventInvoice(owner,{...raw,InvoiceID:'NEW_EVENT'},accounts),false);
    assert.equal(unrelatedAlphaEventInvoice({...owner,memberId:'OTHER'},raw,accounts),false);
  }
  const changed=structuredClone(members);
  changed.find(m=>m.memberId===a.payments[0].memberId).provider.payments.find(p=>p.id===a.payments[0].id).status='pending_submission';
  assert.throws(()=>assertAlphaManualEvidence(changed),/changed or missing/);
  const absent=structuredClone(members);
  absent.find(m=>m.memberId===a.invoices[0].memberId).exceptionInvoices=[];
  assert.throws(()=>assertAlphaManualEvidence(absent),/changed or missing/);
  // Unit-only construction of an otherwise-ready review; no authorization or
  // freshness is claimed for this stale saved report or this synthetic proof.
  const review={...structuredClone(report),members,accounts,globalBlockers:[],
    manualExceptionApproval:a,manualExceptionApprovalSha256:ALPHA_MANUAL_APPROVAL_SHA256};
  for(const m of review.members){
    m.blockers=[];
    const saved=review.manifest.members.find(s=>s.identity.memberId===m.memberId);
    const code=saved.structure.structure_match_value.includes('junior')?'201':'200';
    m.accounting.revenueCode=code;m.accounting.mapping=alphaAccountingMapping(code);
  }
  const proof={deploymentId:'unit-test-only',commit:'unit-test-only',
    sourceHashes:{'api/_lib/bnmsAlphaAccounting.js':'unit-test-only'}};
  const manifest=await alphaReleaseManifest(review,proof);
  assert.equal(manifest.manualExceptionApprovalSha256,ALPHA_MANUAL_APPROVAL_SHA256);
  assert.equal(hash(manifest.manualExceptionApproval),ALPHA_MANUAL_APPROVAL_SHA256);
  review.manualExceptionApproval.provenance.summary='changed approval';
  await assert.rejects(alphaReleaseManifest(review,proof),/approval differs/);
});