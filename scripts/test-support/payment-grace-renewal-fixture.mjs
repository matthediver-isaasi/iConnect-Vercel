import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Used by the real post-grace reservation/finalizer harness. Receipt write
// authority/immutability is exercised separately in paymentGraceExitStorage.
export async function exercisePaymentGraceRenewal(db) {
  await db.query(`
    ALTER TABLE member_membership_history ADD COLUMN IF NOT EXISTS payment_grace_exit_id uuid;
    ALTER TABLE member_membership_history ADD COLUMN IF NOT EXISTS config_id uuid;
    CREATE TABLE membership_payment_grace_exit(
      id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,history_id uuid,agreement_id uuid,config_id uuid,
      original_term_start_date date,original_term_end_date date,grace_expires_at timestamptz,effective_at timestamptz);
  `);
  const authority = readFileSync(new URL('../../supabase/migrations/202701250002_payment_grace_exit_authority.sql',import.meta.url),'utf8');
  const start = authority.indexOf('CREATE FUNCTION public.membership_payment_grace_exit_evidence(');
  const end = authority.indexOf('CREATE FUNCTION public.apply_membership_payment_grace_exit(');
  await db.query(authority.slice(start,end));
  await db.query(readFileSync(new URL('../../supabase/migrations/202701250003_payment_grace_exit_renewal.sql',import.meta.url),'utf8'));
  const id = n => `30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const [tenant,member,prior,agreement,config,receipt] = [1,2,3,4,5,6].map(id);
  await db.query('INSERT INTO tenant VALUES($1)',[tenant]);
  await db.query('INSERT INTO member(id,tenant_id) VALUES($1,$2)',[member,tenant]);
  await db.query(`INSERT INTO membership_tier_config(id,tenant_id,structure_scope_type,billing_period,is_active,start_mode)
    VALUES($1,$2,'member','annual',true,'immediate')`,[config,tenant]);
  await db.query('INSERT INTO membership_post_grace_policy(tenant_id,enabled) VALUES($1,true)',[tenant]);
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,config_id,billing_agreement_id,status,payment_status,term_start_date,term_end_date,
     membership_renewal_date,term_key,commitment_snapshot)
    VALUES($1,$2,$3,$4,$5,'expired','unpaid',current_date-60,current_date+305,current_date+306,
      null,'{"config":{"renewal_grace_days":90}}')`,[prior,tenant,member,config,agreement]);
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider)
    VALUES($1,$2,$3,'payment_plan_cancelled','gocardless')`,[agreement,tenant,member]);
  const dates = (await db.query(`SELECT current_date::text start,
    ((current_date+interval '1 year')::date-1)::text finish`)).rows[0];
  const quote = {payerMemberId:member,simulation:{config:{id:config},formRenewal:{
    commencementBasis:'confirmed_payment',predecessorId:prior},
    paymentSchedule:{term_start_date:dates.start,term_end_date:dates.finish}}};
  const reserve = () => db.query(`SELECT reserve_post_grace_renewal($1,$2,$3,$4,'upfront',12800,'GBP',$5) data`,
    [tenant,member,prior,config,quote]);
  await assert.rejects(reserve(),/requires review/,'cancelled billing is not sufficient without audited expiry');
  await db.query(`INSERT INTO membership_payment_grace_exit
    SELECT $1,tenant_id,member_id,id,billing_agreement_id,config_id,term_start_date,term_end_date,
      now()-interval '17 days',now()-interval '1 day'
    FROM member_membership_history WHERE id=$2`,[receipt,prior]);
  await assert.rejects(reserve(),/requires review/,'unlinked receipt is not authority');
  await db.query('UPDATE member_membership_history SET payment_grace_exit_id=$1 WHERE id=$2',[receipt,prior]);
  await db.query(`INSERT INTO membership_billing_agreements(id,tenant_id,member_id,status,provider)
    VALUES($1,$2,$3,'payment_plan_cancelled','gocardless')`,[id(7),tenant,member]);
  await assert.rejects(reserve(),/Another membership or payment/,'a different cancelled agreement cannot borrow the receipt');
  await db.query('DELETE FROM membership_billing_agreements WHERE id=$1',[id(7)]);
  const original = (await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',[prior])).rows[0].data;
  const election = (await reserve()).rows[0].data;
  assert.equal(election.previous_term_id,prior);
  assert.equal((await reserve()).rows[0].data.id,election.id,'replay returns the same checkout');
  const journal = (await db.query('SELECT * FROM membership_post_grace_renewal WHERE election_id=$1',[election.id])).rows[0];
  assert.equal(journal.previous_term_id,prior);
  assert.deepEqual((await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',[prior])).rows[0].data,
    original,'renewal must not mark the prior term paid or change purchased dates');
  const successor = id(8);
  await db.query(`INSERT INTO member_membership_history
    (id,tenant_id,member_id,status,payment_status,previous_term_id,membership_successor_election_id,commitment_snapshot)
    VALUES($1,$2,$3,'pending','unpaid',$4,$5,'{"price":128}')`,
  [successor,tenant,member,prior,election.id]);
  const expected = {history:(await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',
    [successor])).rows[0].data,agreement:null,plan:null};
  const confirmed = await db.query(`SELECT apply_post_grace_record_dates(
    $1,$2,$3,'stripe','pi-grace-restart','succeeded',now(),12800,'GBP',$4) receipt`,
  [tenant,member,journal.id,expected]);
  assert.ok(confirmed.rows[0].receipt);
  const paidTerm = (await db.query(`SELECT term_start_date::text start,term_end_date::text finish
    FROM member_membership_history WHERE id=$1`,[successor])).rows[0];
  assert.equal(paidTerm.start,dates.start);
  assert.equal(paidTerm.finish,dates.finish);
  assert.deepEqual((await db.query('SELECT to_jsonb(h) data FROM member_membership_history h WHERE id=$1',[prior])).rows[0].data,
    original,'successful successor payment must preserve the original unpaid debt and future purchased dates');
}
