/**
 * Opt-in disposable PostgreSQL validation only. It never reads credentials,
 * connects to a project database, or starts as part of the default test suite.
 *
 * Run explicitly: BNMS_RUN_LOCAL_POSTGRES=1 node --test
 * scripts/bnms-workforce-direct-import/postgres-runtime.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FILE } from '../workforce-csv-source.mjs';
import { buildManifest, digest, renderInstallSql } from './plan.mjs';

const enabled = process.env.BNMS_RUN_LOCAL_POSTGRES === '1';
// Deliberately do not propagate the workspace environment: it can contain
// project connection strings and credentials, none of which belong in a local
// disposable-cluster test process.
const SAFE_ENV = { PATH: process.env.PATH, HOME: os.homedir(), USER: os.userInfo().username, LANG: 'C' };
const bin = command => {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8', env: SAFE_ENV });
  return result.status === 0 ? result.stdout.trim() : null;
};
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(error => error ? reject(error) : resolve(value));
  });
});
function call(command, args, { input, env } = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', env: { ...SAFE_ENV, ...env } });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function psql(psqlPath, environment, file, expectFailure = false) {
  const result = spawnSync(psqlPath, ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-f', file],
    { encoding: 'utf8', env: { ...SAFE_ENV, ...environment } });
  if (!expectFailure && result.status !== 0) throw new Error(`psql failed:\n${result.stderr || result.stdout}`);
  if (expectFailure && result.status === 0) throw new Error('Expected local PostgreSQL command to fail.');
  return result;
}
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function seedSql(manifest) {
  const json = JSON.stringify(manifest);
  if (json.includes('$seed$')) throw new Error('Unexpected local SQL seed delimiter');
  return `CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.tenant (id uuid PRIMARY KEY, name text, slug text);
CREATE TABLE public.custom_object_definition (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, object_key text, singular_label text, plural_label text,
  description text, icon text, primary_display_field_id uuid, status text, configuration jsonb,
  created_by text, updated_by text, archived_at timestamptz, archived_by text, created_at timestamptz, updated_at timestamptz,
  UNIQUE (tenant_id,id)
);
CREATE TABLE public.preference_field (
  id uuid PRIMARY KEY, name text, label text, field_type text, options jsonb, is_required boolean, display_order integer,
  is_active boolean, created_at timestamptz, updated_at timestamptz, entity_scope text, is_filterable boolean,
  min_selections integer, max_selections integer, show_in_my_organisation boolean, show_in_directory_card boolean,
  show_in_admin_list boolean, tenant_id uuid, allowed_file_types jsonb, all_countries boolean, selected_countries jsonb,
  default_country text, default_countries jsonb, public_access boolean, show_in_my_preferences boolean,
  show_in_member_directory boolean, show_in_member_admin_list boolean, min_length integer, max_length integer,
  directory_visibility jsonb, show_in_admin_column boolean, show_in_admin_filter boolean,
  show_in_member_admin_column boolean, show_in_member_admin_filter boolean, filter_multi_select boolean,
  custom_object_id uuid, created_by text, updated_by text
);
CREATE TABLE public.custom_object_relationship_definition (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, relationship_key text, source_kind text, source_custom_object_id uuid,
  target_kind text, target_custom_object_id uuid, cardinality text, source_label text, target_label text,
  is_required boolean, show_on_source boolean, show_on_target boolean, edit_from_source boolean, edit_from_target boolean,
  status text, configuration jsonb, created_by text, updated_by text, archived_at timestamptz, archived_by text,
  created_at timestamptz, updated_at timestamptz
);
CREATE TABLE public.custom_object_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, custom_object_id uuid NOT NULL,
  archived_at timestamptz, data jsonb NOT NULL, created_by text
);
CREATE TABLE public.custom_object_relationship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, relationship_definition_id uuid NOT NULL,
  source_record_id uuid NOT NULL, target_record_id uuid NOT NULL, created_by text, archived_at timestamptz,
  archived_by text, created_at timestamptz, field_values jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by text, updated_at timestamptz
);
WITH m AS (SELECT $seed$${json}$seed$::jsonb value)
INSERT INTO public.tenant SELECT (value->'metadata'->'objects'->0->>'tenant_id')::uuid,
  'BNMS', 'bnms' FROM m LIMIT 1;
WITH m AS (SELECT $seed$${json}$seed$::jsonb value)
INSERT INTO public.custom_object_definition SELECT (jsonb_populate_record(NULL::public.custom_object_definition, item)).*
  FROM m, jsonb_array_elements(value#>'{metadata,objects}') item;
WITH m AS (SELECT $seed$${json}$seed$::jsonb value)
INSERT INTO public.preference_field SELECT (jsonb_populate_record(NULL::public.preference_field, item)).*
  FROM m, jsonb_array_elements(value#>'{metadata,fields}') item;
WITH m AS (SELECT $seed$${json}$seed$::jsonb value)
INSERT INTO public.custom_object_relationship_definition SELECT (jsonb_populate_record(NULL::public.custom_object_relationship_definition, item)).*
  FROM m, jsonb_array_elements(value#>'{metadata,definitions}') item;
WITH m AS (SELECT $seed$${json}$seed$::jsonb value), values_to_seed AS (
  SELECT item FROM m, jsonb_array_elements(value->'departments') item
  UNION ALL SELECT item FROM m, jsonb_array_elements(value#>'{baseline,records}') item)
INSERT INTO public.custom_object_record(id,tenant_id,custom_object_id,archived_at,data,created_by)
SELECT seeded.id,seeded.tenant_id,seeded.custom_object_id,seeded.archived_at,
  coalesce(seeded.data,'{}'::jsonb),seeded.created_by
FROM values_to_seed, LATERAL jsonb_populate_record(NULL::public.custom_object_record, item) seeded;
WITH m AS (SELECT $seed$${json}$seed$::jsonb value)
INSERT INTO public.custom_object_relationship SELECT (jsonb_populate_record(NULL::public.custom_object_relationship, item)).*
  FROM m, jsonb_array_elements(value#>'{baseline,edges}') item;
`;
}

test('generated direct importer compiles and replays in isolated local PostgreSQL', { skip: !enabled }, async () => {
  const initdb = bin('initdb'), pgCtl = bin('pg_ctl'), psqlPath = bin('psql');
  assert.ok(initdb && pgCtl && psqlPath, 'local initdb, pg_ctl, and psql are required');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bnms-direct-pg-'));
  const socket = path.join(work, 'socket'), data = path.join(work, 'data');
  const localPort = await port();
  const environment = { PGHOST: socket, PGPORT: String(localPort), PGUSER: os.userInfo().username };
  try {
    fs.mkdirSync(socket);
    call(initdb, ['-D', data, '-A', 'trust', '-U', os.userInfo().username, '--no-locale']);
    call(pgCtl, ['-D', data, '-l', path.join(work, 'postgres.log'),
      '-o', `-k ${socket} -p ${localPort}`, '-w', 'start']);
    const state = JSON.parse(fs.readFileSync('/tmp/bnms-workforce-direct-state.json'));
    const manifest = buildManifest(fs.readFileSync(FILE), state);
    const approval = `${manifest.sourceSha256}:${digest(JSON.stringify(manifest))}`;
    const setup = path.join(work, 'setup.sql');
    const install = path.join(work, 'install.sql');
    fs.writeFileSync(setup, seedSql(manifest));
    fs.writeFileSync(install, renderInstallSql(fs.readFileSync(new URL('./import.sql.template', import.meta.url), 'utf8'), manifest));
    psql(psqlPath, environment, setup);
    const installCall = path.join(work, 'install-call.sql');
    fs.writeFileSync(installCall, `SET bnms.final_import_approval=${quote(approval)};\n\\i ${install}\n`);
    psql(psqlPath, environment, installCall);
    const invoke = path.join(work, 'invoke.sql');
    fs.writeFileSync(invoke, `SET bnms.final_import_approval=${quote(approval)};
SELECT public.import_bnms_workforce_direct_occurrences() AS first_run;
SELECT public.import_bnms_workforce_direct_occurrences() AS replay;
SELECT count(*) AS imported_rows FROM public.custom_object_record WHERE custom_object_id=${quote(manifest.rowObjectId)} AND id NOT IN
  (SELECT (x->>'id')::uuid FROM jsonb_array_elements(${quote(JSON.stringify(manifest))}::jsonb#>'{baseline,records}') x);
SELECT has_table_privilege('service_role','public.bnms_workforce_direct_import_occurrences','INSERT') AS service_can_insert;
`);
    const output = psql(psqlPath, environment, invoke).stdout;
    assert.match(output, /"rowsCreated"\s*:\s*1242/);
    assert.match(output, /"rowsReused"\s*:\s*1242/);
    assert.match(output, /\b1242\b/);
    assert.match(output, /\bf\b/);
    const failedFk = path.join(work, 'fk-failure.sql');
    fs.writeFileSync(failedFk, `INSERT INTO public.bnms_workforce_direct_import_occurrences
      (tenant_id,row_object_id,source_sha256,source_line,occurrence_identity,department_id,record_id,edge_id,data)
      VALUES (${quote(manifest.tenantId)},${quote(manifest.rowObjectId)},${quote('0'.repeat(64))},9999,${quote('1'.repeat(64))},
        ${quote(manifest.departments[0].id)},gen_random_uuid(),gen_random_uuid(),'{}');\n`);
    assert.match(psql(psqlPath, environment, failedFk, true).stderr, /foreign key/i);
    const rollback = path.join(work, 'rollback.sql');
    fs.writeFileSync(rollback, `SET bnms.final_import_approval=${quote(approval)};
BEGIN;
INSERT INTO public.custom_object_record(id,tenant_id,custom_object_id,data) VALUES
  ('00000000-0000-0000-0000-000000000099',${quote(manifest.tenantId)},${quote(manifest.rowObjectId)},'{}');
SELECT public.import_bnms_workforce_direct_occurrences();
COMMIT;\n`);
    psql(psqlPath, environment, rollback, true);
    const check = path.join(work, 'check.sql');
    fs.writeFileSync(check, `SELECT count(*) FROM public.custom_object_record WHERE id='00000000-0000-0000-0000-000000000099';\n`);
    assert.match(psql(psqlPath, environment, check).stdout, /\b0\b/);
  } finally {
    try { call(pgCtl, ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch { /* cleanup only */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
});