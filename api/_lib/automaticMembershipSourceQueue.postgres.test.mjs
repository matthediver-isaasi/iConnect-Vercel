import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260922_automatic_membership_source_queue.sql',
  import.meta.url,
));
const automaticMembershipMigrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260820_automatic_membership.sql',
  import.meta.url,
));
const preferenceParentTriggerPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260425_zoho_pref_value_bumps_parent.sql',
  import.meta.url,
));

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

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';

const baseline = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;

  CREATE TABLE tenant(id uuid PRIMARY KEY);
  CREATE TABLE member_group(
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    name text NOT NULL,
    roles text[] NOT NULL DEFAULT ARRAY['Member']::text[]
  );
  CREATE TABLE organization(
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    name text,
    status text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE member(
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    organization_id uuid REFERENCES organization(id),
    first_name text,
    last_name text,
    email text,
    job_title text,
    role_id uuid,
    login_enabled boolean,
    communications_opted_out_all boolean,
    biography text,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE member_group_assignment(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    group_id uuid NOT NULL REFERENCES member_group(id),
    member_id uuid REFERENCES member(id) ON DELETE CASCADE,
    group_role text
  );
  CREATE UNIQUE INDEX member_group_assignment_group_member_key
    ON member_group_assignment(group_id, member_id);
  CREATE TABLE member_group_activity(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenant(id),
    member_id uuid,
    group_id uuid,
    group_name text,
    action text,
    actor_email text
  );
  CREATE TABLE preference_field(
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenant(id)
  );
  CREATE TABLE member_preference_value(
    id uuid PRIMARY KEY,
    member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
    field_id uuid NOT NULL REFERENCES preference_field(id) ON DELETE CASCADE,
    value text
  );
  CREATE TABLE organization_preference_value(
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    field_id uuid NOT NULL REFERENCES preference_field(id) ON DELETE CASCADE,
    value text
  );

  INSERT INTO tenant(id) VALUES ('${T1}'), ('${T2}');
  INSERT INTO preference_field(id, tenant_id) VALUES
    ('20000000-0000-4000-8000-000000000001', '${T1}');
`;

test('source writes queue automatic memberships across creation routes and fence stale workers', {
  timeout: 30_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'automatic-membership-source-queue-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  spawnSync('mkdir', ['-p', socket]);
  const args = [
    '-h', socket, '-p', '55445', '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q',
  ];
  let started = false;

  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p 55445`, '-w', 'start',
    ]);
    started = true;
    run(psql, args, baseline);
    run(psql, [...args, '-f', automaticMembershipMigrationPath]);
    run(psql, [...args, '-f', preferenceParentTriggerPath]);
    run(psql, [...args, '-f', migrationPath]);
    run(psql, [...args, '-f', migrationPath]);
    run(psql, args, `
      INSERT INTO member_group(
        id, tenant_id, name, automatic_membership_enabled,
        automatic_membership_role, automatic_membership_filter_groups,
        automatic_membership_sync_status, automatic_membership_generation
      ) VALUES
        (
          '10000000-0000-4000-8000-000000000001', '${T1}', 'Automatic',
          true, 'Member',
          '[{"conditions":[
            {"entity_scope":"member","field_type":"core","field_key":"email","operator":"contains","value":"example"},
            {"entity_scope":"member","field_type":"custom","field_key":"20000000-0000-4000-8000-000000000001","operator":"equals","value":"qualifying"},
            {"entity_scope":"organization","field_type":"core","field_key":"status","operator":"equals","value":"active"},
            {"entity_scope":"organization","field_type":"custom","field_key":"20000000-0000-4000-8000-000000000001","operator":"equals","value":"qualifying-org"}
          ]}]'::jsonb,
          'idle', 0
        ),
        (
          '10000000-0000-4000-8000-000000000002', '${T1}', 'Disabled',
          false, 'Member', '[]'::jsonb, 'idle', 0
        ),
        (
          '10000000-0000-4000-8000-000000000003', '${T2}', 'Other tenant',
          true, 'Member',
          '[{"conditions":[{"entity_scope":"member","field_type":"core","field_key":"email","operator":"contains","value":"example"}]}]'::jsonb,
          'idle', 0
        );
    `);

    // A set-based import statement queues once, not once per member.
    run(psql, args, `
      INSERT INTO member(id, tenant_id) VALUES
        ('30000000-0000-4000-8000-000000000001', '${T1}'),
        ('30000000-0000-4000-8000-000000000002', '${T1}');
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_sync_status || ':' ||
             automatic_membership_generation || ':' ||
             (automatic_membership_cursor IS NULL)::text
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000001';
    `), 'queued:1:true');

    // A bulk custom-field statement queues once. Parent updated_at watermarks
    // still fire per row, but irrelevant parent updates do not queue again.
    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_sync_status='running',
             automatic_membership_cursor='500'
       WHERE id='10000000-0000-4000-8000-000000000001';
      INSERT INTO member_preference_value(id, member_id, field_id, value) VALUES
        (
          '40000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'qualifying'
        ),
        (
          '40000000-0000-4000-8000-000000000002',
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          'qualifying'
        );
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_sync_status || ':' ||
             automatic_membership_generation || ':' ||
             (automatic_membership_cursor IS NULL)::text
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000001';
    `), 'queued:2:true');

    // The source write invalidated the generation captured by the old worker.
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT public.reconcile_automatic_membership(
        '10000000-0000-4000-8000-000000000001',
        '${T1}',
        'Member',
        '{}'::uuid[],
        '{}'::uuid[],
        true,
        NULL,
        0,
        1,
        NULL
      )->>'code';
    `), 'STALE_GENERATION');

    // Organization creation and custom fields follow the same source boundary.
    run(psql, args, `
      INSERT INTO organization(id, tenant_id, name, status) VALUES
        ('50000000-0000-4000-8000-000000000001', '${T1}', 'Qualifying Org', 'active');
      UPDATE member
         SET organization_id='50000000-0000-4000-8000-000000000001'
       WHERE id='30000000-0000-4000-8000-000000000001';
      INSERT INTO organization_preference_value(
        id, organization_id, field_id, value
      ) VALUES (
        '60000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        'qualifying-org'
      );
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_generation
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000001';
    `), '5');

    // Unrelated bookkeeping/profile changes must not create reconciliation work.
    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_sync_status='idle'
       WHERE id='10000000-0000-4000-8000-000000000001';
      UPDATE member SET biography='unrelated'
       WHERE id='30000000-0000-4000-8000-000000000001';
      UPDATE organization SET updated_at=now()
       WHERE id='50000000-0000-4000-8000-000000000001';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_sync_status || ':' || automatic_membership_generation
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000001';
    `), 'idle:5');

    // Disabled and foreign-tenant groups remain untouched.
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(id::text || ':' || automatic_membership_generation, ',' ORDER BY id)
        FROM member_group
       WHERE id IN (
         '10000000-0000-4000-8000-000000000002',
         '10000000-0000-4000-8000-000000000003'
       );
    `), '10000000-0000-4000-8000-000000000002:0,10000000-0000-4000-8000-000000000003:0');

    // Tenant moves queue both the source and destination tenant. Inserts and
    // deletes remain statement-batched match-all events.
    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_generation=100,
             automatic_membership_sync_status='idle'
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
      INSERT INTO member(id, tenant_id, email) VALUES
        ('30000000-0000-4000-8000-000000000003', '${T1}', 'move@example.com');
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(tenant_id::text || ':' || automatic_membership_generation, ',' ORDER BY tenant_id)
        FROM member_group
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
    `), `${T1}:101,${T2}:100`);

    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_generation=200,
             automatic_membership_sync_status='idle'
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
      UPDATE member SET tenant_id='${T2}'
       WHERE id='30000000-0000-4000-8000-000000000003';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(tenant_id::text || ':' || automatic_membership_generation, ',' ORDER BY tenant_id)
        FROM member_group
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
    `), `${T1}:201,${T2}:201`);

    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_generation=300,
             automatic_membership_sync_status='idle'
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
      INSERT INTO organization(id, tenant_id, name, status) VALUES
        ('50000000-0000-4000-8000-000000000002', '${T1}', 'Moving Org', 'active');
      UPDATE member_group
         SET automatic_membership_generation=400,
             automatic_membership_sync_status='idle'
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
      UPDATE organization SET tenant_id='${T2}'
       WHERE id='50000000-0000-4000-8000-000000000002';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(tenant_id::text || ':' || automatic_membership_generation, ',' ORDER BY tenant_id)
        FROM member_group
       WHERE id IN (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000003'
       );
    `), `${T1}:401,${T2}:401`);

    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_generation=500,
             automatic_membership_sync_status='idle'
       WHERE id='10000000-0000-4000-8000-000000000003';
      DELETE FROM member
       WHERE id='30000000-0000-4000-8000-000000000003';
      DELETE FROM organization
       WHERE id='50000000-0000-4000-8000-000000000002';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_generation
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000003';
    `), '502');

    // Malformed legacy filter JSON is ignored rather than aborting source writes.
    run(psql, args, `
      UPDATE member_group
         SET automatic_membership_filter_groups='{}'::jsonb
       WHERE id='10000000-0000-4000-8000-000000000001';
      UPDATE member_group
         SET automatic_membership_generation=700,
             automatic_membership_sync_status='idle'
       WHERE id='10000000-0000-4000-8000-000000000001';
      UPDATE member SET email='still-writes@example.com'
       WHERE id='30000000-0000-4000-8000-000000000001';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT automatic_membership_sync_status || ':' || automatic_membership_generation
        FROM member_group
       WHERE id='10000000-0000-4000-8000-000000000001';
    `), 'idle:700');

    // Migration replay leaves exactly one source trigger for every operation.
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*)
        FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname LIKE 'trg_%_auto_membership_queue_%';
    `), '12');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});

test('source queue helper is private and generation-fenced by contract', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = public, pg_temp/i);
  assert.match(sql, /automatic_membership_generation = mg\.automatic_membership_generation \+ 1/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.queue_automatic_memberships_for_source_changes\([\s\S]*FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /REFERENCING NEW TABLE AS new_rows/i);
  assert.match(sql, /REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows/i);
});