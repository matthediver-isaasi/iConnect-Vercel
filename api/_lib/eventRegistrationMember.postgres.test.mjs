import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('atomic guest conversion: tenant scope, exact financial preservation, race/replay, duplicate and role guards', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'registration-member-pg-'));
  const cluster = join(root, 'data');
  let db, other, started = false;
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(root, 'log'), '-o', `-k ${root} -p 55567 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    db = new pg.Client({ host: root, port: 55567, user: 'runner', database: 'postgres' }); await db.connect();
    await db.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE role(id uuid primary key,tenant_id uuid,name text,requires_effective_from_date boolean default false,max_members integer);
      CREATE TABLE organization(id uuid primary key,tenant_id uuid);
      CREATE TABLE event(id uuid primary key,tenant_id uuid);
      CREATE TABLE complex_event(LIKE event INCLUDING ALL);
      CREATE TABLE member(id uuid primary key default gen_random_uuid(),tenant_id uuid,first_name text,last_name text,email text,
        supplied_organization_name text,organization_id uuid,role_id uuid,role_effective_from date,login_enabled boolean,
        status text,show_in_directory boolean,is_guest boolean,communications_opted_out_all boolean);
      CREATE UNIQUE INDEX email_unique ON member(tenant_id,lower(btrim(email)));
      CREATE TABLE booking(id uuid primary key,tenant_id uuid,event_id uuid,member_id uuid,organization_id uuid,is_guest_booking boolean,
        attendee_email text,attendee_first_name text,payment_method text,total_cost numeric,status text,ticket_class_id text,purchaser_context jsonb);
      CREATE TABLE complex_event_booking(LIKE booking INCLUDING ALL);
      CREATE TABLE public_ticket_member_purchase(id uuid primary key,tenant_id uuid,event_id uuid,event_kind text,state text,booking_ids uuid[]);
      CREATE TABLE public_ticket_member_link(purchase_id uuid,member_id uuid,participation jsonb);
      INSERT INTO role(id,tenant_id,name) VALUES('${id(10)}','${id(1)}','Member'),('${id(11)}','${id(2)}','Other tenant');
      INSERT INTO role VALUES('${id(12)}','${id(1)}','Dated',true,null),('${id(13)}','${id(1)}','Limited',false,1);
      INSERT INTO organization VALUES('${id(20)}','${id(1)}'),('${id(21)}','${id(2)}');
      INSERT INTO event VALUES('${id(30)}','${id(1)}');
      INSERT INTO complex_event VALUES('${id(31)}','${id(1)}');
    `);
    await db.query(await readFile(new URL('../../supabase/migrations/20260903_role_assignable_roles.sql', import.meta.url), 'utf8'));
    const migration = await readFile(new URL('../../supabase/migrations/20261006160000_event_registration_member.sql', import.meta.url), 'utf8');
    await db.query(migration); await db.query(migration);
    const args = (n, extra = {}) => [id(1), id(n), false, 'Reviewed', 'Name', `member${n}@example.invalid`, 'Typed company', null, id(10), null].map((v, i) => i in extra ? extra[i] : v);
    const sql = 'SELECT public.create_member_from_event_registration($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
    async function booking(n, complex = false) {
      await db.query(`INSERT INTO ${complex ? 'complex_event_booking' : 'booking'} VALUES($1,$2,$3,null,null,true,'guest@example.invalid','Original','card',120,'confirmed','ticket','{"payer":"original"}')`,
        [id(n), id(1), id(complex ? 31 : 30)]);
    }
    for (const n of [40, 41, 42, 43, 44, 45, 46, 47]) await booking(n);
    await booking(50, true);
    const before = (await db.query(`select to_jsonb(b)-'member_id' data from booking b where id=$1`, [id(40)])).rows[0].data;
    await db.query('SET ROLE service_role');
    const first = (await db.query(sql, args(40))).rows[0].result;
    assert.equal(first.alreadyLinked, false);
    const repeat = (await db.query(sql, args(40, { 5: 'different@example.invalid' }))).rows[0].result;
    assert.equal(repeat.alreadyLinked, true); assert.equal(repeat.member.id, first.member.id);
    await assert.rejects(db.query(sql, args(41, { 0: id(2) })));
    await assert.rejects(db.query(sql, args(41, { 8: id(11) })));
    await assert.rejects(db.query(sql, args(41, { 7: id(21) })));
    await assert.rejects(db.query(sql, args(41, { 8: id(12) })));
    await assert.rejects(db.query(sql, args(41, { 5: ' MEMBER40@EXAMPLE.INVALID ' })), { code: '23505' });
    await db.query(sql, args(41, { 8: id(12), 9: '2026-10-06', 7: id(20) }));
    await db.query(sql, args(42, { 8: id(13), 7: id(20) }));
    await assert.rejects(db.query(sql, args(43, { 8: id(13), 7: id(20) })), { code: '23514' });
    await db.query('RESET ROLE'); // inspect snapshots as fixture owner
    const savedComplex = (await db.query(`select to_jsonb(b)-'member_id' data from complex_event_booking b where id=$1`, [id(50)])).rows[0].data;
    await db.query(sql, args(50, { 2: true }));
    assert.deepEqual((await db.query(`select to_jsonb(b)-'member_id' data from complex_event_booking b where id=$1`, [id(50)])).rows[0].data, savedComplex);
    assert.deepEqual((await db.query(`select to_jsonb(b)-'member_id' data from booking b where id=$1`, [id(40)])).rows[0].data, before);
    const created = (await db.query('select * from member where id=$1', [first.member.id])).rows[0];
    assert.equal(created.login_enabled, true); assert.equal(created.status, 'active');
    assert.equal(created.organization_id, null); assert.equal(created.supplied_organization_name, 'Typed company');
    assert.equal(created.communications_opted_out_all, true);
    await db.query(`INSERT INTO public_ticket_member_purchase VALUES($1,$2,$3,'simple','completed',ARRAY[$4]::uuid[])`,[id(60),id(1),id(30),id(47)]);
    await db.query(`INSERT INTO public_ticket_member_link VALUES($1,$2,$3)`,[id(60), first.member.id, JSON.stringify([{kind:'attendee',booking_id:id(47)}])]);
    const checkoutLinked = (await db.query(sql, args(47))).rows[0].result;
    assert.equal(checkoutLinked.alreadyLinked, true);
    assert.equal(checkoutLinked.member.id, first.member.id);
    assert.equal((await db.query('select member_id from booking where id=$1',[id(47)])).rows[0].member_id,null);
    assert.equal((await db.query('select member_id from booking where id=$1', [id(43)])).rows[0].member_id, null);
    assert.equal((await db.query("select count(*)::int n from member where email='member43@example.invalid'")).rows[0].n, 0);
    other = new pg.Client({ host: root, port: 55567, user: 'runner', database: 'postgres' }); await other.connect();
    const raced = await Promise.all([db.query(sql, args(44)), other.query(sql, args(44, { 5: 'other@example.invalid' }))]);
    assert.equal(raced[0].rows[0].result.member.id, raced[1].rows[0].result.member.id);
    const duplicateRace = await Promise.allSettled([db.query(sql, args(45, { 5: 'race@example.invalid' })), other.query(sql, args(46, { 5: 'RACE@example.invalid' }))]);
    assert.equal(duplicateRace.filter(r => r.status === 'fulfilled').length, 1);
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(db.query(sql, args(47)), { code: '42501' });
      await db.query('RESET ROLE');
    }
  } finally {
    await other?.end(); await db?.end();
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
