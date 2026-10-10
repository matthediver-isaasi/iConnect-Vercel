import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('click authority: retained evidence, atomic parallel requests, replay, rollback and grants', async () => {
  const h = await createLocalPostgresHarness('click-authority-');
  const run = (cmd,args,input) => {
    const r=spawnSync(cmd,args,{input,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  const sql = text => run('psql',['-h',h.socket,'-p',String(h.port),'-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-At'],text);
  const c='11111111-1111-4111-8111-111111111111';
  const r='22222222-2222-4222-8222-222222222222';
  let started=false;
  const clients=[];
  try {
    run('initdb',['-D',h.data,'-A','trust','-U','postgres']);
    run('pg_ctl',['-D',h.data,'-l',path.join(h.root,'postgres.log'),'-o',`-F -k ${h.socket} -c listen_addresses= -p ${h.port}`,'-w','start']); started=true;
    sql(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE email_campaign(id uuid PRIMARY KEY,clicked_count int,delivered_count int);
      CREATE TABLE email_campaign_recipient(id uuid PRIMARY KEY,campaign_id uuid,status text,click_count int,clicked_at timestamptz,delivered_at timestamptz);
      CREATE TABLE email_link_click(id uuid DEFAULT gen_random_uuid(),campaign_id uuid,recipient_id uuid,clicked_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
      CREATE TABLE email_event(id uuid DEFAULT gen_random_uuid(),event_type text,mailgun_event_id text,mailgun_message_id text,email text,raw_event jsonb);
      INSERT INTO email_campaign VALUES('${c}',2,0);
      INSERT INTO email_campaign_recipient VALUES('${r}','${c}','sent',8,now(),null);
      INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${c}','${r}'),('${c}','${r}');
      INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${r}','${r}');
      INSERT INTO email_event(event_type,mailgun_event_id,mailgun_message_id,email,raw_event)
      VALUES('clicked','old','message','fixture@example.invalid','{}'),('clicked','old','message','fixture@example.invalid','{}');`);
    const migration=readFileSync('supabase/migrations/20261211_campaign_click_authority.sql','utf8');
    sql(migration); sql(migration);
    assert.equal(sql('SELECT click_count||\':\'||legacy_mixed_click_count FROM email_campaign_recipient'),'2:8');
    assert.equal(sql('SELECT count(*) FROM email_counted_link_click'),'2');
    assert.equal(sql('SELECT count(*) FROM email_event'),'2'); // retained old duplicates
    assert.equal(sql(`SELECT has_table_privilege('anon','email_counted_link_click','SELECT') OR has_function_privilege('authenticated','count_iconnect_link_request()','EXECUTE')`),'f');
    for(let i=0;i<8;i++) {
      const db=new pg.Client({host:h.socket,port:h.port,user:'postgres',database:'postgres'});
      await db.connect(); clients.push(db);
    }
    await Promise.all(clients.map(db=>db.query(`INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${c}','${r}')`)));
    assert.equal(sql('SELECT click_count FROM email_campaign_recipient'),'10');
    assert.equal(sql('SELECT clicked_count||\':\'||delivered_count FROM email_campaign'),'1:1');
    sql('UPDATE email_campaign_recipient SET click_count=1000,clicked_at=NULL');
    assert.equal(sql('SELECT click_count FROM email_campaign_recipient'),'10');
    await assert.rejects(clients[0].query(`INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${r}','${r}')`),/mismatch/);
    assert.equal(sql('SELECT count(*) FROM email_link_click'),'11');
    const event=`INSERT INTO email_event(event_type,mailgun_event_id,mailgun_message_id,email,raw_event) VALUES('clicked','new','message','fixture@example.invalid','{"url":"https://example.invalid"}')`;
    await Promise.all(clients.map(db=>db.query(event)));
    assert.equal(sql("SELECT count(*) FROM email_event WHERE mailgun_event_id='new'"),'1');
    const noId=`INSERT INTO email_event(event_type,mailgun_message_id,email,raw_event) VALUES('clicked','message','fixture@example.invalid','{"timestamp":123,"url":"https://example.invalid"}')`;
    await Promise.all(clients.map(db=>db.query(noId)));
    assert.equal(sql("SELECT count(*) FROM email_event WHERE mailgun_event_id IS NULL"),'1');
    assert.equal(sql('SELECT click_count FROM email_campaign_recipient'),'10');
    sql(`BEGIN; INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${c}','${r}'); ROLLBACK;`);
    assert.equal(sql('SELECT click_count FROM email_campaign_recipient'),'10');
    sql("UPDATE email_campaign_recipient SET status='unsubscribed'");
    sql(`INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${c}','${r}')`);
    assert.equal(sql('SELECT status FROM email_campaign_recipient'),'unsubscribed');
    const second='33333333-3333-4333-8333-333333333333';
    sql(`INSERT INTO email_campaign_recipient(id,campaign_id,status,click_count) VALUES('${second}','${c}','sent',0)`);
    await Promise.all(clients.map(db=>db.query(`INSERT INTO email_link_click(campaign_id,recipient_id) VALUES('${c}','${second}')`)));
    assert.equal(sql(`SELECT click_count FROM email_campaign_recipient WHERE id='${second}'`),'8');
    assert.equal(sql('SELECT clicked_count||\':\'||delivered_count FROM email_campaign'),'2:2');
  } finally {
    await Promise.all(clients.map(db=>db.end()));
    if(started)spawnSync('pg_ctl',['-D',h.data,'-m','immediate','stop'],{encoding:'utf8'});
    await h.cleanup();
  }
});
