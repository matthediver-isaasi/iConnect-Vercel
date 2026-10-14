import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const tenant='ff2df806-b321-4254-b651-3af11fccf1db',member='d5edd3c1-177c-4949-be58-26ac5ac4308b';
const history='665a224c-4b28-4800-97cf-544725016cc1';
const configIds=['71099a5f-da49-41af-b39d-bf08f70bd79d','0c68ef89-8543-4dc8-a759-20ab9b2598f5'];
const root='generated-artifacts/bnms-card-activation';
const migration='supabase/migrations/20261014_manual_card_membership_activation.sql';
const mode=process.argv[2];assert.ok(['dry-run','apply'].includes(mode));
const evidence=JSON.parse(fs.readFileSync(`${root}/stripe-evidence.json`));
assert.ok(Date.now()-Date.parse(evidence.checkedAt)<1800000);
assert.equal(evidence.paymentIntentStatus,'succeeded');assert.equal(evidence.amountReceived,1300);
assert.equal(evidence.subscriptionStatus,'active');assert.equal(evidence.livemode,true);
destinationTarget(process.env);
const db=await connectDestination();
try {
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  await db.query('LOCK TABLE membership_tier_config,membership_payment_plans,membership_billing_agreements,member_membership_history,member IN SHARE ROW EXCLUSIVE MODE');
  const table=async name=>(await db.query(`select to_jsonb(r) data from ${name} r where tenant_id=$1 order by id`,[tenant])).rows.map(r=>r.data);
  const tables=['membership_tier_config','membership_payment_plans','membership_billing_agreements','member_membership_history','member'];
  const before={};for(const t of tables)before[t]=await table(t);
  const h=before.member_membership_history.find(h=>h.id===history);assert.equal(h.member_id,member);
  const a=before.membership_billing_agreements.find(a=>a.id===h.billing_agreement_id);
  const p=before.membership_payment_plans.find(p=>p.billing_agreement_id===a.id);
  assert.equal(a.stripe_subscription_id,evidence.subscriptionId);
  assert.equal(p.last_payment_status,'paid');assert.equal(p.instalments_paid,1);
  assert.ok(p.metadata.paid_invoice_ids.includes(evidence.invoiceId));
  assert.equal(h.status,'pending_activation');assert.equal(h.payment_status,'partial');
  for(const id of configIds)assert.equal(before.membership_tier_config.find(c=>c.id===id).dd_activation_rule,'mandate');
  const hash=createHash('sha256').update(JSON.stringify({h,a,p,
    configs:before.membership_tier_config.filter(c=>configIds.includes(c.id)),
    migration:fs.readFileSync(migration,'utf8')})).digest('hex');
  if(mode==='apply')assert.equal(JSON.parse(fs.readFileSync(`${root}/dry-run.json`)).hash,hash);
  fs.writeFileSync(`${root}/before-${mode}-${Date.now()}.json`,JSON.stringify({before,evidence,hash},null,2),{mode:0o600,flag:'wx'});
  await db.query(fs.readFileSync(migration,'utf8'));
  const change=await db.query(`update membership_tier_config set dd_activation_rule='first_payment' where tenant_id=$1 and id=any($2::uuid[]) and dd_activation_rule='mandate'`,[tenant,configIds]);
  assert.equal(change.rowCount,2);
  await db.query('SET LOCAL ROLE service_role');
  const approve=async()=>(await db.query('select approve_manual_card_membership_activation($1,$2,$3,$4) result',[tenant,member,history,'administrator-approved recovery'])).rows[0].result;
  const result=await approve();assert.equal(result.updated,true);assert.equal(result.activated,true);
  assert.equal((await approve()).updated,false);
  await db.query('RESET ROLE');
  for(const t of tables){
    const after=await table(t);
    const expected=structuredClone(before[t]);
    if(t==='membership_tier_config')for(const c of expected)if(configIds.includes(c.id))c.dd_activation_rule='first_payment';
    if(t==='member_membership_history'){const changed=expected.find(h=>h.id===history);changed.status='active';changed.scheduled_activation_date=null;}
    assert.deepEqual(after,expected,`${t} unexpected drift`);
  }
  const {rows}=await db.query(`select count(*)::int total,count(*) filter(where dd_activation_rule='first_payment')::int first_payment from membership_tier_config where tenant_id=$1 and is_active and (effective_to is null or effective_to>=current_date)`,[tenant]);
  assert.equal(rows[0].total,15);assert.equal(rows[0].first_payment,15);
  const audit=await db.query(`select count(*)::int n from membership_dd_admin_actions where tenant_id=$1 and plan_id=$2 and details->>'history_id'=$3 and details->>'provider'='stripe'`,[tenant,p.id,history]);
  assert.equal(audit.rows[0].n,1);
  const grants=await db.query(`select has_function_privilege('service_role','approve_manual_card_membership_activation(uuid,uuid,uuid,text)','execute') service,
    has_function_privilege('anon','approve_manual_card_membership_activation(uuid,uuid,uuid,text)','execute') anon,
    has_function_privilege('authenticated','approve_manual_card_membership_activation(uuid,uuid,uuid,text)','execute') authenticated`);
  assert.deepEqual(grants.rows[0],{service:true,anon:false,authenticated:false});
  await db.query(mode==='apply'?'COMMIT':'ROLLBACK');
  const receipt={mode,hash,committed:mode==='apply',migration,schedulesChanged:2,firstPaymentSchedules:15,
    membershipActivated:1,repeatChanges:0,providerWrites:0,subscriptionChanges:0};
  fs.writeFileSync(`${root}/${mode}.json`,JSON.stringify(receipt,null,2),{mode:0o600,flag:mode==='apply'?'wx':'w'});
  console.log(JSON.stringify(receipt));
} catch(e) {await db.query('ROLLBACK');console.error('Repair stopped:',e.code||e.name,e.message?.split('\n')[0]);process.exitCode=1;}
finally{await db.end();}
