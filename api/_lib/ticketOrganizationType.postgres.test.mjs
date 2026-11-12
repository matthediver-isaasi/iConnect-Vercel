import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('isolated PostgreSQL migration: idempotent storage, both guards, ownership, options and private exclusion', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ticket-type-pg-'));
  const cluster = join(root, 'data');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let db, started = false;
  try {
    execFileSync('initdb', ['-D', cluster, '-A', 'trust', '-U', 'runner', '--no-locale', '--encoding=UTF8'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', cluster, '-l', join(root, 'log'), '-o', `-k ${root} -p 55587 -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    db = new pg.Client({ host: root, port: 55587, user: 'runner', database: 'postgres' });
    await db.connect();
    await db.query(`
      CREATE TABLE preference_field(id uuid PRIMARY KEY,tenant_id uuid,entity_scope text,name text,is_active boolean,options jsonb);
      CREATE TABLE event(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,pricing_config jsonb);
      CREATE TABLE complex_event_ticket_class(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,name text,audience_mode text);
      INSERT INTO complex_event_ticket_class(tenant_id,name) VALUES('${id(1)}','Legacy');
      INSERT INTO event(tenant_id,name,pricing_config) VALUES('${id(1)}','Legacy','{"ticket_classes":[{"id":"legacy","role_ids":["r"]}]}');
      INSERT INTO preference_field VALUES('${id(4)}','${id(1)}','organization','org_type',true,'["hospital",{"value":"university","label":"University"}]');
    `);
    const sql = await readFile(new URL('../../supabase/migrations/202701210001_ticket_organization_type.sql', import.meta.url), 'utf8');
    await db.query(sql);
    await db.query(sql);
    assert.equal((await db.query('SELECT organization_type_enabled FROM complex_event_ticket_class')).rows[0].organization_type_enabled, false);
    assert.deepEqual((await db.query('SELECT pricing_config FROM event')).rows[0].pricing_config, { ticket_classes: [{ id: 'legacy', role_ids: ['r'] }] });
    const policy = { organization_type_enabled: true, organization_type_field_id: id(4), organization_type_values: ['hospital', 'university'] };
    const insert = async (ticket, complex, tenant = id(1), stringConfig = false) => {
      if (complex) return db.query(`INSERT INTO complex_event_ticket_class(tenant_id,organization_type_enabled,organization_type_field_id,organization_type_values,audience_mode)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [tenant, ticket.organization_type_enabled, ticket.organization_type_field_id, JSON.stringify(ticket.organization_type_values), ticket.audience_mode]);
      const config = { ticket_classes: [ticket] };
      return db.query('INSERT INTO event(tenant_id,pricing_config) VALUES($1,$2) RETURNING *',
        [tenant, JSON.stringify(stringConfig ? JSON.stringify(config) : config)]);
    };
    for (const complex of [false, true]) {
      const row = (await insert(policy, complex)).rows[0];
      const reopened = complex ? row : row.pricing_config.ticket_classes[0];
      assert.deepEqual(reopened.organization_type_values, policy.organization_type_values);
      for (const patch of [
        { organization_type_values: [] }, { organization_type_values: ['stale'] },
        { organization_type_values: [null] }, { organization_type_field_id: id(9) },
        { audience_mode: 'selected_members' },
      ]) await assert.rejects(insert({ ...policy, ...patch }, complex));
      await assert.rejects(insert(policy, complex, id(9)), /another tenant/);
    }
    assert.equal(typeof (await insert(policy, false, id(1), true)).rows[0].pricing_config, 'string');
    await db.query('UPDATE preference_field SET is_active=false');
    await assert.rejects(insert(policy, false), /inactive/);
    await assert.rejects(insert(policy, true), /inactive/);
    // A definition change never rewrites historical purchases or authored policy.
    assert.equal((await db.query('SELECT count(*)::int n FROM complex_event_ticket_class')).rows[0].n, 2);
    const publicGrants = await db.query(`SELECT p.proname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.proname IN ('validate_ticket_organization_type','enforce_ticket_organization_type')
      AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
    assert.equal(publicGrants.rowCount, 0);
  } finally {
    await db?.end();
    if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true });
  }
});
