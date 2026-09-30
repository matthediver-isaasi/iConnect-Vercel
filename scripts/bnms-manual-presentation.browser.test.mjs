import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {MANUAL_TENANT,MANUAL_WORKBOOK} from '../api/_lib/bnmsManualCohort.js';
import {directDebitMembershipPresentation} from '../api/_lib/directDebitMembershipPresentation.js';
import {migratedMandatePresentation} from '../api/_lib/migratedMandatePresentation.js';

test('isolated browser fixture: administrative Current plus active existing mandate, no paid history or network',async()=>{
 const history={id:'fixture-history',tenant_id:MANUAL_TENANT,member_id:'fixture-member',
  billing_agreement_id:'fixture-agreement',membership_source:'personal',term_key:'rolling:2026-10-01',
  term_start_date:'2026-10-01',term_end_date:'2027-09-30',membership_renewal_date:'2027-10-01',
  payment_method:'direct_debit',status:'pending_payment_setup',payment_status:'unpaid',
  membershipRecognition:{tenant_id:MANUAL_TENANT,member_id:'fixture-member',agreement_id:'fixture-agreement',
   history_id:'fixture-history',workbook_sha256:MANUAL_WORKBOOK,provenance:'bnms_manual_95',
   effective_from:'2026-09-24',effective_until:'2027-10-01',revoked_at:null}};
 const plan={id:'fixture-plan',provider:'gocardless',status:'first_payment_pending',
  billing_agreement_id:'fixture-agreement',migratedMandateStatus:'active',
  membership_billing_agreements:{metadata:{dd:{billing_request_mode:'migration_existing_mandate',activation_rule:'first_payment'}}}};
 const before=JSON.stringify({history,plan});
 const result=directDebitMembershipPresentation(plan,[history],{membership_paused:false},'2026-09-24',{source:'bnms_dd_manual_adoption'});
 const mandate=migratedMandatePresentation(plan);
 assert.equal(result.displayStatus,'current');assert.equal(mandate.mandateStatus,'active');
 const browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
 try{
  const context=await browser.newContext({viewport:{width:1000,height:640},serviceWorkers:'block'});
  let requests=0;
  await context.route('**/*',route=>{requests++;return route.abort();});
  const page=await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>
   body{font:16px system-ui;background:#f5f7fa;color:#182638;margin:45px}
   main{background:white;border:1px solid #dde3ec;border-radius:12px;padding:32px}
   h1{font-size:25px}.badge{display:inline-block;background:#daf2e7;color:#155d40;padding:8px 12px;border-radius:8px}
   dt{color:#57667a;margin-top:18px}dd{margin:5px 0}.note{margin-top:25px;padding:15px;background:#fff2cb}
   </style></head><body><main><h1>Manual-95 membership • isolated fixture</h1>
   <p>Synthetic test member — no live tenant data</p>
   <span class="badge" data-testid="membership">${result.displayStatus==='current'?'Current':'Not current'}</span>
   <span class="badge" data-testid="mandate">${mandate.mandateStatus==='active'?'Existing mandate active':'Inactive'}</span>
   <dl><dt>Administrative recognition</dt><dd>24 September 2026 – 30 September 2027</dd>
   <dt>Canonical history</dt><dd data-testid="history">${history.status} / ${history.payment_status}</dd>
   <dt>Collection term</dt><dd>October 2026 – September 2027</dd></dl>
   <div class="note">Release blocked: new manual-aware production runtime must be published and independently attested.
   Earliest submission is 1 October; this is not a guaranteed bank debit date.</div>
   </main></body></html>`);
  assert.equal(await page.getByTestId('membership').textContent(),'Current');
  assert.equal(await page.getByTestId('mandate').textContent(),'Existing mandate active');
  assert.equal(await page.getByTestId('history').textContent(),'pending_payment_setup / unpaid');
  assert.equal(requests,0);assert.equal(JSON.stringify({history,plan}),before);
  const path='exports/private-bnms-manual-phase2/presentation-fixture.png';
  await page.screenshot({path,fullPage:true});await chmod(path,0o600);
 }finally{await browser.close();}
});