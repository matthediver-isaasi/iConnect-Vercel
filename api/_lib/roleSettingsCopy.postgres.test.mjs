import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createLocalPostgresHarness } from '../../scripts/test-support/local-postgres-harness.mjs';

test('atomic settings replacement: defaults, restrictions, preservation, protection, rollback and concurrent copies', async () => {
  const h = await createLocalPostgresHarness('role-settings-copy-');
  let started = false;
  const c = new pg.Client({ host: h.socket, port: h.port, user: 'runner', database: 'postgres' });
  const tenant = '00000000-0000-0000-0000-000000000010';
  const source = '00000000-0000-0000-0000-000000000001';
  const target = '00000000-0000-0000-0000-000000000002';
  const other = '00000000-0000-0000-0000-000000000003';
  const foreign = '00000000-0000-0000-0000-000000000004';
  const copy = (s = source, t = target, admin = true, client = c) =>
    client.query('SELECT copy_role_access_settings($1,$2,$3,$4) role', [tenant, s, t, admin]);
  const snapshot = async () => (await c.query(`SELECT jsonb_build_object(
    'roles',(SELECT jsonb_agg(t ORDER BY id) FROM role t),
    'members',(SELECT jsonb_agg(t ORDER BY id) FROM role_member_field_permission t),
    'orgs',(SELECT jsonb_agg(t ORDER BY id) FROM role_organization_field_permission t),
    'categories',(SELECT jsonb_agg(t ORDER BY id) FROM resource_category t)
  ) state`)).rows[0].state;
  try {
    execFileSync('initdb', ['-D', h.data, '-A', 'trust', '-U', 'runner', '--no-locale'], { stdio: 'pipe' });
    execFileSync('pg_ctl', ['-D', h.data, '-l', `${h.root}/postgres.log`, '-o', `-k ${h.socket} -p ${h.port} -h ''`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    await c.connect();
    await c.query(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE role (id uuid PRIMARY KEY, tenant_id uuid, name text, description text,
        excluded_features text[], is_tenant_admin boolean, assignable_role_ids jsonb,
        is_system boolean DEFAULT false, is_admin boolean DEFAULT false, is_default boolean DEFAULT false,
        badge_image_url text, segment_values text[]);
      CREATE TABLE role_member_field_permission (id varchar PRIMARY KEY, role_id varchar, field_key text, permission text);
      CREATE TABLE role_organization_field_permission (LIKE role_member_field_permission INCLUDING ALL);
      CREATE TABLE resource_category (id uuid PRIMARY KEY, tenant_id uuid, excluded_role_ids jsonb, subcategory_excluded_role_ids jsonb);
      CREATE TABLE member (id int, role_id uuid);
    `);
    await c.query(await readFile(new URL('../../supabase/migrations/20261109_copy_role_access_settings.sql', import.meta.url), 'utf8'));
    await c.query(`INSERT INTO role (id,tenant_id,name,description,excluded_features,is_tenant_admin,assignable_role_ids,is_default,badge_image_url,segment_values)
      VALUES ($1,$4,'Source','source',ARRAY['admin.billing'],false,'[]',false,'source.png',ARRAY['source']),
      ($2,$4,'Target','keep',ARRAY['old'],false,NULL,true,'keep.png',ARRAY['keep']),
      ($3,$4,'Unrelated','other',NULL,false,NULL,false,NULL,NULL),
      ($5,'00000000-0000-0000-0000-000000000099','Foreign',NULL,NULL,false,NULL,false,NULL,NULL)`,
    [source, target, other, tenant, foreign]);
    await c.query('INSERT INTO member VALUES (1,$1)', [target]);
    for (const table of ['role_member_field_permission', 'role_organization_field_permission']) {
      await c.query(`INSERT INTO ${table} VALUES ('source',$1,'email','hidden'),('target',$2,'old','read'),('other',$3,'other','write')`, [source, target, other]);
    }
    await c.query(`INSERT INTO resource_category VALUES ($1,$2,$3,$4),($5,$2,$6,$7)`, [
      source, tenant, JSON.stringify([source, other]), JSON.stringify({ nested: [source, other], targetOnly: [target, other] }),
      target, JSON.stringify([target, other]), JSON.stringify({ lone: [target] }),
    ]);
    const before = await snapshot();
    const result = (await copy()).rows[0].role;
    const after = await snapshot();
    assert.deepEqual(result.excluded_features, ['admin.billing']);
    for (const key of ['name', 'description', 'is_default', 'is_system', 'is_admin', 'badge_image_url', 'segment_values']) {
      assert.deepEqual(result[key], before.roles.find(r => r.id === target)[key]);
    }
    assert.deepEqual(after.roles.filter(r => r.id !== target), before.roles.filter(r => r.id !== target));
    for (const key of ['members', 'orgs']) {
      assert.deepEqual(after[key].filter(r => r.role_id !== target), before[key].filter(r => r.role_id !== target));
      assert.deepEqual(after[key].filter(r => r.role_id === target).map(r => [r.field_key, r.permission]), [['email', 'hidden']]);
    }
    assert.deepEqual(after.categories[0].excluded_role_ids, [source, other, target]);
    assert.deepEqual(after.categories[0].subcategory_excluded_role_ids, { nested: [source, other, target], targetOnly: [other] });
    assert.deepEqual(after.categories[1].excluded_role_ids, [other]);
    assert.deepEqual(after.categories[1].subcategory_excluded_role_ids, { lone: [] });
    assert.equal((await c.query('SELECT role_id FROM member')).rows[0].role_id, target);

    for (const [s, t, code] of [[source, source, '22023'], [foreign, target, 'P0002'], [source, foreign, 'P0002']]) {
      const state = await snapshot();
      await assert.rejects(copy(s, t), error => error.code === code);
      assert.deepEqual(await snapshot(), state);
    }
    await c.query('UPDATE role SET is_system=true WHERE id=$1', [target]);
    await assert.rejects(copy(), error => error.code === '42501');
    await c.query('UPDATE role SET is_system=false WHERE id=$1', [target]);
    await c.query('UPDATE role SET is_tenant_admin=true WHERE id=$1', [source]);
    await assert.rejects(copy(source, target, false), error => error.code === '42501');
    await copy();
    await c.query('UPDATE role SET is_tenant_admin=false WHERE id=$1', [source]);
    await assert.rejects(copy(source, target, false), error => error.code === '42501');

    // Inject a failure at the final category stage, after both permission stores
    // and the role have been replaced. PostgreSQL must undo every mutation.
    await c.query(`CREATE FUNCTION fail_copy() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$;
      CREATE TRIGGER fail_copy BEFORE UPDATE ON resource_category FOR EACH ROW EXECUTE FUNCTION fail_copy();`);
    const rollbackBefore = await snapshot();
    await assert.rejects(copy(other, target), /injected failure/);
    assert.deepEqual(await snapshot(), rollbackBefore);
    await c.query('DROP TRIGGER fail_copy ON resource_category');

    // Truly empty source restores implicit field defaults and clears target-only restrictions.
    await c.query('DELETE FROM role_member_field_permission WHERE role_id=$1', [other]);
    await c.query('DELETE FROM role_organization_field_permission WHERE role_id=$1', [other]);
    await copy(other, target);
    assert.deepEqual((await c.query('SELECT excluded_features,assignable_role_ids FROM role WHERE id=$1', [target])).rows[0],
      { excluded_features: null, assignable_role_ids: null });
    assert.equal((await c.query('SELECT * FROM role_member_field_permission WHERE role_id=$1', [target])).rowCount, 0);
    assert.equal((await c.query('SELECT * FROM role_organization_field_permission WHERE role_id=$1', [target])).rowCount, 0);

    const c2 = new pg.Client({ host: h.socket, port: h.port, user: 'runner', database: 'postgres' });
    await c2.connect();
    try {
      await c.query('BEGIN');
      await copy(source, target);
      let completed = false;
      const pending = copy(other, target, true, c2).then(() => { completed = true; });
      await new Promise(resolve => setTimeout(resolve, 75));
      assert.equal(completed, false, 'second replacement waits for first transaction');
      await c.query('COMMIT');
      await pending;
      assert.equal((await c.query('SELECT excluded_features FROM role WHERE id=$1', [target])).rows[0].excluded_features, null);
    } finally { await c2.end(); }
    const privileges = (await c.query(`SELECT
      has_function_privilege('anon','copy_role_access_settings(uuid,uuid,uuid,boolean)','EXECUTE') anon,
      has_function_privilege('authenticated','copy_role_access_settings(uuid,uuid,uuid,boolean)','EXECUTE') authenticated,
      has_function_privilege('service_role','copy_role_access_settings(uuid,uuid,uuid,boolean)','EXECUTE') service`)).rows[0];
    assert.deepEqual(privileges, { anon: false, authenticated: false, service: true });
  } finally {
    await c.end().catch(() => {});
    if (started) execFileSync('pg_ctl', ['-D', h.data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    await h.cleanup();
  }
});