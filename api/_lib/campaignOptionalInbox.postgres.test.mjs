import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('optional inbox preparation, publication, isolation, retries and unread state in disposable PostgreSQL', { timeout: 120000 }, async () => {
  const h = await createLocalPostgresHarness('optional-inbox-');
  const command = (name, args) => {
    const result = spawnSync(name, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  let db, started = false;
  try {
    command('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    command('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'),
      '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE tenant(id uuid PRIMARY KEY,plan_code text);
      CREATE TABLE plan(code text PRIMARY KEY,quotas jsonb);
      CREATE TABLE email_campaign(id uuid PRIMARY KEY,tenant_id uuid,status text,updated_at timestamptz,
        scheduled_at timestamptz,category_review_required boolean DEFAULT false,
        sent_count int DEFAULT 0,total_recipients int DEFAULT 0,sent_at timestamptz,subject text,
        is_test_mode boolean DEFAULT false,archived_at timestamptz,communication_category_id uuid,completed_at timestamptz);
      CREATE TABLE email_campaign_recipient(id uuid PRIMARY KEY,campaign_id uuid REFERENCES email_campaign(id),
        member_id uuid,email text,first_name text,last_name text,status text,sent_at timestamptz,
        mailgun_message_id text,error_message text);
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid,email text,first_name text,last_name text,
        communications_opted_out_all boolean,login_enabled boolean,organization_id uuid);
      CREATE TABLE email_unsubscribe(id uuid PRIMARY KEY,tenant_id uuid,email text,unsubscribe_type text,communication_category_id uuid);
      CREATE TABLE member_communication_preference(id uuid PRIMARY KEY,tenant_id uuid,member_id uuid,category_id uuid,is_subscribed boolean);
      CREATE TABLE complex_event_session_checkin(id uuid PRIMARY KEY,tenant_id uuid,booking_id uuid,checked_in_at timestamptz);
      CREATE TABLE member_inbox_message_state(recipient_id uuid,member_id uuid,tenant_id uuid,is_read boolean,is_archived boolean,
        UNIQUE(member_id,recipient_id));
      CREATE TABLE campaign_survey_delivery(campaign_recipient_id uuid,campaign_id uuid,tenant_id uuid,status text,resolved_at timestamptz);
      GRANT SELECT,UPDATE ON email_campaign_recipient TO service_role;
      GRANT SELECT ON email_campaign,member_inbox_message_state TO service_role;
    `);
    for (const migration of [
      'migrations/20261001_campaign_preparation.sql',
      'migrations/20261016_campaign_preparation_eligibility_feedback.sql',
      'supabase/migrations/20261018_campaign_inbox_delivery_mode.sql',
      'supabase/migrations/202701010001_optional_campaign_inbox.sql',
    ]) await db.query(readFileSync(migration, 'utf8'));
    await db.query(`INSERT INTO email_campaign(id,tenant_id,status,updated_at,subject,deliver_to_inbox_when_opted_out,communication_category_id)
      VALUES($1,$2,'preparing',now(),'generic',true,$3)`, [id(1),id(2),id(3)]);
    await db.query(`INSERT INTO member(id,tenant_id,email,communications_opted_out_all,login_enabled)
      VALUES($1,$2,'member@example.invalid',false,true)`, [id(4),id(2)]);
    await db.query(`UPDATE email_campaign SET preparation_generation=$1 WHERE id=$2`, [id(5),id(1)]);
    await db.query(`INSERT INTO campaign_preparation(id,campaign_id,tenant_id,campaign_version,snapshot,phase,lease,lease_until)
      SELECT $1,id,tenant_id,updated_at,to_jsonb(c),'global_consent',$2,now()+interval '1 hour'
      FROM email_campaign c WHERE id=$3`, [id(5),id(6),id(1)]);
    // The external identity arrives first; it must not win deduplication and
    // erase the selected member's missing positive category subscription.
    await db.query(`INSERT INTO campaign_preparation_candidate(generation,recipient) VALUES($1,$2),($1,$3)`, [
      id(5), JSON.stringify({ member_id:null,email:'member@example.invalid',bypass_opt_out:true }),
      JSON.stringify({ member_id:id(4),email:'member@example.invalid',communications_opted_out_all:false,bypass_opt_out:true }),
    ]);
    const step = async (action,cursor) => (await db.query(
      `SELECT campaign_preparation_step($1,$2,$3,$4) AS result`,
      [id(5),id(6),action,{cursor}])).rows[0].result;
    await step('global_consent',0);
    await step('global_consent',2);
    await step('consent',0);
    const prepared = await step('consent',2);
    assert.equal(prepared.total,1, 'all-inbox campaign retains its selected audience');
    const staged = (await db.query('SELECT * FROM campaign_preparation_recipient')).rows[0];
    assert.equal(staged.recipient.inbox_only,true);
    assert.equal(staged.recipient.member_id,id(4), 'external duplicate cannot replace the targeted member');
    assert.equal(staged.recipient.bypass_opt_out,false);
    await assert.rejects(db.query(`UPDATE email_campaign SET deliver_to_inbox_when_opted_out=false WHERE id=$1`, [id(1)]), /locked/);
    await db.query(`UPDATE campaign_preparation SET phase='complete'; UPDATE email_campaign SET status='sending'`);
    await db.query(`INSERT INTO email_campaign_recipient(id,campaign_id,member_id,email,status)
      VALUES($1,$2,$3,'member@example.invalid','processing')`, [staged.recipient_id,id(1),id(4)]);
    const publish = () => db.query(`SELECT publish_campaign_inbox_only($1,$2,$3,'Personal subject','<p>Final body</p>')`,
      [id(1),id(2),staged.recipient_id]);
    const summary = async (tenant=id(2)) => (await db.query(`SELECT * FROM campaign_inbox_unread_summary($1,$2)`, [tenant,id(4)])).rows[0];
    assert.equal((await summary()).unread_count,'0');
    await db.query('SET ROLE service_role');
    await publish();
    await publish();
    const published = (await db.query('SELECT * FROM campaign_inbox_recipient')).rows[0];
    assert.equal(published.sent_at,null);
    assert.equal(published.mailgun_message_id,null);
    assert.equal(published.delivery_is_test,null);
    assert.equal((await summary()).unread_count,'1');
    assert.equal((await summary()).latest_subject,'Personal subject');
    assert.equal((await summary(id(99))).unread_count,'0');
    await db.query('RESET ROLE');
    // Execute the actual existing finalizer: inbox-only terminal rows complete
    // successfully but contribute zero provider-accepted email deliveries.
    const journal = readFileSync('supabase/migrations/20261028_campaign_batch_claim_journal.sql','utf8');
    await db.query(journal.slice(journal.indexOf('CREATE OR REPLACE FUNCTION public.campaign_finalize_delivery'),
      journal.indexOf('CREATE TABLE IF NOT EXISTS public.campaign_acceptance_check')));
    await db.query('UPDATE email_campaign SET total_recipients=1');
    const final = (await db.query('SELECT campaign_finalize_delivery($1,$2) AS outcome',[id(1),id(2)])).rows[0].outcome;
    assert.equal(final.complete,true);
    assert.equal(final.status,'sent');
    assert.equal(final.sent,0);
    await db.query(`INSERT INTO member_inbox_message_state VALUES($1,$2,$3,false,true)`,[staged.recipient_id,id(4),id(2)]);
    assert.equal((await summary()).unread_count,'0');
    await db.query('UPDATE member_inbox_message_state SET is_archived=false,is_read=true');
    assert.equal((await summary()).unread_count,'0');
    await db.query('UPDATE member_inbox_message_state SET is_read=false');
    assert.equal((await summary()).unread_count,'1');
    await assert.rejects(db.query(`UPDATE email_campaign_recipient SET sent_at=now()`),/immutable/);
    await assert.rejects(db.query(`UPDATE email_campaign_recipient SET inbox_html='changed'`),/immutable/);
    await db.query(`INSERT INTO email_campaign_recipient(id,campaign_id,member_id,email,status,delivery_is_test,sent_at)
      VALUES($1,$3,$4,'test@example.invalid','sent',true,now()),($2,$3,$4,'unknown@example.invalid','sent',null,now())`,
      [id(7),id(8),id(1),id(4)]);
    assert.equal((await summary()).unread_count,'1','test and unknown email provenance stay hidden');
    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(publish(), /permission denied/);
      await assert.rejects(db.query('SELECT * FROM campaign_inbox_recipient'), /permission denied/);
      await db.query('RESET ROLE');
    }
  } finally {
    if (db) await db.end();
    if (started) command('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
