import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { verifySchema } from '../../scripts/apply-ticket-selected-member-audience-migration.mjs';

test('isolated PostgreSQL: direct-write guards, empty deny-all, tenant/parent scope and legacy preservation', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ticket-audience-pg-'));
  const cluster = join(root, 'data');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let db, started = false;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(root, 'log'), '-o', `-k ${root} -p 55579 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    db = new pg.Client({ host: root, port: 55579, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE ROLE authenticated;
      CREATE TABLE member(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE complex_event(id uuid PRIMARY KEY,tenant_id uuid);
      CREATE TABLE event(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,pricing_config jsonb);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,complex_event_id uuid,
        name text,visibility_mode text,role_ids uuid[],member_group_ids uuid[],role_match_only boolean,
        create_member_records boolean,new_member_role_id uuid);
      INSERT INTO member VALUES('${id(10)}','${id(1)}'),('${id(11)}','${id(2)}');
      INSERT INTO complex_event VALUES('${id(20)}','${id(1)}'),('${id(21)}','${id(2)}'),('${id(22)}','${id(1)}');
      INSERT INTO complex_event_ticket_class(id,tenant_id,complex_event_id,name,role_ids,role_match_only)
        VALUES('${id(30)}','${id(1)}','${id(20)}','Legacy',ARRAY['${id(10)}']::uuid[],true);
      INSERT INTO event VALUES('${id(40)}','${id(1)}','Legacy','{"ticket_classes":[{"id":"old","role_ids":["legacy"],"visibility_mode":"public_only"}]}');
      INSERT INTO event VALUES('${id(41)}','${id(1)}','Historical malformed','"{bad"');
    `);
    const before = (await db.query("SELECT pricing_config FROM event WHERE id=$1", [id(40)])).rows[0].pricing_config;
    const migration = await readFile(new URL('../../supabase/migrations/202612310005_ticket_selected_member_audience.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration);
    const evidence = await verifySchema(db);
    assert.equal(evidence.triggers.length, 2);
    assert.deepEqual((await db.query('SELECT pricing_config FROM event WHERE id=$1', [id(40)])).rows[0].pricing_config, before);
    assert.deepEqual((await db.query('SELECT audience_mode,selected_member_ids FROM complex_event_ticket_class WHERE id=$1', [id(30)])).rows[0], {
      audience_mode: null, selected_member_ids: null,
    });
    await db.query("UPDATE event SET name='Renamed' WHERE id=$1", [id(41)]);
    await db.query("UPDATE complex_event_ticket_class SET name='Renamed' WHERE id=$1", [id(30)]);
    assert.equal((await db.query('SELECT selected_member_ids FROM complex_event_ticket_class WHERE id=$1', [id(30)])).rows[0].selected_member_ids, null);
    const selected = { id: 'private', audience_mode: 'selected_members', selected_member_ids: [id(10)], visibility_mode: 'members_only' };
    const insertComplex = async (ticket, tenant = id(1), parent = id(20)) => {
      const { rows } = await db.query(`INSERT INTO complex_event_ticket_class(
        tenant_id,complex_event_id,audience_mode,selected_member_ids,visibility_mode,
        role_ids,member_group_ids,role_match_only,create_member_records,new_member_role_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [
        tenant, parent, ticket.audience_mode, ticket.selected_member_ids, ticket.visibility_mode,
        ticket.role_ids ?? null, ticket.member_group_ids ?? null, ticket.role_match_only ?? null,
        ticket.create_member_records ?? null, ticket.new_member_role_id ?? null,
      ]);
      return rows[0];
    };
    const insertSimple = async (ticket, stringify = false) => {
      let value = { ticket_classes: [ticket] };
      if (stringify) value = JSON.stringify(value);
      return (await db.query('INSERT INTO event(tenant_id,pricing_config) VALUES($1,$2) RETURNING *', [id(1), JSON.stringify(value)])).rows[0];
    };
    const valid = await insertComplex({ ...selected, selected_member_ids: [id(10), id(10)] });
    assert.deepEqual(valid.selected_member_ids, [id(10)]);
    const empty = await insertComplex({ ...selected, selected_member_ids: [] });
    assert.deepEqual(empty.selected_member_ids, []);
    assert.deepEqual((await insertSimple({ ...selected, selected_member_ids: [] })).pricing_config.ticket_classes[0].selected_member_ids, []);
    for (const conflict of [
      { selected_member_ids: [id(11)] }, { selected_member_ids: [id(99)] },
      { selected_member_ids: null }, { selected_member_ids: [null] },
      { audience_mode: 'everyone' }, { role_ids: [id(10)] },
      { member_group_ids: [id(10)] }, { role_match_only: true },
      { visibility_mode: 'public_only' }, { visibility_mode: 'members_and_public' },
      { create_member_records: true }, { new_member_role_id: id(10) },
    ]) {
      await assert.rejects(insertComplex({ ...selected, ...conflict }), { code: '23514' });
      await assert.rejects(insertSimple({ ...selected, ...conflict }), { code: '23514' });
    }
    await assert.rejects(insertComplex(selected, id(1), id(21)), { code: '23514' });
    await assert.rejects(insertComplex(selected, id(1), id(99)), { code: '23514' });
    await assert.rejects(db.query('UPDATE complex_event_ticket_class SET complex_event_id=$1 WHERE id=$2', [id(22), valid.id]), { code: '23514' });
    await assert.rejects(db.query('UPDATE complex_event_ticket_class SET tenant_id=$1 WHERE id=$2', [id(2), empty.id]), { code: '23514' });
    await assert.rejects(db.query("UPDATE complex_event_ticket_class SET visibility_mode='public_only' WHERE id=$1", [valid.id]), { code: '23514' });
    await db.query("UPDATE complex_event_ticket_class SET audience_mode='legacy' WHERE id=$1", [valid.id]);
    assert.deepEqual((await db.query('SELECT selected_member_ids FROM complex_event_ticket_class WHERE id=$1', [valid.id])).rows[0].selected_member_ids, []);
    await db.query("UPDATE complex_event_ticket_class SET audience_mode='selected_members' WHERE id=$1", [valid.id]);
    assert.deepEqual((await db.query('SELECT selected_member_ids FROM complex_event_ticket_class WHERE id=$1', [valid.id])).rows[0].selected_member_ids, []);
    for (const stringify of [false, true]) {
      const simple = await insertSimple({ ...selected, selected_member_ids: [id(10), id(10)] }, stringify);
      const config = stringify ? JSON.parse(simple.pricing_config) : simple.pricing_config;
      assert.deepEqual(config.ticket_classes[0].selected_member_ids, [id(10)]);
      await db.query('UPDATE event SET pricing_config=$1 WHERE id=$2', [
        JSON.stringify({ ticket_classes: [{ ...selected, audience_mode: null }] }), simple.id,
      ]);
      assert.deepEqual((await db.query('SELECT pricing_config FROM event WHERE id=$1', [simple.id])).rows[0].pricing_config.ticket_classes[0].selected_member_ids, []);
    }
    for (const pricing of ['"{bad"', '[]', '{"ticket_classes":{}}', '{"ticket_classes":[null]}']) {
      await assert.rejects(db.query('INSERT INTO event(tenant_id,pricing_config) VALUES($1,$2)', [id(1), pricing]), { code: '23514' });
    }
    // Ordinary callers cannot read canonical members, but the trigger checks
    // them as its owner, never allowing a hidden/cross-tenant UUID through.
    await db.query('GRANT INSERT, SELECT ON complex_event_ticket_class TO authenticated');
    await db.query('SET ROLE authenticated');
    await insertComplex(selected);
    await assert.rejects(insertComplex({ ...selected, selected_member_ids: [id(11)] }), { code: '23514' });
    await assert.rejects(db.query("SELECT public.normalize_ticket_selected_member_audience('{}',null,null)"), { code: '42501' });
    await db.query('RESET ROLE');
  } finally {
    if (db) await db.end();
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
