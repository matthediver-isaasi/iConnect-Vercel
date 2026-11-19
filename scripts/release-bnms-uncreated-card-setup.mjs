// Exact owner-authorised correction; never an automated missing-ID cleanup.
import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
const apply=process.argv[2]==='--apply';
assert.ok(process.argv.length===2||(process.argv.length===3&&apply));
const target=destinationTarget(process.env);
process.env.SUPABASE_URL=process.env.DEST_SUPABASE_URL;
process.env.SUPABASE_SERVICE_KEY=process.env.DEST_SUPABASE_KEY;
const tenant='ff2df806-b321-4254-b651-3af11fccf1db';
const member='64a6c0a0-50d3-40b5-a26d-5885ea08418f';
const agreement='29d29282-3cea-4c35-8221-c0ceaa9bbecd';
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false}});
const {data:before,error}=await db.from('membership_billing_agreements').select('*')
 .eq('tenant_id',tenant).eq('member_id',member).eq('id',agreement).single();
assert.ifError(error);
assert.equal(before.status,'payment_setup_required');
assert.equal(before.environment,'live');
assert.equal(before.provider,'stripe');
assert.equal(before.stripe_checkout_session_id,null);
assert.equal(before.stripe_subscription_id,null);
assert.equal(before.cancelled_for_switch_at,null);
const {getStripeIntegrationCredentials}=await import('../api/_lib/stripeCredentials.js');
const keys=await getStripeIntegrationCredentials(tenant);
const Stripe=(await import('stripe')).default;
const stripe=new Stripe(keys.secret_key);
// Exhaust live provider resources since the original attempt, including every
// subscription state. Refuse partial evidence or any matching provider object.
const counts={};
for(const kind of ['sessions','subscriptions']){
 const params={created:{gte:Math.floor(Date.parse(before.created_at)/1000)-3600},limit:100};
 const list=kind==='sessions'?stripe.checkout.sessions.list(params):stripe.subscriptions.list({...params,status:'all'});
 let count=0;
 for await(const resource of list){
  assert.ok(++count<=2000,'Provider inspection incomplete');
  assert.equal(resource.livemode,true);
  assert.ok(resource.metadata?.member_id!==member&&resource.metadata?.agreement_id!==agreement,
   'A provider object exists; reconcile it instead of releasing this attempt');
 }
 counts[kind]=count;
}
const ca=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
assert.ok(ca.ok);
const sql=new pg.Client({connectionString:target.toString(),ssl:{ca:await ca.text(),rejectUnauthorized:true,servername:target.hostname}});
try{
 await sql.connect();assert.ok(sql.connection.stream.authorized);
 await sql.query('BEGIN');
 await sql.query("SET LOCAL statement_timeout='15s'");
 await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('rolling:'||$1::text||':member_id:'||$2::text,0))",[tenant,member]);
 const row=(await sql.query('SELECT * FROM membership_billing_agreements WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[agreement,tenant])).rows[0];
 assert.equal(row.status,before.status);
 assert.equal(row.stripe_checkout_session_id,null);
 assert.equal(row.stripe_subscription_id,null);
 assert.equal(row.cancelled_for_switch_at,null);
 assert.deepEqual(row.metadata,before.metadata);
 for(const table of ['member_membership_history','membership_payment_plans','membership_payment_quote','form_joining_voucher_checkout']){
  assert.equal((await sql.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND member_id=$2`,[tenant,member])).rows[0].n,0);
 }
 assert.equal((await sql.query("SELECT count(*)::int n FROM membership_billing_agreements WHERE tenant_id=$1 AND member_id=$2 AND cancelled_for_switch_at IS NULL",[tenant,member])).rows[0].n,1);
 const evidence={reason:'Owner-authorised release of uncreated Stripe card setup after exhaustive live provider inspection',
  checkedAt:new Date().toISOString(),providerEnvironment:'live',resourceCounts:counts,providerMatches:0,
  agreements:[before],quotes:[],histories:[]};
 const recovery=(await sql.query(`INSERT INTO form_initial_checkout_recovery(tenant_id,member_id,state,snapshot,receipts,released_at)
  VALUES($1,$2,'reconciling',$3::jsonb,'[]'::jsonb,null) RETURNING id`,[tenant,member,JSON.stringify(evidence)])).rows[0];
 await sql.query("UPDATE membership_billing_agreements SET status='cancelled',cancelled_for_switch_at=now() WHERE id=$1 AND tenant_id=$2",[agreement,tenant]);
 await sql.query("DELETE FROM membership_payment_term_claim WHERE tenant_id=$1 AND owner_type='member' AND owner_id=$2 AND source_key=$3",[tenant,member,before.idempotency_key]);
 await sql.query("UPDATE form_initial_checkout_recovery SET state='released',released_at=now() WHERE id=$1 AND state='reconciling'",[recovery.id]);
 await sql.query(apply?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({applied:apply,providerWrites:0,providerMatches:0,counts,...(apply?{recoveryId:recovery.id}:{})}));
}catch(error){await sql.query('ROLLBACK').catch(()=>{});throw error;}
finally{await sql.end();}
