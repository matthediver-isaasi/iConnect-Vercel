import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('payment-grace evidence is disabled, immutable, scoped and never rewrites financial history', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'payment-grace-pg-'));
  let db, running = false;
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [tenant, member, history, agreement, plan, config, role, action] = [1,2,3,4,5,6,7,8].map(id);
  try {
    execFileSync('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', join(dir, 'data'), '-l', join(dir, 'log'),
      '-o', `-k ${dir} -p 55491 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    running = true;
    db = new pg.Client({ host: dir, port: 55491, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE tenant(id uuid PRIMARY KEY);
      CREATE TABLE role(id uuid PRIMARY KEY,tenant_id uuid,is_tenant_admin boolean);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,role_id uuid,login_enabled boolean);
      CREATE TABLE membership_tier_config(id uuid PRIMARY KEY,tenant_id uuid,renewal_fallback_role_id uuid);
      CREATE TABLE membership_billing_agreements(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,status text,provider text,environment text,gocardless_mandate_id text,
        cancelled_for_switch_at timestamptz,metadata jsonb);
      CREATE TABLE membership_payment_plans(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        organization_id uuid,billing_agreement_id uuid,provider text,environment text,gocardless_mandate_id text,
        status text,grace_expires_at timestamptz,last_payment_status text,last_payment_id text,auto_retry_claim_token text);
      CREATE TABLE member_membership_history(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,
        billing_agreement_id uuid,config_id uuid,status text,payment_status text,term_start_date date,
        term_end_date date,cancelled_for_switch_at timestamptz);
      CREATE TABLE membership_arrears_role_action(id uuid PRIMARY KEY,tenant_id uuid,plan_id uuid,
        member_id uuid,config_id uuid,assigned_role_id uuid,restored_at timestamptz);
      CREATE TABLE gocardless_mandates(tenant_id uuid,environment text,gocardless_mandate_id text,status text);
      CREATE TABLE gocardless_payments(tenant_id uuid,plan_id uuid,environment text,
        gocardless_mandate_id text,gocardless_payment_id text,status text);
      CREATE TABLE membership_successor_election(tenant_id uuid,member_id uuid,status text);
    `);
    await db.query('INSERT INTO tenant VALUES ($1)', [tenant]);
    await db.query('INSERT INTO role VALUES ($1,$2,false)', [role, tenant]);
    await db.query('INSERT INTO member VALUES ($1,$2,$3,true)', [member,tenant,role]);
    await db.query('INSERT INTO membership_tier_config VALUES ($1,$2,$3)', [config,tenant,role]);
    await db.query(`INSERT INTO membership_billing_agreements VALUES
      ($1,$2,$3,null,'payment_plan_cancelled','gocardless','live','MD',null,$4)`,
    [agreement,tenant,member,JSON.stringify({dd:{config_id:config}})]);
    await db.query(`INSERT INTO membership_payment_plans VALUES
      ($1,$2,$3,null,$4,'gocardless','live','MD','payment_plan_cancelled',
       '2026-01-01','failed','PM',null)`, [plan,tenant,member,agreement]);
    await db.query(`INSERT INTO member_membership_history VALUES
      ($1,$2,$3,$4,$5,'pending_payment_setup','unpaid','2025-12-01','2027-12-01',null)`,
    [history,tenant,member,agreement,config]);
    await db.query(`INSERT INTO membership_arrears_role_action VALUES ($1,$2,$3,$4,$5,$6,null)`,
      [action,tenant,plan,member,config,role]);
    await db.query("INSERT INTO gocardless_mandates VALUES ($1,'live','MD','cancelled')", [tenant]);
    await db.query("INSERT INTO gocardless_payments VALUES ($1,$2,'live','MD','PM','failed')", [tenant,plan]);
    const snapshot = async () => (await db.query(`SELECT jsonb_build_object(
      'member',(SELECT jsonb_agg(m) FROM member m),
      'history',(SELECT jsonb_agg(h) FROM member_membership_history h),
      'plan',(SELECT jsonb_agg(p) FROM membership_payment_plans p),
      'agreement',(SELECT jsonb_agg(a) FROM membership_billing_agreements a)) AS data`)).rows[0].data;
    const before = await snapshot();
    await db.query(await readFile(new URL('../../supabase/migrations/202701250001_payment_grace_exit_storage.sql', import.meta.url), 'utf8'));
    assert.deepEqual(await snapshot(), before, 'schema installation cannot mutate existing records');
    const insert = `INSERT INTO membership_payment_grace_exit
      (tenant_id,member_id,history_id,agreement_id,plan_id,config_id,role_action_id,fallback_role_id,
       failed_payment_id,grace_expires_at,original_term_start_date,original_term_end_date,
       original_payment_status,approval_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PM','2026-01-01','2025-12-01','2027-12-01','unpaid','isolated fixture')`;
    const values = [tenant,member,history,agreement,plan,config,action,role];
    await assert.rejects(db.query(insert,values), /rollout is disabled/);
    for (const actor of ['anon','authenticated','service_role']) {
      await db.query(`SET ROLE ${actor}`);
      await assert.rejects(db.query(insert,values), /permission denied/);
      await assert.rejects(db.query("INSERT INTO membership_payment_grace_exit_release VALUES ($1,true,'forged',now())",[tenant]), /permission denied/);
      if(actor !== 'service_role') await assert.rejects(db.query('SELECT * FROM membership_payment_grace_exit'), /permission denied/);
      else assert.equal((await db.query('SELECT * FROM membership_payment_grace_exit')).rowCount,0);
      await db.query('RESET ROLE');
    }
    // Fixture-only release. Never inserts an enabled release in production.
    await db.query("INSERT INTO membership_payment_grace_exit_release VALUES ($1,true,'isolated fixture',now())",[tenant]);
    const rejectedPatch = async (sql, params = []) => {
      await db.query('BEGIN');
      try {
        await db.query(sql,params);
        await assert.rejects(db.query(insert,values), /evidence|conflicting/);
      } finally { await db.query('ROLLBACK'); }
    };
    await rejectedPatch("UPDATE member_membership_history SET payment_status='paid'");
    await rejectedPatch("UPDATE member_membership_history SET cancelled_for_switch_at=now()");
    await rejectedPatch("UPDATE membership_payment_plans SET status='active'");
    await rejectedPatch("UPDATE membership_payment_plans SET auto_retry_claim_token='in-flight'");
    await rejectedPatch("UPDATE membership_payment_plans SET grace_expires_at=now()+interval '1 day'");
    await rejectedPatch("UPDATE membership_payment_plans SET member_id=$1",[id(99)]);
    await rejectedPatch("UPDATE membership_billing_agreements SET environment='sandbox'");
    await rejectedPatch("UPDATE membership_tier_config SET renewal_fallback_role_id=null");
    await rejectedPatch("UPDATE membership_arrears_role_action SET restored_at=now()");
    await rejectedPatch("UPDATE role SET is_tenant_admin=true");
    await rejectedPatch("UPDATE gocardless_mandates SET status='active'");
    await rejectedPatch("UPDATE gocardless_payments SET status='confirmed'");
    await rejectedPatch("INSERT INTO gocardless_payments VALUES ($1,$2,'live','MD','PM2','pending_submission')",[tenant,plan]);
    await rejectedPatch("INSERT INTO membership_successor_election VALUES ($1,$2,'reserved')",[tenant,member]);
    const wrongOwner = [...values]; wrongOwner[1] = id(99);
    await assert.rejects(db.query(insert,wrongOwner), /does not match/);
    const wrongTenant = [...values]; wrongTenant[0] = id(99);
    await assert.rejects(db.query(insert,wrongTenant), /rollout is disabled/);
    await db.query(insert,values);
    assert.deepEqual(await snapshot(),before,'evidence insert preserves original history, billing and login');
    await assert.rejects(db.query(insert,values),/duplicate key/);
    await assert.rejects(db.query("UPDATE membership_payment_grace_exit SET approval_reference='changed'"),/immutable/);
    await assert.rejects(db.query('DELETE FROM membership_payment_grace_exit'),/immutable/);
    await db.query('SET ROLE service_role');
    assert.equal((await db.query('SELECT * FROM membership_payment_grace_exit')).rowCount,1);
    await assert.rejects(db.query("UPDATE membership_payment_grace_exit SET approval_reference='forged'"),/permission denied/);
    await db.query('RESET ROLE');
  } finally {
    await db?.end();
    if(running) execFileSync('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop'],{stdio:'pipe'});
    await rm(dir,{recursive:true,force:true});
  }
});
