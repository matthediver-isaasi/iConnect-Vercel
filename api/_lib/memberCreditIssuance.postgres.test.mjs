import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import {createLocalPostgresHarness} from '../../scripts/test-support/local-postgres-harness.mjs';
import {amendmentFixture,uuid} from '../../scripts/test-support/member-amendment-fixtures.mjs';
import {buildMemberAmendmentQuote} from './memberAmendmentQuote.js';
import {calculateAmendmentTerms} from './memberAmendmentCalculation.js';
test('backed credit issuance/application roll back together; expiry preserves value for audited review',{timeout:120000},async()=>{
 const h=await createLocalPostgresHarness('credit-issuance-'),clients=[];let started=false;
 const cmd=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 try{
  cmd('initdb',['-D',h.data,'-A','trust','-U','postgres']);
  cmd('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']);started=true;
  for(let i=0;i<2;i++){const c=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});await c.connect();clients.push(c);}
  const [admin,a]=clients;
  const base=readFileSync(new URL('./memberAmendments.postgres.test.mjs',import.meta.url),'utf8');
  await admin.query(base.match(/await admin\.query\(`([\s\S]*?)`\);/)[1]);
  await admin.query(`CREATE TABLE membership_change_policy(tenant_id uuid,policy jsonb,revision bigint);
   ALTER TABLE member ADD COLUMN organization_id uuid,ADD COLUMN role_id uuid;
   CREATE TABLE organization(id uuid PRIMARY KEY,tenant_id uuid,voucher_allowed_role_ids jsonb);`);
  const voucherFixture=readFileSync(new URL('./membershipVoucherSettlement.postgres.test.mjs',import.meta.url),'utf8');
  for(const table of ['voucher','voucher_transaction']){
   await admin.query(voucherFixture.match(new RegExp(`CREATE TABLE ${table}\\([\\s\\S]*?;`))[0]);
  }
  await admin.query(readFileSync('supabase/migrations/202610200001_individual_voucher_credit.sql','utf8'));
  await admin.query(`CREATE FUNCTION fail_credit_issue_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF current_setting('test.fail_issue',true)='yes' THEN RAISE EXCEPTION 'Injected issuance failure'; END IF;
   RETURN NEW; END $$;
   CREATE TRIGGER fixture_issue_failure BEFORE INSERT ON voucher FOR EACH ROW EXECUTE FUNCTION fail_credit_issue_fixture();`);
  for(const file of ['202612310020_member_membership_amendments.sql','202612310021_member_amendment_settlement.sql',
   '202612310023_member_change_authority.sql','202612310024_member_change_execution.sql',
   '202612310027_member_credit_backing_claim.sql','202612310029_member_credit_issuance.sql']){
   await admin.query(readFileSync(`supabase/migrations/${file}`,'utf8'));
  }
  assert.equal((await admin.query('SELECT member_credit_execution_available() ready')).rows[0].ready,false);
  // This disposable fixture deliberately opens the gate to exercise the
  // financial transaction; the shipped migration remains closed.
  await admin.query('CREATE OR REPLACE FUNCTION member_credit_execution_available() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$');
  const today=new Date().toISOString().slice(0,10),f=amendmentFixture(today);f.config.flat_cost=50;
  await admin.query('INSERT INTO tenant VALUES($1)',[f.tenantId]);
  await admin.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)',[f.memberId,f.tenantId]);
  await admin.query("INSERT INTO system_settings(id,tenant_id,setting_key,setting_value) VALUES(gen_random_uuid(),$1,'individual_vouchers_enabled','true'),(gen_random_uuid(),$1,'xero_voucher_clearing_account_code','850')",[f.tenantId]);
  const insert=async(table,row)=>{const keys=Object.keys(row);return (await admin.query(
   `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING to_jsonb(${table}) v`,
   Object.values(row))).rows[0].v;};
  f.config=await insert('membership_tier_config',f.config);
  const governing=await insert('membership_tier_config',f.current.commitment_snapshot.config);
  f.current=await insert('member_membership_history',f.current);
  const q=buildMemberAmendmentQuote({...f,effectiveDate:today});
  const funding={complete:true,sourceRecordId:f.current.id,currency:'GBP',asOfDate:today,
   settledFunding:[{id:'paid',sourceRecordId:f.current.id,currency:'GBP',state:'settled',ownerType:'member',
    ownerId:f.memberId,kind:'cash',...q.originalFullTerm}],pendingCollections:[],failedCollections:[],
   outstandingDue:{netMinor:0,vatMinor:0},providerEvidence:{provider:'xero',providerTenantId:'books'}};
  const calculation=calculateAmendmentTerms({sourceRecordId:f.current.id,memberId:f.memberId,currency:'GBP',
   frequency:'upfront',sourcePrice:q.originalFullTerm,term:q.term,effectiveDate:today,evidence:funding,
   behaviour:'retain_term',targetPrice:q.targetFullTerm});
  const binding={provider:'xero',kind:'iconnect_member_credit_liability',providerTenantId:'books',
   currency:'GBP',accountId:'liability',accountCode:'850'};
  const authority={version:1,tenantId:f.tenantId,memberId:f.memberId,action:'change',request:f.request,
   sourceSnapshot:f.current,targetSnapshot:f.config,governingSnapshot:governing,targetBandSnapshot:null,
   pricingSnapshot:q.targetSnapshot,policySnapshot:null,
   fundingEvidence:funding,calculation,creditLiabilityBinding:binding,
   settlement:{requiresApproval:true,surplusHandling:'credit',creditExpiryLiabilityTreatment:'manual_review'}};
  await a.query('SET ROLE service_role');
  const saved=(await a.query('SELECT confirm_member_change_authority($1,$2,$3,$4,$5,$6) v',
   [f.tenantId,f.memberId,uuid(7),'admin','credit-authority',authority])).rows[0].v;
  const execution=(await a.query('SELECT begin_member_change_execution($1,$2,$3,$4,$5,$6) v',
   [f.tenantId,f.memberId,saved.id,uuid(7),'credit','Approved surplus'])).rows[0].v;
  const args=[f.tenantId,execution.amendment_id,uuid(7)],amount=-calculation.delta.grossMinor;
  const context={memberCreditLiabilityBinding:binding,xeroTenantId:'books',currency:'GBP',
   amounts:{grossMinor:amount},reference:`MA:${execution.amendment_id}`,issueDate:today};
  await a.query('SELECT reserve_member_amendment_settlement($1,$2,$3,$4,$5)',[...args,'credit',context]);
  await a.query('SELECT finish_member_amendment_settlement($1,$2,$3,$4,$5)',
   [...args,'awaiting_payment',{kind:'awaiting_member_credit_backing',verified:true,documentId:'note'}]);
  await a.query('SELECT claim_member_credit_backing($1,$2,$3,$4)',[...args,'note']);
  await a.query('SELECT finish_member_amendment_settlement($1,$2,$3,$4,$5)',
   [...args,'settled',{kind:'member_credit_backed',verified:true,documentId:'note',
    liabilityAccountId:'liability',paymentId:'payment',retainedCreditMinor:0}]);
  await a.query("SET test.fail_issue='yes'");
  await assert.rejects(a.query('SELECT apply_member_membership_amendment($1,$2,$3)',args),/Injected issuance failure/);
  assert.equal((await admin.query('SELECT count(*)::int n FROM member_membership_amendment_application')).rows[0].n,0);
  assert.equal((await admin.query('SELECT state FROM member_membership_amendment_settlement')).rows[0].state,'settled');
  await a.query("SET test.fail_issue='no'");
  for(let i=0;i<2;i++)await a.query('SELECT apply_member_membership_amendment($1,$2,$3)',args);
  const vouchers=(await admin.query('SELECT * FROM voucher')).rows;
  assert.equal(vouchers.length,1);assert.equal(vouchers[0].expires_at,null);
  assert.equal(Math.round(Number(vouchers[0].value)*100),amount);
  assert.equal((await a.query('SELECT * FROM list_member_credit_expiry_reviews($1)',[f.tenantId])).rows.length,0);
  await assert.rejects(a.query('SELECT voucher_admin_write($1,$2,$3,$4,$5,$6)',
   [f.tenantId,vouchers[0].id,'expire',{},'admin','expire']),/no expiry/);
  await admin.query("SET app.voucher_credit_write='yes'; UPDATE voucher SET expires_at=now()-interval '1 day'; SET app.voucher_credit_write=''");
  await a.query('SELECT voucher_admin_write($1,$2,$3,$4,$5,$6)',[f.tenantId,vouchers[0].id,'expire',{},'admin','expire']);
  assert.equal(Math.round(Number((await admin.query('SELECT value FROM voucher')).rows[0].value)*100),amount);
  const reviewArgs=[...args,'Reviewed against Xero. No automatic write-off.'];
  await a.query('SELECT review_member_credit_expiry($1,$2,$3,$4)',reviewArgs);
  const reviewed=(await a.query('SELECT list_member_credit_expiry_reviews($1) v',[f.tenantId])).rows[0].v;
  assert.equal(reviewed.needsReview,false);assert.equal(reviewed.availableMinor,amount);
  await assert.rejects(a.query('SELECT apply_member_amendment_before_credit($1,$2,$3)',args),{code:'42501'});
  await assert.rejects(a.query('DELETE FROM member_membership_credit'),{code:'42501'});
  await a.query('RESET ROLE; SET ROLE authenticated');
  await assert.rejects(a.query('SELECT review_member_credit_expiry($1,$2,$3,$4)',reviewArgs),{code:'42501'});
 }finally{
  await Promise.all(clients.map(c=>c.end()));
  if(started)cmd('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
  await h.cleanup();
 }
});
