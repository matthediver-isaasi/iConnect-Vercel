import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { rehearse } from '../../scripts/rehearse-opportunity-owner-identity.mjs';

const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260908_opportunity_pipeline.sql',
  import.meta.url,
));
const sql = await readFile(migrationPath, 'utf8');

function executable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, input = '') {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

const baseSchema = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE TABLE tenant(id uuid PRIMARY KEY);
  CREATE TABLE organization(id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
  CREATE TABLE member(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id uuid);
  CREATE TABLE tenant_user(id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
  CREATE TABLE event(id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
`;

test('opportunity pipeline migration installs cleanly and replays partial and complete states', {
  timeout: 30_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'opportunity-pipeline-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  spawnSync('mkdir', ['-p', socket]);
  const args = ['-h', socket, '-p', '55443', '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  let started = false;

  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p 55443`, '-w', 'start']);
    started = true;

    // Clean install, followed by a replay with real opportunity data. A stale
    // counter is deliberately introduced to prove the replay backfill repairs
    // all stages without replacing either stage or opportunity rows.
    run(psql, args, baseSchema);
    run(psql, [...args, '-f', migrationPath]);
    run(psql, args, `
      INSERT INTO tenant VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO organization VALUES
        ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
      INSERT INTO member VALUES
        ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000001');
      INSERT INTO opportunity_stage(id,tenant_id,name,position) VALUES
        ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Open',0);
      INSERT INTO opportunity(id,tenant_id,organization_id,stage_id,owner_kind,owner_id,name,
        created_by_kind,created_by_id)
      VALUES('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
        'member','20000000-0000-4000-8000-000000000001','Preserved',
        'member','20000000-0000-4000-8000-000000000001');
      ALTER TABLE opportunity_stage DISABLE TRIGGER opportunity_stage_deactivation_guard;
      UPDATE opportunity_stage SET opportunity_count=99;
      ALTER TABLE opportunity_stage ENABLE TRIGGER opportunity_stage_deactivation_guard;
      CREATE TRIGGER stale_stage_count_alias
        BEFORE INSERT OR UPDATE OF stage_id OR DELETE ON opportunity
        FOR EACH ROW EXECUTE FUNCTION maintain_opportunity_stage_count();
      ALTER TABLE opportunity_stage_history DROP COLUMN note;
    `);
    run(psql, [...args, '-f', migrationPath]);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT (SELECT count(*) FROM opportunity WHERE name='Preserved') || ':' ||
        (SELECT opportunity_count FROM opportunity_stage
         WHERE id='30000000-0000-4000-8000-000000000001') || ':' ||
        (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='opportunity_stage_history'
           AND column_name='note') || ':' ||
        (SELECT count(*) FROM pg_trigger
         WHERE tgrelid IN (
           SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace
             AND relname LIKE 'opportunity%'
         ) AND NOT tgisinternal);
    `), '1:1:1:13');

    // Representative failed first attempt: only the original migration's first
    // table exists. Its row must survive while every later object is installed.
    run(psql, args, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${baseSchema}
      INSERT INTO tenant VALUES ('00000000-0000-4000-8000-000000000002');
      CREATE TABLE opportunity_stage (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        name varchar(120) NOT NULL, position integer NOT NULL,
        color varchar(20) NOT NULL DEFAULT '#64748b', probability integer NOT NULL DEFAULT 0,
        is_won boolean NOT NULL DEFAULT false, is_lost boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true, opportunity_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(tenant_id,id),
        CHECK(position>=0), CHECK(color ~ '^#[0-9A-Fa-f]{6}$'),
        CHECK(probability BETWEEN 0 AND 100), CHECK(opportunity_count>=0),
        CHECK(NOT (is_won AND is_lost))
      );
      INSERT INTO opportunity_stage(tenant_id,name,position)
      VALUES('00000000-0000-4000-8000-000000000002','Existing',0);
    `);
    run(psql, [...args, '-f', migrationPath]);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT (SELECT count(*) FROM opportunity_stage WHERE name='Existing') || ':' ||
        (to_regclass('public.opportunity_activity') IS NOT NULL)::text || ':' ||
        (to_regprocedure('public.move_opportunity(uuid,uuid,uuid,uuid,integer,text,uuid)') IS NOT NULL)::text;
    `), '1:true:true');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});

test('opportunity pipeline replay keeps security and hook reconciliation explicit', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.opportunity_stage/i);
  assert.match(sql, /lacks required unique key \(tenant_id, id\)/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS opportunity_stage_count_trigger/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT ALL[\s\S]*TO service_role/i);
});

test('forward identity guard fixes the reproduced mismatch without changing unrelated guards or rows', {
  timeout: 30_000,
}, async (t) => {
  const initdb = executable('initdb'), pgCtl = executable('pg_ctl'), psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('PostgreSQL command-line tools are unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'opportunity-identity-'));
  const data = path.join(root, 'data'), socket = path.join(root, 'socket');
  run('mkdir', ['-p', socket]);
  const args = ['-h', socket, '-p', '55443', '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q'];
  const forward = fileURLToPath(new URL('../../supabase/migrations/202701240001_opportunity_owner_identity.sql', import.meta.url));
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const insert = (owner, contact = null, kind = 'tenant_user') => `
    INSERT INTO opportunity(tenant_id,organization_id,stage_id,owner_kind,owner_id,name,
      created_by_kind,created_by_id,primary_contact_id)
    VALUES('${uuid(1)}','${uuid(3)}','${uuid(5)}','${kind}','${uuid(owner)}','Sale',
      '${kind}','${uuid(owner)}',${contact ? `'${uuid(contact)}'` : 'NULL'});`;
  const reject = statement => `DO $$ BEGIN
    ${statement}
    RAISE EXCEPTION 'Expected tenant rejection';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;`;
  let started = false;
  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p 55443`, '-w', 'start']);
    started = true;
    run(psql, args, `${baseSchema}
      CREATE TABLE tenant_identity(id uuid PRIMARY KEY);
      CREATE TABLE tenant_membership(identity_id uuid, tenant_id uuid, status text, role text, membership_type text);
      INSERT INTO tenant VALUES('${uuid(1)}'),('${uuid(2)}');
      INSERT INTO organization VALUES('${uuid(3)}','${uuid(1)}'),('${uuid(4)}','${uuid(2)}');
      INSERT INTO member VALUES('${uuid(6)}','${uuid(1)}','${uuid(3)}'),
        ('${uuid(7)}','${uuid(2)}','${uuid(4)}'),('${uuid(8)}','${uuid(1)}','${uuid(4)}');
      INSERT INTO tenant_user VALUES('${uuid(9)}','${uuid(1)}');
      INSERT INTO tenant_identity SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
        FROM generate_series(10,17) n;
      INSERT INTO tenant_membership VALUES
        ('${uuid(10)}','${uuid(1)}','active','member','member'),
        ('${uuid(10)}','${uuid(1)}','active','admin','member'),
        ('${uuid(11)}','${uuid(2)}','active','admin','member'),
        ('${uuid(12)}','${uuid(1)}','inactive','admin','member'),
        ('${uuid(13)}','${uuid(1)}','active','member','admin'),
        ('${uuid(15)}','${uuid(1)}','active','member','owner'),
        ('${uuid(16)}','${uuid(1)}','active','owner','member'),
        ('${uuid(18)}','${uuid(1)}','active','admin','member');
    `);
    run(psql, [...args, '-f', migrationPath]);
    run(psql, args, `
      INSERT INTO opportunity_stage(id,tenant_id,name,position) VALUES('${uuid(5)}','${uuid(1)}','Open',0);
      ${insert(9, 6)}
      ${reject(insert(10, 6))}
      CREATE TEMP TABLE before_guard AS SELECT pg_get_functiondef('guard_opportunity_tenant_links()'::regprocedure) definition;
    `);
    // Capture independently before replacement; the forward patch must alter
    // only the two exact principal subqueries, never the rest of the function.
    const before = run(psql, [...args, '-t', '-A'], "SELECT pg_get_functiondef('guard_opportunity_tenant_links()'::regprocedure)");
    const beforeRows = run(psql, [...args, '-t', '-A'], 'SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM opportunity o');
    const db = new pg.Client({ host: socket, port: 55443, user: 'postgres', database: 'postgres' });
    await db.connect();
    try {
      const original = (await db.query("SELECT prosrc FROM pg_proc WHERE oid='guard_opportunity_tenant_links()'::regprocedure")).rows[0].prosrc;
      const patch = await readFile(forward, 'utf8');
      assert.deepEqual(await rehearse(db, '--preflight', patch, original),
        { mode: '--preflight', rolledBack: true, applied: false });
      assert.deepEqual(await rehearse(db, '--rehearse', patch, original),
        { mode: '--rehearse', rolledBack: true, applied: false });
      await assert.rejects(rehearse(db, '--verify', patch, original), /Installed guard differs/);
    } finally { await db.end(); }
    run(psql, [...args, '-f', forward]);
    const after = run(psql, [...args, '-t', '-A'], "SELECT pg_get_functiondef('guard_opportunity_tenant_links()'::regprocedure)");
    let expected = before;
    for (const field of ['owner_id', 'principal_id']) {
      expected = expected.replace(`(SELECT 1 FROM tenant_user WHERE id=NEW.${field} AND tenant_id=NEW.tenant_id)`,
        `(SELECT 1 FROM tenant_user WHERE id=NEW.${field} AND tenant_id=NEW.tenant_id
       UNION ALL
       SELECT 1 FROM tenant_identity i JOIN tenant_membership m ON m.identity_id=i.id
       WHERE i.id=NEW.${field} AND m.tenant_id=NEW.tenant_id AND m.status='active'
         AND (m.role IN ('owner','admin') OR m.membership_type='owner'))`);
    }
    assert.equal(after, expected);
    assert.equal(run(psql, [...args, '-t', '-A'], 'SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM opportunity o'), beforeRows);
    run(psql, args, `
      ALTER ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO service_role;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
      SET ROLE service_role;
      ${insert(10, 6)} ${insert(10)} ${insert(15)} ${insert(16)} ${insert(6, null, 'member')}
      RESET ROLE;
      ${[11,12,13,14,17,18,99].map(id => reject(insert(id, 6))).join('\n')}
      ${reject(insert(10, 7))} ${reject(insert(10, 8))}
      ${reject(`UPDATE opportunity SET organization_id='${uuid(4)}' WHERE owner_id='${uuid(10)}';`)}
      ${reject(`UPDATE opportunity SET owner_id='${uuid(11)}' WHERE owner_id='${uuid(10)}';`)}
      UPDATE opportunity SET owner_kind='tenant_user',owner_id='${uuid(10)}' WHERE owner_id='${uuid(6)}';
      INSERT INTO opportunity_collaborator(tenant_id,opportunity_id,principal_kind,principal_id,added_by_kind,added_by_id)
        SELECT tenant_id,id,'tenant_user','${uuid(10)}','tenant_user','${uuid(10)}' FROM opportunity LIMIT 1;
      ${[11,12,13,14,18,99].map(id => reject(`
        INSERT INTO opportunity_collaborator(tenant_id,opportunity_id,principal_kind,principal_id,added_by_kind,added_by_id)
        SELECT tenant_id,id,'tenant_user','${uuid(id)}','tenant_user','${uuid(10)}' FROM opportunity LIMIT 1;`)).join('\n')}
      ${reject(`INSERT INTO opportunity_activity(tenant_id,opportunity_id,organization_id,action,summary)
        SELECT tenant_id,id,'${uuid(4)}','test','Test' FROM opportunity LIMIT 1;`)}
      ${reject(`INSERT INTO opportunity_contact_role(tenant_id,opportunity_id,member_id,role)
        SELECT tenant_id,id,'${uuid(7)}','Test' FROM opportunity LIMIT 1;`)}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) FROM opportunity o JOIN opportunity_contact_role c
        ON c.opportunity_id=o.id AND c.is_primary
      WHERE o.owner_id='${uuid(10)}' AND c.member_id='${uuid(6)}'`), '1');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});