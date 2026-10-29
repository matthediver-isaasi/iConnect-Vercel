import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { createLocalPostgresHarness } from './test-support/local-postgres-harness.mjs';

test('event opt-in SQL: isolated configuration, subscribe-only writes, suppression and replay', async () => {
  const h = await createLocalPostgresHarness('event-consent-');
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  let db, started = false;
  try {
    run('initdb', ['-D', h.data, '-A', 'trust', '-U', 'postgres']);
    run('pg_ctl', ['-D', h.data, '-l', path.join(h.root, 'postgres.log'), '-o', `-F -k ${h.socket} -c listen_addresses= -p ${h.port}`, '-w', 'start']);
    started = true;
    db = new pg.Client({ host: h.socket, port: h.port, user: 'postgres', database: 'postgres' });
    await db.connect();
    await db.query(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table event(id uuid primary key,tenant_id uuid);
      create table complex_event(id uuid primary key,tenant_id uuid);
      create table communication_category(id uuid primary key,tenant_id uuid,is_active boolean,is_public boolean,member_enabled boolean,system_key text);
      create table member(id uuid primary key,tenant_id uuid,email text,role_id uuid,login_enabled boolean default true,communications_opted_out_all boolean default false);
      create table communication_category_role(tenant_id uuid,category_id uuid,role_id uuid);
      create table member_communication_preference(tenant_id uuid,member_id uuid,category_id uuid,is_subscribed boolean,unique(member_id,category_id));
      create table email_unsubscribe(id uuid default gen_random_uuid(),tenant_id uuid,email text,member_id uuid,unsubscribe_type text,
        communication_category_id uuid,campaign_id uuid,source text,unsubscribed_at timestamptz,created_at timestamptz default now(),
        unique(tenant_id,email,unsubscribe_type,communication_category_id));
      create table email_subscriber(id uuid default gen_random_uuid(),tenant_id uuid,email text,first_name text,last_name text,form_id uuid,
        communication_category_id uuid,opted_out boolean,subscribed_at timestamptz,opted_out_at timestamptz,updated_at timestamptz);
      create unique index on email_subscriber(tenant_id,email,communication_category_id) where communication_category_id is not null;
    `);
    await db.query(readFileSync('supabase/migrations/20260826_atomic_email_preference_global_state.sql','utf8'));
    await db.query(readFileSync('supabase/migrations/20260831_repair_atomic_email_preference_global_state.sql','utf8'));
    await db.query(readFileSync('supabase/migrations/202610260001_event_registration_consent.sql','utf8'));
    await db.query(readFileSync('supabase/migrations/202610290001_event_registration_consent_names.sql','utf8'));
    const tenant = randomUUID(), foreign = randomUUID(), event = randomUUID(), member = randomUUID(), role = randomUUID();
    const a = randomUUID(), b = randomUUID(), privateCategory = randomUUID(), foreignCategory = randomUUID();
    await db.query('insert into event values($1,$2)', [event,tenant]);
    await db.query('insert into member(id,tenant_id,email,role_id) values($1,$2,$3,$4)',[member,tenant,'member@example.test',role]);
    for (const [id,t,p] of [[a,tenant,true],[b,tenant,true],[privateCategory,tenant,false],[foreignCategory,foreign,true]])
      await db.query('insert into communication_category values($1,$2,true,$3,true,null)',[id,t,p]);
    const configure = ids => db.query('select set_event_registration_communication($1,$2,$3,$4)',[tenant,'simple',event,ids]);
    await assert.rejects(configure([foreignCategory]), /Category unavailable/);
    await configure([a,b,privateCategory]);
    const offer = async (email, memberId = null, first = null, last = null) => {
      const id = randomUUID();
      await db.query(`insert into event_registration_consent(id,tenant_id,event_kind,event_id,purchase_reference,member_id,email,token_hash,first_name,last_name)
        values($1::uuid,$2,'simple',$3,$1::text,$4,$5,$1::text,$6,$7)`, [id,tenant,event,memberId,email,first,last]);
      return (ids, asMember = memberId) => db.query('select complete_event_registration_consent($1,$2,$3,$4)', [id,id,asMember,ids]);
    };
    const memberOffer = await offer('member@example.test',member);
    await assert.rejects(memberOffer([a],null), /Offer unavailable/);
    await memberOffer([a]);
    await memberOffer([b]); // Completed purchase cannot add a later choice.
    assert.deepEqual((await db.query('select category_id from member_communication_preference where is_subscribed')).rows,[{category_id:a}]);
    const guest = await offer('guest@example.test');
    await guest([a]);
    assert.equal((await db.query('select opted_out from email_subscriber')).rows[0].opted_out,false);
    await (await offer('skip@example.test'))([]);
    assert.equal((await db.query('select count(*) from email_subscriber')).rows[0].count,'1');
    await assert.rejects((await offer('member@example.test'))([b]), /Subscription unavailable/);
    await assert.rejects((await offer('private@example.test'))([privateCategory]), /Category unavailable/);
    await db.query('insert into communication_category_role values($1,$2,$3)',[tenant,b,randomUUID()]);
    await assert.rejects((await offer('member@example.test',member))([b]), /Category unavailable/);
    await assert.rejects((await offer('restricted@example.test'))([b]), /Category unavailable/);
    await db.query('delete from communication_category_role');
    const named = await offer('booker@example.test',null,'Jo','Booker');
    await named([a,b]);
    await named([a,b]);
    const names = async email => (await db.query('select first_name,last_name from email_subscriber where lower(trim(email))=$1 order by first_name',[email])).rows;
    assert.deepEqual(await names('booker@example.test'),Array(2).fill({first_name:'Jo',last_name:'Booker'}));
    await db.query(`update email_subscriber set first_name=' ',last_name='Kept',opted_out=true where email='booker@example.test' and communication_category_id=$1`,[a]);
    await (await offer('booker@example.test',null,'Filled','Replacement'))([a]);
    assert.deepEqual(await names('booker@example.test'),[{first_name:'Filled',last_name:'Kept'},{first_name:'Jo',last_name:'Booker'}]);
    await db.query(`update email_subscriber set email=' BOOKER@example.test ' where email='booker@example.test' and communication_category_id=$1`,[a]);
    await (await offer('booker@example.test',null,'Overwrite','Overwrite'))([a]);
    assert.equal((await names('booker@example.test')).length,2);
    assert.deepEqual(await names('guest@example.test'),[{first_name:null,last_name:null}]);
    await (await offer('named-skip@example.test',null,'Skip','Me'))([]);
    assert.deepEqual(await names('named-skip@example.test'),[]);
    await assert.rejects((await offer('rollback@example.test',null,'No','Write'))([a,privateCategory]), /Category unavailable/);
    assert.deepEqual(await names('rollback@example.test'),[]);
    await db.query(`select set_email_preference_global_state($1,'guest@example.test',null,true,null,$2)`,[tenant,[a,b]]);
    await assert.rejects((await offer('guest@example.test'))([b]), /Subscription unavailable/);
    assert.equal((await db.query(`select count(*) from email_unsubscribe where unsubscribe_type='all'`)).rows[0].count,'1');
    await db.query('update member set communications_opted_out_all=true');
    await assert.rejects((await offer('member@example.test',member))([b]), /Subscription unavailable/);
    const stale = await offer('stale@example.test');
    await configure([a]);
    await assert.rejects(stale([b]), /Offer changed/);
    await db.query('update communication_category set is_active=false where id=$1',[a]);
    await assert.rejects(stale([a]), /Category unavailable/);
    await db.query('update communication_category set is_active=true where id=$1',[a]);
    const expired = await offer('expired@example.test');
    await db.query(`update event_registration_consent set expires_at=now()-interval '1 second' where email='expired@example.test'`);
    await assert.rejects(expired([a]), /Offer unavailable/);
    for (const actor of ['anon','authenticated']) {
      await db.query(`set role ${actor}`);
      await assert.rejects(db.query('select * from event_registration_consent'), /permission denied/);
      await assert.rejects(configure([]), /permission denied/);
      await db.query('reset role');
    }
    await db.query('set role service_role');
    await configure([a]);
    await db.query('reset role');
    // A global opt-out holding the recipient lock wins over an in-flight opt-in.
    const concurrent = new pg.Client({ host:h.socket,port:h.port,user:'postgres',database:'postgres' });
    await concurrent.connect();
    try {
      const racing = await offer('race@example.test');
      await concurrent.query('begin');
      await concurrent.query(`select set_email_preference_global_state($1,'race@example.test',null,true,null,$2)`,[tenant,[a]]);
      let settled=false;
      const waiting=racing([a]).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
      await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(settled,false);
      await concurrent.query('commit');
      assert.match((await waiting).message,/Subscription unavailable/);
      assert.equal((await db.query(`select count(*) from email_subscriber where email='race@example.test' and opted_out=false`)).rows[0].count,'0');
    } finally { await concurrent.end(); }
    await db.query('delete from event where id=$1',[event]);
    assert.equal((await db.query('select count(*) from event_registration_communication')).rows[0].count,'0');
    assert.equal((await db.query('select count(*) from event_registration_consent where completed_at is null')).rows[0].count,'0');
  } finally {
    await db?.end();
    if (started) run('pg_ctl',['-D',h.data,'-m','immediate','-w','stop']);
    await h.cleanup();
  }
});
