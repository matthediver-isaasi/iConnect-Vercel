import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

test('list copy is atomic, tenant-scoped, service-only and preserves contact consent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'audience-duplicate-'));
  const dataDir = join(root, 'db');
  const port = 48000 + Math.floor(Math.random() * 1000);
  execFileSync('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', dataDir, '-o', `-F -p ${port} -k ${root}`, '-w', 'start'], { stdio: 'ignore' });
  const db = new pg.Client({ host: root, port, user: 'postgres', database: 'postgres' });
  await db.connect();
  t.after(async () => {
    await db.end();
    execFileSync('pg_ctl', ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  });
  await db.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE communication_category(id uuid PRIMARY KEY);
    CREATE TABLE tenant_user(id uuid PRIMARY KEY);
    CREATE TABLE member(id uuid PRIMARY KEY);
  `);
  await db.query(await readFile('supabase/migrations/20260227_create_audience_list.sql', 'utf8'));
  await db.query('ALTER TABLE audience_list ADD COLUMN ignore_opt_outs boolean DEFAULT false');
  await db.query('ALTER TABLE audience_list ADD COLUMN category_review_required boolean NOT NULL DEFAULT false, ADD COLUMN category_review_reason jsonb');
  await db.query(await readFile('supabase/migrations/20260828_audience_list_external_contacts.sql', 'utf8'));
  const migration = await readFile('supabase/migrations/202701220001_duplicate_audience_list.sql', 'utf8');
  await db.query(migration);
  await db.query(migration);
  const tenant = '11111111-1111-4111-8111-111111111111';
  const foreign = '22222222-2222-4222-8222-222222222222';
  const category = '33333333-3333-4333-8333-333333333333';
  await db.query('INSERT INTO communication_category VALUES ($1)', [category]);
  const source = (await db.query(`INSERT INTO audience_list(tenant_id,name,target_audiences,communication_category_id,ignore_opt_outs)
    VALUES($1,'Source','[{"type":"member","ids":["fixture"]}]',$2,true) RETURNING id`, [tenant, category])).rows[0].id;
  await db.query(`UPDATE audience_list SET category_review_required=true, category_review_reason='{"reason":"deleted category"}' WHERE id=$1`, [source]);
  await db.query(`INSERT INTO audience_list_external_contact(tenant_id,audience_list_id,email,normalized_email,first_name,last_name,
    addition_source,gdpr_acknowledged,gdpr_acknowledged_at,added_by_actor_label)
    VALUES($1,$2,'person@example.test','person@example.test','Test','Person','csv_upload',true,'2026-01-01','Original importer')`, [tenant, source]);
  assert.equal((await db.query(`SELECT has_function_privilege('anon','public.duplicate_audience_list(uuid,uuid,text)','EXECUTE') a,
    has_function_privilege('authenticated','public.duplicate_audience_list(uuid,uuid,text)','EXECUTE') b,
    has_function_privilege('service_role','public.duplicate_audience_list(uuid,uuid,text)','EXECUTE') c`)).rows[0].c, true);
  const permissions = (await db.query(`SELECT has_function_privilege('anon','public.duplicate_audience_list(uuid,uuid,text)','EXECUTE') a,
    has_function_privilege('authenticated','public.duplicate_audience_list(uuid,uuid,text)','EXECUTE') b`)).rows[0];
  assert.deepEqual(permissions, { a: false, b: false });
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query('SELECT duplicate_audience_list($1,$2,$3)', [foreign, source, 'Denied']), error => error.code === 'P0002');
  const copy = (await db.query('SELECT duplicate_audience_list($1,$2,$3) id', [tenant, source, 'Copy'])).rows[0].id;
  await db.query('RESET ROLE');
  assert.notEqual(copy, source);
  const list = (await db.query('SELECT name,target_audiences,communication_category_id,ignore_opt_outs,category_review_required,category_review_reason FROM audience_list WHERE id=$1', [copy])).rows[0];
  assert.equal(list.name, 'Copy');
  assert.equal(list.communication_category_id, category);
  assert.equal(list.ignore_opt_outs, true);
  assert.equal(list.category_review_required, true);
  assert.deepEqual(list.category_review_reason, { reason: 'deleted category' });
  assert.deepEqual(list.target_audiences, [{ type: 'member', ids: ['fixture'] }]);
  const contact = (await db.query('SELECT * FROM audience_list_external_contact WHERE audience_list_id=$1', [copy])).rows[0];
  assert.equal(contact.gdpr_acknowledged, true);
  assert.equal(contact.gdpr_acknowledged_at.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(contact.added_by_actor_label, 'Original importer');
  await db.query("UPDATE audience_list SET target_audiences='[]' WHERE id=$1", [copy]);
  assert.equal((await db.query('SELECT jsonb_array_length(target_audiences) n FROM audience_list WHERE id=$1', [source])).rows[0].n, 1);
  await db.query(`CREATE FUNCTION fail_contact_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test insert failure'; END $$;
    CREATE TRIGGER fail_copy BEFORE INSERT ON audience_list_external_contact FOR EACH ROW EXECUTE FUNCTION fail_contact_copy();`);
  await assert.rejects(db.query('SELECT duplicate_audience_list($1,$2,$3)', [tenant, source, 'Must roll back']), /test insert failure/);
  assert.equal((await db.query("SELECT count(*)::int n FROM audience_list WHERE name='Must roll back'")).rows[0].n, 0);
});
