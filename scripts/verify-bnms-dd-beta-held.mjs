#!/usr/bin/env node
// Read-only persisted verification. Handler auth is injected test context, NOT
// a deployed session, login test, or authorization grant.
import assert from 'node:assert/strict';
import {readFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {destinationConnection} from './run-bnms-dd-pilot-history.mjs';
import {destinationTarget} from './apply-custom-object-relationship-deleted-members-migration.mjs';
import {TENANT_ID,MEMBER_ID,MANDATE_ID,digest} from './bnms-dd-pilot.mjs';
import {betaManifest,SOURCE_HASH,START,END} from './bnms-dd-beta-adoption.mjs';
import {fingerprint} from './bnms-dd-pilot-history.mjs';
import {createHistoricalDdHandler} from '../api/membership/historical-dd.js';
export async function main(args=process.argv.slice(2)){
  if(args.length!==4||args[0]!=='--evidence'||args[2]!=='--out'||!resolve(args[3]).startsWith('/tmp/'))throw Error('Evidence and new private /tmp output required');
  destinationTarget(process.env);
  const bytes=await readFile(args[1]);assert.equal(digest(bytes),SOURCE_HASH,'Original candidate file drift');
  const manifest=betaManifest(JSON.parse(bytes)),hash=fingerprint(manifest);
  const c=await destinationConnection();await c.connect();
  const checks=[],projections=[];let pilot;
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows=async(sql,args=[])=>(await c.query(sql,args)).rows;
    const batches=await rows('SELECT * FROM bnms_dd_beta_batch WHERE evidence_sha256=$1',[hash]);
    assert.equal(batches.length,1);assert.equal(fingerprint(batches[0].evidence),hash);
    const adoptions=await rows(`SELECT a.*,to_jsonb(p) AS plan,to_jsonb(b) AS agreement,to_jsonb(h) AS history,to_jsonb(m) AS member
      FROM bnms_dd_beta_adoption a JOIN membership_payment_plans p ON p.id=a.plan_id
      JOIN membership_billing_agreements b ON b.id=a.agreement_id JOIN member_membership_history h ON h.id=a.history_id
      JOIN member m ON m.id=a.member_id WHERE a.batch_id=$1`,[batches[0].id]);
    assert.equal(adoptions.length,10);
    for(const expected of manifest.members){
      const a=adoptions.find(r=>r.member_id===expected.identity.memberId);assert.ok(a);
      const {plan:p,agreement:b,history:h,member}=a;
      assert.equal(fingerprint(a.evidence),fingerprint(expected));
      for(const r of [a,p,b,h,member])assert.equal(r.tenant_id,TENANT_ID);
      for(const r of [p,b,h])assert.equal(r.member_id,a.member_id);
      for(const r of [p,h])assert.equal(r.billing_agreement_id,b.id);
      assert.equal(p.status,'first_payment_pending');assert.equal(b.status,'first_payment_pending');
      assert.equal(h.status,'pending_payment_setup');assert.equal(h.payment_status,'unpaid');
      assert.ok(p.collection_stopped_at);assert.equal(p.metadata.bnms_release_required,true);
      assert.equal(p.metadata.bnms_beta_held,true);assert.equal(p.metadata.collection_mode,'dynamic');
      assert.equal(p.gocardless_subscription_id,null);
      assert.equal(p.start_date,START);assert.equal(p.dynamic_next_collection_date,START);
      assert.equal(p.day_of_month,1);assert.equal(p.amount_minor,expected.monthlyQuoteMinor);
      assert.equal(p.currency,'GBP');assert.equal(b.metadata.dd.monthly_amount_minor,p.amount_minor);
      assert.equal(b.metadata.dd.currency,p.currency);assert.equal(fingerprint(b.metadata.dd),fingerprint(expected.dd));
      assert.equal(b.metadata.dd.plan_total,null);assert.equal(b.metadata.dd.final_cost,null);assert.equal(b.metadata.dd.total_with_vat,null);
      assert.equal(h.term_start_date,START);assert.equal(h.term_end_date,END);
      assert.equal(h.final_cost,null);assert.equal(h.total_with_vat,null);
      assert.equal(b.term_start_date,h.term_start_date);assert.equal(b.term_end_date,h.term_end_date);
      const customers=await rows('SELECT * FROM gocardless_customers WHERE gocardless_customer_id=$1',[a.customer_id]);
      const mandates=await rows('SELECT * FROM gocardless_mandates WHERE gocardless_mandate_id=$1',[a.mandate_id]);
      assert.equal(customers.length,1);assert.equal(mandates.length,1);
      assert.equal(customers[0].tenant_id,TENANT_ID);assert.equal(customers[0].member_id,a.member_id);
      assert.equal(customers[0].environment,'live');assert.equal(customers[0].organization_id,null);
      assert.equal(mandates[0].tenant_id,TENANT_ID);assert.equal(mandates[0].environment,'live');
      assert.equal(mandates[0].status,'active');assert.equal(mandates[0].gocardless_customer_id,a.customer_id);
      assert.equal((await rows('SELECT id FROM gocardless_collection_reservations WHERE plan_id=$1 OR billing_agreement_id=$2',[p.id,b.id])).length,0);
      assert.equal((await rows('SELECT id FROM gocardless_payments WHERE gocardless_mandate_id=$1',[a.mandate_id])).length,0);
      const historical=await rows('SELECT * FROM bnms_dd_beta_provider_history WHERE adoption_id=$1 ORDER BY provider_payment_id',[a.id]);
      assert.equal(historical.length,expected.history.length);
      assert.equal(fingerprint(historical.map(r=>r.evidence)),fingerprint(expected.history.map(r=>r.evidence)));
      assert.ok(historical.every(r=>r.tenant_id===TENANT_ID&&r.member_id===a.member_id&&!r.accounting_reconciled&&r.provider_status==='paid_out'));
      checks.push({memberId:a.member_id,planId:p.id,historicalCount:historical.length,held:true,reservations:0,mutablePayments:0,canonicalParity:true});
      projections.push({member,expectedHistory:expected.history});
    }
    const original=await rows(`SELECT a.member_id,a.gocardless_mandate_id,a.status,p.status AS plan_status,p.collection_stopped_at,
      h.payment_status,h.term_start_date::text,h.term_end_date::text
      FROM membership_billing_agreements a JOIN membership_payment_plans p ON p.billing_agreement_id=a.id
      JOIN member_membership_history h ON h.billing_agreement_id=a.id WHERE a.member_id=$1 AND a.tenant_id=$2`,[MEMBER_ID,TENANT_ID]);
    const oldHistory=await rows('SELECT count(*)::integer AS n FROM bnms_dd_historical_payment WHERE member_id=$1 AND tenant_id=$2',[MEMBER_ID,TENANT_ID]);
    assert.equal(original.length,1);assert.equal(original[0].gocardless_mandate_id,MANDATE_ID);assert.equal(oldHistory[0].n,9);
    pilot={historicalCount:9,canonicalLinkedCount:1,observed:original[0],
      limitation:'Only known pilot identity and nine-row baseline checked; no complete pre-beta state hash available'};
    await c.query('ROLLBACK');
  }finally{await c.end();}
  assert.equal(checks.reduce((n,r)=>n+r.historicalCount,0),221);
  const db=createClient(process.env.DEST_SUPABASE_URL,process.env.DEST_SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const responses=[];
  for(const {member,expectedHistory} of projections){
    for(const actor of ['authorized_self_projection','authorized_tenant_admin_projection']){
      // Real DEST data with test-injected authorization collaborators only.
      // No cookie, token, auth table, or deployed session is created/modified.
      const handler=createHistoricalDdHandler({db,
        getSessionMember:async()=>actor==='authorized_self_projection'?member:null,
        getTenantContext:async()=>({isAuthenticated:true,tenantId:TENANT_ID,tenantUserId:actor==='authorized_tenant_admin_projection'?'test-context-only':null}),
        hasAdminAccess:async()=>actor==='authorized_tenant_admin_projection',
        hasFeatureAccess:async()=>true});
      let status=200,body;
      const res={setHeader(){},status(n){status=n;return this;},json(data){body=data;return this;}};
      await handler({method:'GET',query:{memberId:member.id}},res);
      assert.equal(status,200,`Projected handler status ${status}`);
      assert.equal(body.payments.length,expectedHistory.length);
      const expectedIds=expectedHistory.map(h=>h.provider_payment_id).sort();
      assert.deepEqual(body.payments.map(h=>h.provider_payment_id).sort(),expectedIds);
      assert.ok(body.payments.every(p=>p.provider_only&&p.accounting_reconciled===false&&p.period===null
        &&p.invoice_available===false&&p.xero_invoice_id===null&&p.provenance==='provider_evidence_only'));
      responses.push({memberId:member.id,actor,status,payments:body.payments});
    }
  }
  const report={mode:'persisted_beta_read_only_verification',observedAt:new Date().toISOString(),hash,
    writes:0,providerWrites:0,checks,pilot,handlerProjections:responses,
    authVerification:'NOT performed: authorization collaborators are injected test contexts. DEST service response verification only.',
    deployedVisualVerification:false,hasBrowserStorageState:!!process.env.PLAYWRIGHT_STORAGE_STATE};
  const out=await open(resolve(args[3]),'wx',0o600);
  try{await out.writeFile(JSON.stringify(report,null,2));}finally{await out.close();}
  console.log(JSON.stringify({mode:report.mode,members:checks.length,historicalRows:221,handlerProjections:responses.length,
    heldPlans:10,reservations:0,mutablePayments:0,originalPilotHistoricalRows:9,deployedVisualVerification:false,
    writes:0,out:resolve(args[3])}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(`Read-only beta verification failed: ${e.message}`);process.exitCode=1;});