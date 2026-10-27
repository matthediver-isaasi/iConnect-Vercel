import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
import {amendmentFixture,uuid} from '../../scripts/test-support/member-amendment-fixtures.mjs';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
import {planMemberReplacementFinance} from './memberReplacementFinancialPlan.js';
import {buildMemberReplacementHistory} from './memberReplacementHistory.js';
import {MEMBERSHIP_CHANGE_POLICY_DEFAULTS} from './membershipChangePolicy.js';

test('replacement accounting journal claims once, recovers observations and isolates tenants',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('replacement-journal-'),clients=[];let started=false;
 const command=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  command('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  command('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',
   `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<3;i++){
   const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
   await c.connect();clients.push(c);
  }
  const [admin,a,b]=clients;
  const fixture=readFileSync(new URL('./memberAmendments.postgres.test.mjs',import.meta.url),'utf8');
  await admin.query(fixture.match(/await admin\.query\(`([\s\S]*?)`\);/)[1]);
  await admin.query('CREATE TABLE membership_change_policy(tenant_id uuid,policy jsonb,revision bigint)');
  await admin.query(`CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid);
   ALTER TABLE member ADD COLUMN organization_id uuid,ADD COLUMN role_id uuid;
   ALTER TABLE organization ADD COLUMN voucher_allowed_role_ids jsonb;
   ALTER TABLE member_membership_history ADD COLUMN membership_year text,ADD COLUMN stripe_payment_intent_id text;
   CREATE TABLE organisation_membership_history(LIKE member_membership_history INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
   ALTER TABLE organisation_membership_history ADD COLUMN organization_id uuid;
   CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid,member_id uuid,organization_id uuid,agreement_type text DEFAULT 'member',
    provider text,metadata jsonb,status text DEFAULT 'active',created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now());`);
  const voucherFixture=readFileSync(new URL('./membershipVoucherSettlement.postgres.test.mjs',import.meta.url),'utf8');
  for(const table of ['voucher','voucher_transaction']){
   await admin.query(voucherFixture.match(new RegExp(`CREATE TABLE ${table}\\([\\s\\S]*?;`))[0]);
  }
  for(const file of ['202610200001_individual_voucher_credit.sql','202610200014_voucher_allocation_refunds.sql',
   '20260919_form_membership_payment_quote.sql','20260920_rolling_membership_commitments.sql',
   '202612310020_member_membership_amendments.sql',
   '202612310021_member_amendment_settlement.sql','202612310023_member_change_authority.sql',
   '202612310024_member_change_execution.sql','202612310027_member_credit_backing_claim.sql',
   '202612310029_member_credit_issuance.sql','202612310030_member_credit_redemption_evidence.sql',
   '202612310031_member_credit_return_verification.sql','202612310032_member_credit_funding_claims.sql',
   '202612310033_member_credit_variable_reservation_scope.sql','202612310034_member_credit_unused_release.sql',
   '202612310035_member_credit_provenance.sql','202612310036_member_credit_incomplete_funding_returns.sql',
   '202612310037_member_credit_funding_retries.sql','202612310042_member_replacement_journal.sql',
   '202612310043_member_replacement_application.sql','202612310044_member_replacement_credit.sql',
   '202612310045_member_replacement_collection_holds.sql','202612310046_member_replacement_recovery.sql',
   '202612310047_member_cancellation_journal.sql','202612310048_member_cancellation_access.sql',
   '202612310049_member_cancellation_admission.sql','202612310050_member_cancellation_recovery.sql',
   '202612310051_member_cancellation_finance.sql']){
   await admin.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  }
  const today=new Date().toISOString().slice(0,10),f=amendmentFixture(today);
  await admin.query('INSERT INTO tenant VALUES($1)',[f.tenantId]);
  await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)',[f.memberId,f.tenantId]);
  await admin.query("INSERT INTO system_settings(id,tenant_id,setting_key,setting_value) VALUES(gen_random_uuid(),$1,'individual_vouchers_enabled','true')",[f.tenantId]);
  const insert=async(table,row)=>{
   const keys=Object.keys(row);
   return (await admin.query(`INSERT INTO ${table}(${keys.join(',')})
    VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING to_jsonb(${table}) v`,Object.values(row))).rows[0].v;
  };
  await admin.query('ALTER TABLE membership_tier_config ADD COLUMN nominal_code text');
  await admin.query(`ALTER TABLE member_membership_history ADD COLUMN accounting_provider text,
   ADD COLUMN accounting_invoice_id text, ADD COLUMN accounting_invoice_number text`);
  f.config=await insert('membership_tier_config',{...f.config,nominal_code:'401',flat_vat_rate:'NONE'});
  await insert('membership_tier_config',f.current.commitment_snapshot.config);
  await insert('membership_payment_quote',{id:uuid(15),tenant_id:f.tenantId,member_id:f.memberId,
   term_key:f.current.term_key,stripe_payment_intent_id:'pi_original',
   quote:{simResult:{commitment:f.current,config:f.current.commitment_snapshot.config}}});
  f.current.stripe_payment_intent_id='pi_original';
  f.current=await insert('member_membership_history',f.current);
  const amount={netMinor:10000,vatMinor:0,grossMinor:10000};
  const fundingEvidence={sourceRecordId:f.current.id,currency:'GBP',asOfDate:today,complete:true,
   pendingCollections:[],failedCollections:[],outstandingDue:{netMinor:0,vatMinor:0,grossMinor:0},
   providerEvidence:{sourceInvoiceId:'old',contactId:'payer',providerTenantId:'books'},
   settledFunding:[{id:'cash',sourceRecordId:f.current.id,currency:'GBP',state:'settled',
    ownerType:'member',ownerId:f.memberId,kind:'cash',...amount}]};
  const anniversary=new Date(`${today}T00:00:00Z`);anniversary.setUTCFullYear(anniversary.getUTCFullYear()+1);
  const calculation=calculateAmendmentTerms({
   sourceRecordId:f.current.id,memberId:f.memberId,currency:'GBP',frequency:'upfront',
   sourcePrice:amount,term:{startDate:f.current.term_start_date,renewalDate:f.current.membership_renewal_date},
   effectiveDate:today,evidence:fundingEvidence,behaviour:'new_term',
   targetPrice:{netMinor:20000,vatMinor:0,grossMinor:20000},
   targetTerm:{startDate:today,renewalDate:anniversary.toISOString().slice(0,10)},
  });
  const authority={version:1,action:'change',tenantId:f.tenantId,memberId:f.memberId,
   sourceSnapshot:f.current,targetSnapshot:{...f.config,nominal_code:'401',flat_vat_rate:'NONE'},
   calculation,fundingEvidence,settlement:{surplusHandling:'approval'}};
  const plan=planMemberReplacementFinance({authority,executionId:uuid(11),choice:'collect',
   original:{provider:'xero',sourceInvoiceId:'old',contactId:'payer',xeroTenantId:'books',
    originalPaidMinor:10000,originalPaymentIds:['cash'],accountCode:'400',taxCode:'NONE'}});
  const saved=await insert('member_change_authority',{id:uuid(10),tenant_id:f.tenantId,
   member_id:f.memberId,source_record_id:f.current.id,actor_id:uuid(9),actor_kind:'admin',
   request_key:'replacement-test',authority});
  for(const c of [a,b])await c.query('SET ROLE service_role');
  const args=[f.tenantId,f.memberId,saved.id,uuid(9),'Approved replacement',plan];
  const futureRenewal=new Date(`${f.current.membership_renewal_date}T00:00:00Z`);
  futureRenewal.setUTCFullYear(futureRenewal.getUTCFullYear()+1);
  const futureCommitment={...f.current,term_key:`rolling:${f.current.membership_renewal_date}`,
   term_start_date:f.current.membership_renewal_date,membership_renewal_date:futureRenewal.toISOString().slice(0,10),
   term_end_date:new Date(futureRenewal.getTime()-86400000).toISOString().slice(0,10)};
  const futureQuote={id:uuid(61),tenant_id:f.tenantId,member_id:f.memberId,term_key:futureCommitment.term_key,
   quote:{simResult:{commitment:futureCommitment,config:f.current.commitment_snapshot.config}}};
  await insert('membership_payment_quote',futureQuote);
  await assert.rejects(a.query('SELECT begin_member_replacement($1,$2,$3,$4,$5,$6)',args),/overlaps the replacement/);
  assert.equal((await admin.query('SELECT count(*) FROM member_replacement_execution')).rows[0].count,'0');
  await admin.query('DELETE FROM membership_payment_quote WHERE id=$1',[futureQuote.id]);
  const executions=await Promise.all([a,b].map(c=>c.query('SELECT begin_member_replacement($1,$2,$3,$4,$5,$6) v',args)));
  assert.equal(executions[0].rows[0].v.id,executions[1].rows[0].v.id);
  await assert.rejects(insert('membership_payment_quote',futureQuote),/awaiting financial completion/);
  await assert.rejects(insert('membership_billing_agreements',{id:uuid(62),tenant_id:f.tenantId,member_id:f.memberId,
   term_start_date:futureCommitment.term_start_date,membership_renewal_date:futureCommitment.membership_renewal_date}),/awaiting financial completion/);
  await assert.rejects(insert('member_membership_history',{...futureCommitment,id:uuid(63),
   stripe_payment_intent_id:null,membership_payment_quote_id:null}),/awaiting financial completion/);
  const claimArgs=[f.tenantId,plan.executionId,'new_invoice',uuid(9),'Approved accounting step'];
  const claims=await Promise.all([a,b].map(c=>c.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',claimArgs)));
  assert.equal(claims.filter(r=>r.rows[0].v.claimed).length,1);
  assert.equal((await a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',claimArgs)).rows[0].v.claimed,false);
  await assert.rejects(a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5)',
   [uuid(99),...claimArgs.slice(1)]),/Execution not found/);
  await assert.rejects(a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5)',
   [f.tenantId,plan.executionId,'transfer_note',uuid(9),'Approve']),/Earlier accounting/);
  const observedArgs=[f.tenantId,plan.executionId,'new_invoice',uuid(9),{state:'observed',id:'invoice'}];
  await a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',observedArgs);
  await a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',observedArgs);
  await assert.rejects(a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',
   [...observedArgs.slice(0,4),{state:'observed',id:'other'}]),/identity changed/);
  const transferArgs=[f.tenantId,plan.executionId,'transfer_note',uuid(9),'Approve'];
  const transferClaim=(await a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',transferArgs)).rows[0].v;
  assert.equal(transferClaim.claimed,true);
  const failedArgs=[f.tenantId,plan.executionId,'transfer_note',uuid(9),transferClaim.step.claim_token,'throttled',60];
  await a.query('SELECT fail_member_replacement_step($1,$2,$3,$4,$5,$6,$7)',failedArgs);
  assert.equal((await a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',transferArgs)).rows[0].v.claimed,false);
  await admin.query("UPDATE member_replacement_step SET retry_at=now()-interval '1 second' WHERE step_key='transfer_note'");
  const retries=await Promise.all([a,b].map(c=>c.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',transferArgs)));
  const nextClaim=retries.find(r=>r.rows[0].v.claimed).rows[0].v;
  assert.equal(retries.filter(r=>r.rows[0].v.claimed).length,1);
  await assert.rejects(a.query('SELECT fail_member_replacement_step($1,$2,$3,$4,$5,$6,$7)',failedArgs),/Stale financial claim/);
  await a.query('SELECT fail_member_replacement_step($1,$2,$3,$4,$5,$6,$7)',
   [...failedArgs.slice(0,4),nextClaim.step.claim_token,'uncertain',null]);
  assert.equal((await a.query('SELECT claim_member_replacement_step($1,$2,$3,$4,$5) v',transferArgs)).rows[0].v.claimed,false);
  await assert.rejects(a.query("UPDATE member_replacement_step SET state='pending'"),{code:'42501'});
  await a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',
   [f.tenantId,plan.executionId,'transfer_note',uuid(9),{state:'observed',id:'transfer'}]);
  await a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',
   [f.tenantId,plan.executionId,'transfer_allocation',uuid(9),{state:'observed',id:'allocation'}]);
  const settlement={state:'settled',evidence:{provider:'xero',providerTenantId:'books',currency:'GBP',
   kind:'replacement_settled',verified:true,invoiceId:'invoice',amount:plan.targetFullPrice,
   transferred:plan.transferred,transferCreditNoteId:'transfer',transferAllocationId:'allocation',
   cashPayments:[{paymentId:'cash',amountMinor:plan.additionalPaymentMinor}],paymentIds:['cash']}};
  const execution=executions[0].rows[0].v;
  const history=buildMemberReplacementHistory({execution,authority,settlement});
  const applyArgs=[f.tenantId,execution.id,uuid(9),settlement.evidence,history];
  await admin.query(`CREATE FUNCTION reject_new_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'injected purchase failure'; END $$;
   CREATE TRIGGER reject_new_purchase BEFORE INSERT ON member_membership_history
    FOR EACH ROW EXECUTE FUNCTION reject_new_purchase()`);
  await assert.rejects(a.query('SELECT apply_member_replacement($1,$2,$3,$4,$5)',applyArgs),/injected purchase failure/);
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[f.current.id])).rows[0].status,'active');
  assert.equal((await admin.query('SELECT count(*) FROM member_replacement_application')).rows[0].count,'0');
  await admin.query('DROP TRIGGER reject_new_purchase ON member_membership_history');
  const applications=await Promise.all([a,b].map(c=>c.query('SELECT apply_member_replacement($1,$2,$3,$4,$5) v',applyArgs)));
  assert.equal(applications[0].rows[0].v.target_record_id,applications[1].rows[0].v.target_record_id);
  assert.equal((await admin.query('SELECT count(*) FROM member_replacement_application')).rows[0].count,'1');
  const old=(await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h WHERE id=$1',[f.current.id])).rows[0].v;
  assert.deepEqual({...old,status:'active'},f.current,'original financial commitment and dates remain intact');
  assert.equal(old.status,'replaced');
  await assert.rejects(admin.query("UPDATE member_membership_history SET status='active' WHERE id=$1",[f.current.id]),/cannot be reactivated/);
  const fresh=(await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h WHERE id=$1',[history.id])).rows[0].v;
  assert.equal(fresh.total_with_vat,plan.targetFullPrice.grossMinor/100);
  assert.equal(fresh.accounting_invoice_id,'invoice');
  const afterRenewal=new Date(`${fresh.membership_renewal_date}T00:00:00Z`);
  afterRenewal.setUTCFullYear(afterRenewal.getUTCFullYear()+1);
  const afterCommitment={...fresh,term_key:`rolling:${fresh.membership_renewal_date}`,
   term_start_date:fresh.membership_renewal_date,membership_renewal_date:afterRenewal.toISOString().slice(0,10),
   term_end_date:new Date(afterRenewal.getTime()-86400000).toISOString().slice(0,10)};
  const afterQuote=await insert('membership_payment_quote',{id:uuid(64),tenant_id:f.tenantId,member_id:f.memberId,
   term_key:afterCommitment.term_key,quote:{simResult:{commitment:afterCommitment,config:fresh.commitment_snapshot.config}}});
  assert.equal(afterQuote.id,uuid(64),'successful application releases the financial hold for subsequent terms');
  // A second member exercises atomic credit issuance through the same real
  // rolling constraints, then the existing redemption/expiry authority.
  const creditMember=uuid(42);
  await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)',[creditMember,f.tenantId]);
  const cheap=await insert('membership_tier_config',{...f.config,id:uuid(40),name:'Replacement',flat_cost:0.01});
  const rawSource=amendmentFixture(today).current;
  rawSource.id=uuid(41);rawSource.member_id=creditMember;rawSource.payment_method='invoice';
  rawSource.commitment_snapshot.payment_method='invoice';
  const creditSource=await insert('member_membership_history',rawSource);
  const creditFunding={...fundingEvidence,sourceRecordId:creditSource.id,
   settledFunding:[{...fundingEvidence.settledFunding[0],sourceRecordId:creditSource.id,ownerId:creditMember}]};
  const creditCalculation=calculateAmendmentTerms({
   sourceRecordId:creditSource.id,memberId:creditMember,currency:'GBP',frequency:'upfront',sourcePrice:amount,
   term:{startDate:creditSource.term_start_date,renewalDate:creditSource.membership_renewal_date},
   effectiveDate:today,evidence:creditFunding,behaviour:'new_term',targetPrice:{netMinor:1,vatMinor:0,grossMinor:1},
   targetTerm:{startDate:today,renewalDate:anniversary.toISOString().slice(0,10)},
  });
  const binding={provider:'xero',kind:'iconnect_member_credit_liability',providerTenantId:'books',
   accountId:'liability',accountCode:'850',currency:'GBP'};
  const creditAuthority={...authority,memberId:creditMember,sourceSnapshot:creditSource,targetSnapshot:cheap,
   calculation:creditCalculation,fundingEvidence:creditFunding,creditLiabilityBinding:binding};
  const creditPlan=planMemberReplacementFinance({authority:creditAuthority,executionId:uuid(43),choice:'credit',
   original:{provider:'xero',sourceInvoiceId:'old',contactId:'payer',xeroTenantId:'books',
    originalPaidMinor:10000,originalPaymentIds:['cash'],accountCode:'400',taxCode:'NONE'}});
  const creditSaved=await insert('member_change_authority',{id:uuid(44),tenant_id:f.tenantId,
   member_id:creditMember,source_record_id:creditSource.id,actor_id:uuid(9),actor_kind:'admin',
   request_key:'credit-replacement',authority:creditAuthority});
  const creditExecution=(await a.query('SELECT begin_member_replacement($1,$2,$3,$4,$5,$6) v',
   [f.tenantId,creditMember,creditSaved.id,uuid(9),'Approve backed credit',creditPlan])).rows[0].v;
  for(const step of creditPlan.steps){
   await a.query('SELECT observe_member_replacement_step($1,$2,$3,$4,$5)',
    [f.tenantId,creditExecution.id,step.key,uuid(9),{state:'observed',id:`credit-${step.key}`}]);
  }
  const creditSettlement={state:'settled',evidence:{...settlement.evidence,
   invoiceId:'credit-new_invoice',amount:creditPlan.targetFullPrice,transferred:creditPlan.transferred,
   transferCreditNoteId:'credit-transfer_note',transferAllocationId:'credit-transfer_allocation',
   cashPayments:[],paymentIds:[],surplusEvidence:{kind:'member_credit_backed',verified:true,
    documentId:'credit-surplus_note',paymentId:'credit-credit_backing',liabilityAccountId:'liability',retainedCreditMinor:0}}};
  const creditHistory=buildMemberReplacementHistory({execution:creditExecution,authority:creditAuthority,settlement:creditSettlement});
  const creditArgs=[f.tenantId,creditExecution.id,uuid(9),creditSettlement.evidence,creditHistory];
  await admin.query(`CREATE FUNCTION reject_credit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'injected credit failure'; END $$;
   CREATE TRIGGER reject_credit_fixture BEFORE INSERT ON voucher FOR EACH ROW EXECUTE FUNCTION reject_credit_fixture()`);
  await assert.rejects(a.query('SELECT apply_member_replacement($1,$2,$3,$4,$5)',creditArgs),/injected credit failure/);
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[creditSource.id])).rows[0].status,'active');
  assert.equal((await admin.query('SELECT count(*) FROM member_replacement_application WHERE execution_id=$1',[creditExecution.id])).rows[0].count,'0');
  assert.equal((await admin.query("SELECT count(*) FROM member_replacement_job WHERE execution_id=$1 AND kind='confirmation'",[creditExecution.id])).rows[0].count,'0');
  await admin.query('DROP TRIGGER reject_credit_fixture ON voucher');
  await Promise.all([a,b].map(c=>c.query('SELECT apply_member_replacement($1,$2,$3,$4,$5)',creditArgs)));
  const credit=(await admin.query('SELECT * FROM member_membership_credit WHERE amendment_id=$1',[creditExecution.id])).rows[0];
  assert.equal(Number(credit.amount_minor),creditPlan.surplus.grossMinor);
  const wallet=(await admin.query('SELECT * FROM voucher WHERE id=$1',[credit.voucher_id])).rows[0];
  assert.equal(wallet.member_id,creditMember);assert.equal(wallet.expires_at,null);
  assert.equal((await admin.query('SELECT count(*) FROM member_membership_credit')).rows[0].count,'1');
  const purchase=await insert('voucher_credit_purchase',{tenant_id:f.tenantId,purchase_key:'membership:replacement-proof',
   request:{},state:'committed',payable_minor:1,currency:'GBP',member_id:creditMember});
  await insert('voucher_credit_allocation',{id:uuid(47),purchase_id:purchase.id,tenant_id:f.tenantId,
   voucher_id:wallet.id,owner_member_id:creditMember,owner_display_name:'Member',amount_minor:1,ordinal:0});
  const proofs=(await a.query('SELECT member_credit_funding_proofs($1,$2) v',[f.tenantId,[uuid(47)]])).rows;
  assert.equal(proofs.length,1);
  assert.equal(proofs[0].v.amendment.execution_kind,'replacement');
  assert.equal(proofs[0].v.amendment.member_id,creditMember);
  assert.deepEqual(proofs[0].v.amendment.quote.sourceSnapshot,creditSource);
  assert.equal(proofs[0].v.settlement.context.memberCreditLiabilityBinding.accountId,'liability');
  assert.equal(proofs[0].v.settlement.evidence.paymentId,'credit-credit_backing');
  assert.equal((await admin.query("SELECT count(*) FROM member_replacement_job WHERE execution_id=$1 AND kind='confirmation'",[creditExecution.id])).rows[0].count,'1');
  const notifyClaims=await Promise.all([a,b].map(c=>c.query("SELECT claim_member_replacement_job($1,$2,'confirmation') v",[f.tenantId,creditExecution.id])));
  const notifyClaim=notifyClaims.map(r=>r.rows[0].v).filter(Boolean);
  assert.equal(notifyClaim.length,1);
  await assert.rejects(a.query("SELECT finish_member_replacement_job($1,$2,'confirmation',$3,'pending','{}',300)",
   [f.tenantId,creditExecution.id,notifyClaim[0].claim_token]),/definitive non-submission/);
  await admin.query("UPDATE member_replacement_job SET lease_until=now()-interval '1 second' WHERE execution_id=$1 AND kind='confirmation'",[creditExecution.id]);
  await a.query("SELECT pending_member_replacement_jobs('all',100)");
  assert.equal((await admin.query("SELECT state FROM member_replacement_job WHERE execution_id=$1 AND kind='confirmation'",[creditExecution.id])).rows[0].state,'uncertain');
  assert.equal((await a.query("SELECT claim_member_replacement_job($1,$2,'confirmation') v",[f.tenantId,creditExecution.id])).rows[0].v,null);
  assert.equal((await a.query('SELECT member_credit_funding_proofs($1,$2)',[uuid(99),[uuid(47)]])).rows.length,0);
  // Cancellation changes access independently of uncollected service debt.
  // Exercise the real rolling constraints, not a simplified history table.
  const cancelMember=uuid(72),cancelId=uuid(74);
  await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)',[cancelMember,f.tenantId]);
  const cancelInput=amendmentFixture(today).current;
  Object.assign(cancelInput,{id:uuid(73),member_id:cancelMember,payment_method:'invoice'});
  cancelInput.commitment_snapshot.payment_method='invoice';
  const cancelSource=await insert('member_membership_history',cancelInput);
  await assert.rejects(admin.query('UPDATE member SET membership_cancelled=true WHERE id=$1',[cancelMember]),/protected lifecycle/);
  await insert('member_cancellation_request',{
   id:cancelId,tenant_id:f.tenantId,member_id:cancelMember,source_record_id:cancelSource.id,
   actor_id:uuid(9),request_key:'cancel-access-test',reason:'Approved immediate cancellation',
   effective_date:today,timing:'immediate',source_snapshot:cancelSource,
   calculation:{action:'cancel',sourceRecordId:cancelSource.id,membershipEndExclusiveDate:today,
    accessWaitsForSettlement:false,paymentReactivatesMembership:false,cancellationChargeBasis:'service_used',
    paymentDueMinor:1000,settlementStatus:'not_started'},
  });
  const accessArgs=[f.tenantId,cancelMember,cancelId,uuid(9)];
  await admin.query(`CREATE FUNCTION reject_cancel_access_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'injected access failure'; END $$;
   CREATE TRIGGER reject_cancel_access_fixture BEFORE UPDATE OF membership_cancelled ON member
   FOR EACH ROW WHEN(NEW.membership_cancelled) EXECUTE FUNCTION reject_cancel_access_fixture()`);
  await assert.rejects(a.query('SELECT apply_member_cancellation_access($1,$2,$3,$4)',accessArgs),/injected access failure/);
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[cancelSource.id])).rows[0].status,'active');
  assert.equal((await admin.query('SELECT access_ended_at FROM member_cancellation_request WHERE id=$1',[cancelId])).rows[0].access_ended_at,null);
  await admin.query('DROP TRIGGER reject_cancel_access_fixture ON member');
  const ended=await Promise.all([a,b].map(c=>c.query('SELECT apply_member_cancellation_access($1,$2,$3,$4) v',accessArgs)));
  assert.equal(ended[0].rows[0].v.access_ended_at,ended[1].rows[0].v.access_ended_at);
  assert.equal(ended[0].rows[0].v.calculation.paymentDueMinor,1000);
  assert.equal((await admin.query('SELECT membership_cancelled FROM member WHERE id=$1',[cancelMember])).rows[0].membership_cancelled,true);
  assert.equal((await admin.query("SELECT count(*) FROM member_cancellation_event WHERE request_id=$1 AND kind='access_ended'",[cancelId])).rows[0].count,'1');
  await assert.rejects(admin.query('UPDATE member SET membership_cancelled=false WHERE id=$1',[cancelMember]),/protected lifecycle/);
  await assert.rejects(admin.query("UPDATE member_membership_history SET status='active',payment_status='paid' WHERE id=$1",[cancelSource.id]),/cannot reactivate/);
  const preserved=(await admin.query('SELECT to_jsonb(h) v FROM member_membership_history h WHERE id=$1',[cancelSource.id])).rows[0].v;
  assert.deepEqual(preserved,{...cancelSource,status:'cancelled_by_request'});
  const rejoined=await insert('member_membership_history',{...creditHistory,id:uuid(75),member_id:cancelMember});
  assert.equal((await admin.query('SELECT membership_cancelled FROM member WHERE id=$1',[cancelMember])).rows[0].membership_cancelled,false);
  const cleared=(await admin.query('SELECT cleared_by_history_id,calculation FROM member_cancellation_request WHERE id=$1',[cancelId])).rows[0];
  assert.equal(cleared.cleared_by_history_id,rejoined.id);
  assert.equal(cleared.calculation.paymentDueMinor,1000);
  const cancelPolicy={...MEMBERSHIP_CHANGE_POLICY_DEFAULTS,cancellationTiming:'immediate'};
  await admin.query('INSERT INTO membership_change_policy(tenant_id,policy,revision) VALUES($1,$2,1)',[f.tenantId,cancelPolicy]);
  const admittedAuthority={tenantId:f.tenantId,memberId:cancelMember,actorId:uuid(9),
   reason:'Cancel the distinct new purchase',timing:'immediate',effectiveDate:today,sourceSnapshot:rejoined,
   policySnapshot:{policy:cancelPolicy,revision:1},providerPrepared:null,
   calculation:{action:'cancel',sourceRecordId:rejoined.id,membershipEndExclusiveDate:today,
    accessWaitsForSettlement:false,paymentReactivatesMembership:false,cancellationChargeBasis:'service_used',
    paymentDueMinor:null,settlementStatus:'requires_reconciliation'}};
  const admissionArgs=[f.tenantId,cancelMember,uuid(9),'new-cancel-request','a'.repeat(64),admittedAuthority];
  const admission=await Promise.all([a,b].map(c=>c.query('SELECT begin_member_cancellation($1,$2,$3,$4,$5,$6) v',admissionArgs)));
  assert.equal(admission[0].rows[0].v.id,admission[1].rows[0].v.id);
  assert.ok(admission[0].rows[0].v.access_ended_at);
  assert.equal(admission[0].rows[0].v.financial_state,'awaiting_reconciliation');
  assert.equal(admission[0].rows[0].v.calculation.paymentDueMinor,null);
  await assert.rejects(a.query('SELECT begin_member_cancellation($1,$2,$3,$4,$5,$6)',
   [...admissionArgs.slice(0,5),{...admittedAuthority,reason:'changed'}]),/different evidence/);
  const dueCancellationJobs=await Promise.all([a,b].map(c=>c.query('SELECT * FROM claim_member_cancellation_jobs(2)')));
  const cancellationClaims=dueCancellationJobs.flatMap(result=>result.rows);
  assert.equal(cancellationClaims.length,4);
  assert.equal(new Set(cancellationClaims.map(row=>row.id)).size,4);
  const notificationClaim=cancellationClaims.find(row=>row.kind.startsWith('notify_'));
  assert.ok(notificationClaim);
  await assert.rejects(a.query('SELECT finish_member_cancellation_job($1,$2,$3)',
   [notificationClaim.id,notificationClaim.claim_token,'pending']),/cannot be retried/);
  assert.equal((await a.query('SELECT finish_member_cancellation_job($1,$2,$3) v',
   [notificationClaim.id,uuid(79),'done'])).rows[0].v,false);
  await admin.query("UPDATE member_cancellation_job SET claimed_at=now()-interval '10 minutes' WHERE id=$1",[notificationClaim.id]);
  await a.query('SELECT * FROM claim_member_cancellation_jobs(1)');
  assert.equal((await admin.query('SELECT state FROM member_cancellation_job WHERE id=$1',[notificationClaim.id])).rows[0].state,'uncertain');
  const accessBeforeFinancialSettlement=(await admin.query('SELECT membership_cancelled FROM member WHERE id=$1',[cancelMember])).rows[0].membership_cancelled;
  const cancellationPlan={requestId:cancelId,memberId:cancelMember,sourceRecordId:cancelSource.id,
   currency:cancelSource.currency,choice:'none',debtMinor:0,surplusMinor:0,steps:[{key:'original',kind:'original_invoice',
    providerTenantId:'xero-tenant',contactId:'payer',currency:cancelSource.currency}]};
  const cancellationCalc={sourceRecordId:cancelSource.id,action:'cancel',effectiveDate:today,
   membershipEndExclusiveDate:today,accessWaitsForSettlement:false,paymentReactivatesMembership:false,
   paymentDueMinor:0,surplusMinor:0};
  const cancellationEvidence={complete:true,sourceRecordId:cancelSource.id,currency:cancelSource.currency,
   providerTenantId:'xero-tenant',contactId:'payer'};
  await a.query('SELECT prepare_member_cancellation_finance($1,$2,$3,$4,$5,$6,$7)',
   [f.tenantId,cancelMember,cancelId,uuid(9),cancellationPlan,cancellationCalc,cancellationEvidence]);
  const financeClaims=await Promise.all([a,b].map(c=>c.query('SELECT claim_member_cancellation_finance_step($1,$2,$3,$4,$5) v',
   [f.tenantId,cancelMember,cancelId,uuid(9),'original'])));
  assert.equal(financeClaims.filter(c=>c.rows[0].v.claimed).length,1);
  const financialClaim=financeClaims.find(c=>c.rows[0].v.claimed).rows[0].v.operation;
  const observeArgs=[f.tenantId,cancelMember,cancelId,uuid(9),'original',financialClaim.claim_token];
  await a.query('SELECT observe_member_cancellation_finance_step($1,$2,$3,$4,$5,$6,$7)',
   [...observeArgs,{state:'uncertain'}]);
  await assert.rejects(a.query('SELECT observe_member_cancellation_finance_step($1,$2,$3,$4,$5,$6,$7)',
   [...observeArgs,{state:'not_submitted',provenNotSubmitted:true}]),/not proof/);
  await a.query('SELECT observe_member_cancellation_finance_step($1,$2,$3,$4,$5,$6,$7)',
   [...observeArgs,{state:'observed',id:'verified-original'}]);
  await a.query('SELECT record_member_cancellation_balance($1,$2,$3,$4,$5,$6)',
   [f.tenantId,cancelMember,cancelId,uuid(9),'settled',{
    verified:true,requestId:cancelId,currency:cancelSource.currency,kind:'zero_balance'}]);
  assert.equal((await admin.query('SELECT membership_cancelled FROM member WHERE id=$1',[cancelMember])).rows[0].membership_cancelled,accessBeforeFinancialSettlement);
  assert.equal((await admin.query('SELECT status FROM member_membership_history WHERE id=$1',[cancelSource.id])).rows[0].status,'cancelled_by_request');
  await assert.rejects(a.query('DELETE FROM member_cancellation_finance WHERE request_id=$1',[cancelId]),/permission denied/);
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await admin.query('SELECT has_function_privilege($1,$2,$3) allowed',
    [role,'public.issue_member_replacement_credit(uuid,uuid,uuid,jsonb)','EXECUTE'])).rows[0].allowed,false);
  }
  for(const role of ['anon','authenticated']){
   for(const signature of ['begin_member_replacement(uuid,uuid,uuid,uuid,text,jsonb)',
    'claim_member_replacement_step(uuid,uuid,text,uuid,text)','observe_member_replacement_step(uuid,uuid,text,uuid,jsonb)',
    'fail_member_replacement_step(uuid,uuid,text,uuid,uuid,text,integer)',
    'apply_member_replacement(uuid,uuid,uuid,jsonb,jsonb)']){
    assert.equal((await admin.query('SELECT has_function_privilege($1,$2,$3) allowed',
     [role,`public.${signature}`,'EXECUTE'])).rows[0].allowed,false);
   }
  }
 }finally{
  for(const c of clients)await c.end();
  if(started)command('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
