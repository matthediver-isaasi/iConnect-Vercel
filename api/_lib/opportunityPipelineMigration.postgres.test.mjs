import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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