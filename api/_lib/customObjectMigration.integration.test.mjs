import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260825_custom_object_foundation.sql', import.meta.url),
);
const schemaAdminMigrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260825_custom_object_schema_admin_guards.sql', import.meta.url),
);
const relationshipRuntimeMigrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260826_custom_object_relationship_runtime.sql', import.meta.url),
);
const hardeningMigrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260827_custom_object_hardening.sql', import.meta.url),
);
const bnmsDepartmentTypeMigrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260924_bnms_department_type_normalization.sql', import.meta.url),
);
const atomicRecordCreateMigrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260925_custom_object_record_relationship_create.sql', import.meta.url),
);

function findExecutable(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(command)} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout;
}

function runFailure(command, args, expectedError, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.notEqual(result.status, 0, `${path.basename(command)} unexpectedly succeeded`);
  assert.match(result.stderr || result.stdout, expectedError);
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}

test('migration replays and persists every supported Custom Object field type', {
  timeout: 30_000,
}, async (t) => {
  const initdb = findExecutable('initdb');
  const pgCtl = findExecutable('pg_ctl');
  const psql = findExecutable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'custom-object-migration-'));
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 'socket');
  run('mkdir', ['-p', socketDir]);
  let started = false;

  const connectionArgs = [
    '-h', socketDir,
    '-p', '5432',
    '-U', 'postgres',
    '-d', 'postgres',
    '--no-psqlrc',
    '-v', 'ON_ERROR_STOP=1',
    '-q',
  ];

  try {
    run(initdb, ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', dataDir,
      '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socketDir} -c listen_addresses= -p 5432`,
      '-w',
      'start',
    ]);
    started = true;

    const baselineSql = `
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.tenant (id uuid PRIMARY KEY);
      CREATE TABLE public.role (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE
      );
      CREATE TABLE public.member (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE
      );
      CREATE TABLE public.organization (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE
      );
      CREATE TABLE public.organization_group (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE
      );
      CREATE TABLE public.preference_field (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
        name varchar(100) NOT NULL,
        label varchar(255) NOT NULL,
        field_type varchar(50) NOT NULL,
        entity_scope varchar(30),
        is_active boolean NOT NULL DEFAULT true,
        is_required boolean NOT NULL DEFAULT false,
        display_order integer NOT NULL DEFAULT 0,
        CONSTRAINT preference_field_name_key UNIQUE (name),
        CONSTRAINT preference_field_entity_scope_check
          CHECK (entity_scope IN ('member', 'organization')),
        CONSTRAINT preference_field_field_type_check
          CHECK (field_type IN (
            'text', 'email', 'url', 'date', 'boolean', 'number', 'decimal',
            'picklist', 'dropdown', 'country', 'countries', 'list', 'file'
          ))
      );
      CREATE TABLE public.member_preference_value (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        member_id uuid NOT NULL REFERENCES public.member(id) ON DELETE CASCADE,
        field_id uuid NOT NULL REFERENCES public.preference_field(id) ON DELETE CASCADE,
        value text
      );
      CREATE TABLE public.organization_preference_value (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
        field_id uuid NOT NULL REFERENCES public.preference_field(id) ON DELETE CASCADE,
        value text
      );
      CREATE TABLE public.organization_group_preference_value (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_group_id uuid NOT NULL REFERENCES public.organization_group(id) ON DELETE CASCADE,
        field_id uuid NOT NULL REFERENCES public.preference_field(id) ON DELETE CASCADE,
        value text
      );
    `;
    run(psql, connectionArgs, { input: baselineSql });
    run(psql, [...connectionArgs, '-f', migrationPath]);
    run(psql, [...connectionArgs, '-f', migrationPath]);
    run(psql, [...connectionArgs, '-f', schemaAdminMigrationPath]);
    run(psql, [...connectionArgs, '-f', schemaAdminMigrationPath]);
    run(psql, [...connectionArgs, '-f', relationshipRuntimeMigrationPath]);
    run(psql, [...connectionArgs, '-f', relationshipRuntimeMigrationPath]);
    run(psql, [...connectionArgs, '-f', hardeningMigrationPath]);
    run(psql, [...connectionArgs, '-f', hardeningMigrationPath]);
    run(psql, [...connectionArgs, '-f', atomicRecordCreateMigrationPath]);
    run(psql, [...connectionArgs, '-f', atomicRecordCreateMigrationPath]);

    run(psql, connectionArgs, {
      input: `
        INSERT INTO public.tenant(id)
        VALUES ('ff2df806-b321-4254-b651-3af11fccf1db');
        INSERT INTO public.custom_object_definition(
          id, tenant_id, object_key, singular_label, plural_label
        ) VALUES (
          '00000000-0000-4000-8000-000000000099',
          'ff2df806-b321-4254-b651-3af11fccf1db',
          'org_department', 'Department', 'Departments'
        );
        INSERT INTO public.preference_field(
          id, tenant_id, name, label, field_type, entity_scope,
          custom_object_id, is_active
        ) VALUES (
          '10000000-0000-4000-8000-000000000099',
          'ff2df806-b321-4254-b651-3af11fccf1db',
          'name', 'Name', 'text', 'custom_object',
          '00000000-0000-4000-8000-000000000099', true
        );
        UPDATE public.custom_object_definition
        SET primary_display_field_id = '10000000-0000-4000-8000-000000000099',
            status = 'active'
        WHERE id = '00000000-0000-4000-8000-000000000099';
      `,
    });
    runFailure(
      psql,
      connectionArgs,
      /Existing active BNMS Department Type object has no approved name field/,
      {
        input: `
          BEGIN;
          INSERT INTO public.custom_object_definition(
            id, tenant_id, object_key, singular_label, plural_label
          ) VALUES (
            '00000000-0000-4000-8000-000000000098',
            'ff2df806-b321-4254-b651-3af11fccf1db',
            'department_type', 'Department Type', 'Department Types'
          );
          INSERT INTO public.preference_field(
            id, tenant_id, name, label, field_type, entity_scope,
            custom_object_id, is_active
          ) VALUES (
            '10000000-0000-4000-8000-000000000098',
            'ff2df806-b321-4254-b651-3af11fccf1db',
            'code', 'Code', 'text', 'custom_object',
            '00000000-0000-4000-8000-000000000098', true
          );
          UPDATE public.custom_object_definition
          SET primary_display_field_id = '10000000-0000-4000-8000-000000000098',
              status = 'active'
          WHERE id = '00000000-0000-4000-8000-000000000098';
          \\i '${bnmsDepartmentTypeMigrationPath}'
        `,
      },
    );
    run(psql, [...connectionArgs, '-f', bnmsDepartmentTypeMigrationPath]);
    run(psql, [...connectionArgs, '-f', bnmsDepartmentTypeMigrationPath]);
    for (const mismatch of [
      'show_on_source = false',
      'show_on_target = false',
      'edit_from_source = false',
      'edit_from_target = false',
      `configuration = '{"picker_scope":{"unexpected":true}}'::jsonb`,
    ]) {
      runFailure(
        psql,
        connectionArgs,
        /Existing BNMS Department Type relationship is incompatible/,
        {
          input: `
            BEGIN;
            UPDATE public.custom_object_relationship_definition
            SET ${mismatch}
            WHERE tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'
              AND relationship_key = 'department_type';
            \\i '${bnmsDepartmentTypeMigrationPath}'
          `,
        },
      );
    }
    const normalizedSchema = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT
          count(DISTINCT object_definition.id) || ':' ||
          count(DISTINCT field.id) || ':' ||
          count(DISTINCT relationship.id)
        FROM public.custom_object_definition object_definition
        JOIN public.preference_field field
          ON field.tenant_id = object_definition.tenant_id
         AND field.custom_object_id = object_definition.id
         AND field.name = 'name'
         AND field.is_active
        JOIN public.custom_object_relationship_definition relationship
          ON relationship.tenant_id = object_definition.tenant_id
         AND relationship.relationship_key = 'department_type'
         AND relationship.target_custom_object_id = object_definition.id
         AND relationship.cardinality = 'many_to_one'
         AND relationship.is_required
         AND relationship.status = 'active'
        WHERE object_definition.tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'
          AND object_definition.object_key = 'department_type'
          AND object_definition.status = 'active'
          AND object_definition.primary_display_field_id = field.id;
      `,
    });
    assert.equal(normalizedSchema.trim(), '1:1:1');

    const fieldTypes = [
      'text',
      'textarea',
      'email',
      'url',
      'date',
      'boolean',
      'number',
      'decimal',
      'picklist',
      'dropdown',
      'country',
      'countries',
      'list',
      'file',
    ];
    const values = fieldTypes.map((fieldType, index) => (
      `(
        '10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}',
        '00000000-0000-4000-8000-000000000001',
        'field_${index + 1}',
        '${fieldType}',
        '${fieldType}',
        'custom_object',
        '00000000-0000-4000-8000-000000000011'
      )`
    )).join(',\n');
    const insertSql = `
      INSERT INTO public.tenant(id)
      VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO public.custom_object_definition(
        id, tenant_id, object_key, singular_label, plural_label, created_by
      ) VALUES (
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000001',
        'asset',
        'Asset',
        'Assets',
        'server-admin'
      );
      INSERT INTO public.preference_field(
        id, tenant_id, name, label, field_type, entity_scope, custom_object_id
      ) VALUES ${values};
      SELECT count(*) FROM public.preference_field
      WHERE custom_object_id = '00000000-0000-4000-8000-000000000011';
    `;
    const output = run(psql, [...connectionArgs, '-t', '-A'], { input: insertSql });
    assert.equal(output.trim(), String(fieldTypes.length));

    run(psql, connectionArgs, {
      input: `
        UPDATE public.custom_object_definition
        SET primary_display_field_id = '10000000-0000-4000-8000-000000000001',
            status = 'active'
        WHERE id = '00000000-0000-4000-8000-000000000011';
      `,
    });
    runFailure(
      psql,
      connectionArgs,
      /Active Custom Objects cannot return to draft/,
      {
        input: `
          UPDATE public.custom_object_definition
          SET status = 'draft'
          WHERE id = '00000000-0000-4000-8000-000000000011';
        `,
      },
    );
    runFailure(
      psql,
      connectionArgs,
      /primary display field of an active Custom Object cannot be deactivated/,
      {
        input: `
          UPDATE public.preference_field
          SET is_active = false
          WHERE id = '10000000-0000-4000-8000-000000000001';
        `,
      },
    );

    const switchedPrimary = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        UPDATE public.custom_object_definition
        SET primary_display_field_id = '10000000-0000-4000-8000-000000000002'
        WHERE id = '00000000-0000-4000-8000-000000000011';
        UPDATE public.preference_field
        SET is_active = false
        WHERE id = '10000000-0000-4000-8000-000000000001';
        SELECT is_active
        FROM public.preference_field
        WHERE id = '10000000-0000-4000-8000-000000000001';
      `,
    });
    assert.equal(switchedPrimary.trim(), 'f');

    const classifiedActor = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        UPDATE public.preference_field
        SET label = 'Updated text',
            updated_by = 'tenant_user:admin-42'
        WHERE id = '10000000-0000-4000-8000-000000000001';
        SELECT actor_id || ':' || actor_type
        FROM public.custom_object_audit_event
        WHERE actor_id = 'admin-42';
      `,
    });
    assert.equal(classifiedActor.trim(), 'admin-42:tenant_user');

    run(psql, connectionArgs, {
      input: `
        INSERT INTO public.member(id, tenant_id)
        VALUES (
          '00000000-0000-4000-8000-000000000021',
          '00000000-0000-4000-8000-000000000001'
        );
        INSERT INTO public.preference_field(
          id, tenant_id, name, label, field_type, entity_scope
        ) VALUES (
          '00000000-0000-4000-8000-000000000031',
          '00000000-0000-4000-8000-000000000001',
          'core_note',
          'Core note',
          'text',
          'member'
        );
        INSERT INTO public.member_preference_value(member_id, field_id, value)
        VALUES (
          '00000000-0000-4000-8000-000000000021',
          '00000000-0000-4000-8000-000000000031',
          'allowed'
        );
      `,
    });
    runFailure(
      psql,
      connectionArgs,
      /Custom Object fields cannot be stored in core preference value tables/,
      {
        input: `
          INSERT INTO public.member_preference_value(member_id, field_id, value)
          VALUES (
            '00000000-0000-4000-8000-000000000021',
            '10000000-0000-4000-8000-000000000002',
            'blocked'
          );
        `,
      },
    );

    // Build two active same-tenant endpoints plus a foreign-tenant endpoint.
    run(psql, connectionArgs, {
      input: `
        INSERT INTO public.tenant(id) VALUES ('00000000-0000-4000-8000-000000000002');
        INSERT INTO public.custom_object_definition(id, tenant_id, object_key, singular_label, plural_label)
        VALUES
          ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','location','Location','Locations'),
          ('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000002','foreign_asset','Foreign asset','Foreign assets');
        INSERT INTO public.preference_field(id, tenant_id, name, label, field_type, entity_scope, custom_object_id)
        VALUES
          ('10000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001','location_name','Name','text','custom_object','00000000-0000-4000-8000-000000000012'),
          ('10000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002','foreign_name','Name','text','custom_object','00000000-0000-4000-8000-000000000013');
        UPDATE public.custom_object_definition SET
          primary_display_field_id = CASE id
            WHEN '00000000-0000-4000-8000-000000000012' THEN '10000000-0000-4000-8000-000000000020'::uuid
            ELSE '10000000-0000-4000-8000-000000000021'::uuid END,
          status = 'active'
        WHERE id IN ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013');
        INSERT INTO public.custom_object_record(id, tenant_id, custom_object_id, data) VALUES
          ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','{"field_2":"A1"}'),
          ('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','{"field_2":"A2"}'),
          ('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','{"field_2":"A3"}'),
          ('20000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','{"location_name":"B1"}'),
          ('20000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','{"location_name":"B2"}'),
          ('20000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','{"location_name":"B3"}'),
          ('20000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','{"location_name":"B4"}'),
          ('20000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000013','{"foreign_name":"C1"}');
        INSERT INTO public.custom_object_relationship_definition(
          id, tenant_id, relationship_key, source_kind, source_custom_object_id,
          target_kind, target_custom_object_id, cardinality, source_label, target_label, is_required, status
        ) VALUES
          ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','matrix_one_one','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','one_to_one','Locations','Assets',false,'active'),
          ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','matrix_one_many','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','one_to_many','Locations','Asset',false,'active'),
          ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','matrix_many_one','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','many_to_one','Location','Assets',false,'active'),
          ('30000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','matrix_many_many','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','many_to_many','Locations','Assets',false,'active'),
          ('30000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','matrix_required','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','many_to_many','Locations','Assets',true,'active'),
          ('30000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','matrix_self','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000011','many_to_many','Related assets','Related assets',false,'active'),
          ('30000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','matrix_reciprocal','custom_object','00000000-0000-4000-8000-000000000012','custom_object','00000000-0000-4000-8000-000000000011','many_to_many','Assets','Locations',false,'active'),
          ('30000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','matrix_archived','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','many_to_many','Locations','Assets',false,'archived'),
          ('30000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','matrix_concurrent','custom_object','00000000-0000-4000-8000-000000000011','custom_object','00000000-0000-4000-8000-000000000012','one_to_one','Location','Asset',false,'active');
      `,
    });

    const edge = (definition, source, target, id = null) => `
      INSERT INTO public.custom_object_relationship(
        ${id ? 'id, ' : ''}tenant_id, relationship_definition_id, source_record_id, target_record_id
      ) VALUES (${id ? `'${id}', ` : ''}'00000000-0000-4000-8000-000000000001',
        '${definition}', '${source}', '${target}');`;
    const [a1, a2, a3] = [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
    ];
    const [b1, b2, b3] = [
      '20000000-0000-4000-8000-000000000011',
      '20000000-0000-4000-8000-000000000012',
      '20000000-0000-4000-8000-000000000013',
    ];
    const [oneOne, oneMany, manyOne, manyMany] = [
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000004',
    ];

    run(psql, connectionArgs, { input: edge(oneOne, a1, b1) });
    runFailure(psql, connectionArgs, /Source record exceeds relationship cardinality/, { input: edge(oneOne, a1, b2) });
    runFailure(psql, connectionArgs, /Target record exceeds relationship cardinality/, { input: edge(oneOne, a2, b1) });
    run(psql, connectionArgs, { input: edge(oneMany, a1, b1) + edge(oneMany, a1, b2) });
    runFailure(psql, connectionArgs, /Target record exceeds relationship cardinality/, { input: edge(oneMany, a2, b1) });
    run(psql, connectionArgs, { input: edge(manyOne, a1, b1) + edge(manyOne, a2, b1) });
    runFailure(psql, connectionArgs, /Source record exceeds relationship cardinality/, { input: edge(manyOne, a1, b2) });
    run(psql, connectionArgs, { input: edge(manyMany, a1, b1) + edge(manyMany, a1, b2) + edge(manyMany, a2, b1) });
    runFailure(psql, connectionArgs, /custom_object_relationship_active_pair_unique/, { input: edge(manyMany, a1, b1) });

    const requiredFirst = '40000000-0000-4000-8000-000000000001';
    const requiredSecond = '40000000-0000-4000-8000-000000000002';
    run(psql, connectionArgs, {
      input: edge('30000000-0000-4000-8000-000000000005', a3, b3, requiredFirst),
    });
    runFailure(psql, connectionArgs, /required relationship cannot lose its final active edge/i, {
      input: `SELECT public.archive_custom_object_relationship(
        '00000000-0000-4000-8000-000000000001','${requiredFirst}','test',now());`,
    });
    run(psql, connectionArgs, {
      input: edge('30000000-0000-4000-8000-000000000005', a3, b2, requiredSecond)
        + `SELECT public.archive_custom_object_relationship(
          '00000000-0000-4000-8000-000000000001','${requiredFirst}','test',now());`,
    });
    runFailure(psql, connectionArgs, /required relationship cannot lose its final active edge/i, {
      input: `SELECT public.archive_custom_object_relationship(
        '00000000-0000-4000-8000-000000000001','${requiredSecond}','test',now());`,
    });

    const requiredThird = '40000000-0000-4000-8000-000000000004';
    run(psql, connectionArgs, {
      input: edge('30000000-0000-4000-8000-000000000005', a3, b1, requiredThird),
    });
    const removeOne = runAsync(psql, connectionArgs, {
      input: `BEGIN; SELECT public.archive_custom_object_relationship(
        '00000000-0000-4000-8000-000000000001','${requiredSecond}','session-one',now());
        SELECT pg_sleep(1); COMMIT;`,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const removeFinal = runAsync(psql, connectionArgs, {
      input: `SELECT public.archive_custom_object_relationship(
        '00000000-0000-4000-8000-000000000001','${requiredThird}','session-two',now());`,
    });
    const [removeOneResult, removeFinalResult] = await Promise.all([removeOne, removeFinal]);
    assert.equal(removeOneResult.status, 0, removeOneResult.stderr);
    assert.notEqual(removeFinalResult.status, 0, 'concurrent final-edge removal unexpectedly succeeded');
    assert.match(removeFinalResult.stderr, /required relationship cannot lose its final active edge/i);

    // Archiving a target with the final required edge rolls back. Archiving its
    // source then retires every incident edge and preserves edge audit rows.
    runFailure(psql, connectionArgs, /required relationship cannot lose its final active edge/i, {
      input: `UPDATE public.custom_object_record SET archived_at=now()
        WHERE id='${b1}';`,
    });
    const targetStillActive = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `SELECT archived_at IS NULL FROM public.custom_object_record WHERE id='${b1}';`,
    });
    assert.equal(targetStillActive.trim(), 't');
    run(psql, connectionArgs, {
      input: `UPDATE public.custom_object_record SET archived_at=now(), archived_by='source-retired'
        WHERE id='${a3}';`,
    });
    const danglingAndAudited = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT
          count(*) FILTER (WHERE relationship.archived_at IS NULL) || ':' ||
          count(*) FILTER (WHERE audit.action = 'relationship_archived')
        FROM public.custom_object_relationship relationship
        JOIN public.custom_object_relationship_definition definition
          ON definition.id = relationship.relationship_definition_id
        LEFT JOIN public.custom_object_audit_event audit
          ON audit.relationship_id = relationship.id
         AND audit.action = 'relationship_archived'
        WHERE relationship.tenant_id='00000000-0000-4000-8000-000000000001'
          AND (
            (definition.source_custom_object_id='00000000-0000-4000-8000-000000000011'
             AND relationship.source_record_id='${a3}')
            OR
            (definition.target_custom_object_id='00000000-0000-4000-8000-000000000011'
             AND relationship.target_record_id='${a3}')
          );`,
    });
    const [dangling, cascadedAudits] = danglingAndAudited.trim().split(':').map(Number);
    assert.equal(dangling, 0);
    assert.ok(cascadedAudits > 0);

    // Circular/self and reciprocal Custom Object definitions are legal.
    run(psql, connectionArgs, {
      input: edge('30000000-0000-4000-8000-000000000006', a1, a2)
        + edge('30000000-0000-4000-8000-000000000007', b1, a1),
    });
    runFailure(psql, connectionArgs, /Relationship definition is not active/, {
      input: edge('30000000-0000-4000-8000-000000000008', a1, b1),
    });

    // Archived edges no longer participate in uniqueness.
    const archivedEdge = '40000000-0000-4000-8000-000000000003';
    run(psql, connectionArgs, {
      input: edge(manyMany, a1, b3, archivedEdge)
        + `UPDATE public.custom_object_relationship SET archived_at=now() WHERE id='${archivedEdge}';`
        + edge(manyMany, a1, b3),
    });
    runFailure(psql, connectionArgs, /Target relationship record does not exist/, {
      input: edge(manyMany, a1, '20000000-0000-4000-8000-000000000021'),
    });
    runFailure(psql, connectionArgs, /Target relationship record does not exist/, {
      input: edge(manyMany, a1, '29999999-9999-4999-8999-999999999999'),
    });
    run(psql, connectionArgs, {
      input: `UPDATE public.custom_object_record SET archived_at=now()
        WHERE id='20000000-0000-4000-8000-000000000014';`,
    });
    runFailure(psql, connectionArgs, /Target relationship record does not exist/, {
      input: edge(manyMany, a1, '20000000-0000-4000-8000-000000000014'),
    });

    // A real pair of PostgreSQL sessions verifies the advisory lock closes the
    // check/insert race instead of merely testing sequential conflicts.
    const concurrentDefinition = '30000000-0000-4000-8000-000000000009';
    const firstAttempt = runAsync(psql, connectionArgs, {
      input: `BEGIN; ${edge(concurrentDefinition, a2, b2)} SELECT pg_sleep(1); COMMIT;`,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const secondAttempt = runAsync(psql, connectionArgs, {
      input: edge(concurrentDefinition, a2, b3),
    });
    const [firstResult, secondResult] = await Promise.all([firstAttempt, secondAttempt]);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    assert.notEqual(secondResult.status, 0, 'concurrent cardinality insert unexpectedly succeeded');
    assert.match(secondResult.stderr, /Source record exceeds relationship cardinality/);

    // The atomic-create RPC uses generic Custom Object fixtures, rather than
    // the BNMS schema above. It must accept both endpoint orientations and
    // apply originating-card edit rules while creating all initial edges.
    const atomicTenant = '00000000-0000-4000-8000-000000000001';
    const atomicAsset = '00000000-0000-4000-8000-000000000041';
    const atomicLocation = '00000000-0000-4000-8000-000000000042';
    const atomicRequired = '30000000-0000-4000-8000-000000000041';
    const atomicReverse = '30000000-0000-4000-8000-000000000042';
    const atomicOriginating = '30000000-0000-4000-8000-000000000043';
    const atomicCardinality = '30000000-0000-4000-8000-000000000044';
    const atomicTargets = [
      '20000000-0000-4000-8000-000000000041',
      '20000000-0000-4000-8000-000000000042',
      '20000000-0000-4000-8000-000000000043',
      '20000000-0000-4000-8000-000000000044',
    ];
    const atomicSeed = '20000000-0000-4000-8000-000000000045';
    run(psql, connectionArgs, {
      input: `
        INSERT INTO public.custom_object_definition(id, tenant_id, object_key, singular_label, plural_label)
        VALUES
          ('${atomicAsset}', '${atomicTenant}', 'atomic_asset', 'Atomic asset', 'Atomic assets'),
          ('${atomicLocation}', '${atomicTenant}', 'atomic_location', 'Atomic location', 'Atomic locations');
        INSERT INTO public.preference_field(
          id, tenant_id, name, label, field_type, entity_scope, custom_object_id
        ) VALUES
          ('10000000-0000-4000-8000-000000000041', '${atomicTenant}', 'atomic_asset_name', 'Name', 'text', 'custom_object', '${atomicAsset}'),
          ('10000000-0000-4000-8000-000000000042', '${atomicTenant}', 'atomic_location_name', 'Name', 'text', 'custom_object', '${atomicLocation}');
        UPDATE public.custom_object_definition
        SET primary_display_field_id = CASE id
              WHEN '${atomicAsset}' THEN '10000000-0000-4000-8000-000000000041'::uuid
              ELSE '10000000-0000-4000-8000-000000000042'::uuid
            END,
            status = 'active'
        WHERE id IN ('${atomicAsset}', '${atomicLocation}');
        INSERT INTO public.custom_object_record(id, tenant_id, custom_object_id, data)
        VALUES
          ('${atomicTargets[0]}', '${atomicTenant}', '${atomicLocation}', '{"atomic_location_name":"L1"}'),
          ('${atomicTargets[1]}', '${atomicTenant}', '${atomicLocation}', '{"atomic_location_name":"L2"}'),
          ('${atomicTargets[2]}', '${atomicTenant}', '${atomicLocation}', '{"atomic_location_name":"L3"}'),
          ('${atomicTargets[3]}', '${atomicTenant}', '${atomicLocation}', '{"atomic_location_name":"L4"}'),
          ('${atomicSeed}', '${atomicTenant}', '${atomicAsset}', '{"atomic_asset_name":"seed"}');
        INSERT INTO public.custom_object_relationship_definition(
          id, tenant_id, relationship_key, source_kind, source_custom_object_id,
          target_kind, target_custom_object_id, cardinality, source_label, target_label,
          is_required, show_on_source, show_on_target, edit_from_source, edit_from_target, status
        ) VALUES
          ('${atomicRequired}', '${atomicTenant}', 'atomic_required', 'custom_object', '${atomicAsset}', 'custom_object', '${atomicLocation}', 'many_to_many', 'Locations', 'Assets', true, true, true, true, false, 'active'),
          ('${atomicReverse}', '${atomicTenant}', 'atomic_reverse', 'custom_object', '${atomicLocation}', 'custom_object', '${atomicAsset}', 'many_to_many', 'Assets', 'Locations', false, true, true, true, false, 'active'),
          ('${atomicOriginating}', '${atomicTenant}', 'atomic_originating', 'custom_object', '${atomicAsset}', 'custom_object', '${atomicLocation}', 'many_to_many', 'Origin locations', 'Origin assets', false, true, true, true, true, 'active'),
          ('${atomicCardinality}', '${atomicTenant}', 'atomic_cardinality', 'custom_object', '${atomicAsset}', 'custom_object', '${atomicLocation}', 'one_to_many', 'Single location', 'Assets', false, true, true, true, false, 'active');
        INSERT INTO public.custom_object_relationship(
          tenant_id, relationship_definition_id, source_record_id, target_record_id, created_by
        ) VALUES (
          '${atomicTenant}', '${atomicCardinality}', '${atomicSeed}', '${atomicTargets[0]}', 'atomic-seed'
        );
      `,
    });

    const atomicSuccess = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT jsonb_array_length(result->'relationships') || ':' ||
               (result->'record'->>'created_by')
        FROM public.create_custom_object_record_with_relationships(
          '${atomicTenant}', '${atomicAsset}', '{"atomic_asset_name":"complete"}',
          '[
            {"relationship_definition_id":"${atomicRequired}","related_record_id":"${atomicTargets[0]}","routed_side":"source"},
            {"relationship_definition_id":"${atomicReverse}","related_record_id":"${atomicTargets[1]}","routed_side":"target","originating":true},
            {"relationship_definition_id":"${atomicOriginating}","related_record_id":"${atomicTargets[2]}","routed_side":"source","originating":true}
          ]'::jsonb, 'atomic-success'
        ) result;
      `,
    });
    assert.equal(atomicSuccess.trim(), '3:atomic-success');

    const mutationCounts = () => run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT
          (SELECT count(*) FROM public.custom_object_record WHERE data ? 'atomic_attempt') || ':' ||
          (SELECT count(*) FROM public.custom_object_relationship WHERE created_by IN ('atomic-missing', 'atomic-cardinality')) || ':' ||
          (SELECT count(*) FROM public.custom_object_audit_event WHERE actor_id IN ('atomic-missing', 'atomic-cardinality'));
      `,
    }).trim();
    const beforeFailures = mutationCounts();
    runFailure(psql, connectionArgs, /A required relationship must be supplied/, {
      input: `
        SELECT public.create_custom_object_record_with_relationships(
          '${atomicTenant}', '${atomicAsset}', '{"atomic_attempt":"missing"}',
          '[{"relationship_definition_id":"${atomicOriginating}","related_record_id":"${atomicTargets[1]}","routed_side":"source"}]'::jsonb,
          'atomic-missing'
        );
      `,
    });
    assert.equal(mutationCounts(), beforeFailures, 'missing required edge must roll back records, edges, and audit rows');

    runFailure(psql, connectionArgs, /Target record exceeds relationship cardinality/, {
      input: `
        SELECT public.create_custom_object_record_with_relationships(
          '${atomicTenant}', '${atomicAsset}', '{"atomic_attempt":"cardinality"}',
          '[
            {"relationship_definition_id":"${atomicRequired}","related_record_id":"${atomicTargets[1]}","routed_side":"source"},
            {"relationship_definition_id":"${atomicCardinality}","related_record_id":"${atomicTargets[0]}","routed_side":"source"}
          ]'::jsonb, 'atomic-cardinality'
        );
      `,
    });
    assert.equal(mutationCounts(), beforeFailures, 'a later invalid edge must roll back preceding mutations');

    const retryAfterFailure = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT jsonb_array_length(result->'relationships')
        FROM public.create_custom_object_record_with_relationships(
          '${atomicTenant}', '${atomicAsset}', '{"atomic_attempt":"retry"}',
          '[
            {"relationship_definition_id":"${atomicRequired}","related_record_id":"${atomicTargets[1]}","routed_side":"source"},
            {"relationship_definition_id":"${atomicCardinality}","related_record_id":"${atomicTargets[2]}","routed_side":"source"}
          ]'::jsonb, 'atomic-cardinality'
        ) result;
      `,
    });
    assert.equal(retryAfterFailure.trim(), '2');

    // Concurrent requests serialize on the new record's object and the edge
    // cardinality lock; only the first may claim this one-to-many target.
    const concurrentAtomicOne = runAsync(psql, connectionArgs, {
      input: `BEGIN; SELECT public.create_custom_object_record_with_relationships(
        '${atomicTenant}', '${atomicAsset}', '{"atomic_attempt":"concurrent-one"}',
        '[{"relationship_definition_id":"${atomicRequired}","related_record_id":"${atomicTargets[3]}","routed_side":"source"},{"relationship_definition_id":"${atomicCardinality}","related_record_id":"${atomicTargets[3]}","routed_side":"source"}]'::jsonb,
        'atomic-concurrent-one'
      ); SELECT pg_sleep(1); COMMIT;`,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const concurrentAtomicTwo = runAsync(psql, connectionArgs, {
      input: `SELECT public.create_custom_object_record_with_relationships(
        '${atomicTenant}', '${atomicAsset}', '{"atomic_attempt":"concurrent-two"}',
        '[{"relationship_definition_id":"${atomicRequired}","related_record_id":"${atomicTargets[2]}","routed_side":"source"},{"relationship_definition_id":"${atomicCardinality}","related_record_id":"${atomicTargets[3]}","routed_side":"source"}]'::jsonb,
        'atomic-concurrent-two'
      );`,
    });
    const [concurrentAtomicOneResult, concurrentAtomicTwoResult] = await Promise.all([
      concurrentAtomicOne,
      concurrentAtomicTwo,
    ]);
    assert.equal(concurrentAtomicOneResult.status, 0, concurrentAtomicOneResult.stderr);
    assert.notEqual(concurrentAtomicTwoResult.status, 0, 'concurrent atomic cardinality request unexpectedly succeeded');
    assert.match(concurrentAtomicTwoResult.stderr, /Target record exceeds relationship cardinality/);

    // Archiving an endpoint object atomically retires every incident definition
    // and active edge while preserving both kinds of rows for audit review.
    run(psql, connectionArgs, {
      input: `
        UPDATE public.custom_object_definition
        SET status='archived',
            archived_at='2026-09-01T12:34:56Z',
            archived_by='tenant_user:object-retirer',
            updated_by='tenant_user:object-retirer'
        WHERE id='00000000-0000-4000-8000-000000000012';`,
    });
    const objectRetirement = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        WITH incident AS (
          SELECT definition.*
          FROM public.custom_object_relationship_definition definition
          WHERE definition.tenant_id='00000000-0000-4000-8000-000000000001'
            AND (
              definition.source_custom_object_id='00000000-0000-4000-8000-000000000012'
              OR definition.target_custom_object_id='00000000-0000-4000-8000-000000000012'
            )
        )
        SELECT
          count(*) || ':' ||
          count(*) FILTER (WHERE status <> 'archived') || ':' ||
          count(*) FILTER (
            WHERE archived_at <> '2026-09-01T12:34:56Z'::timestamptz
              AND relationship_key <> 'matrix_archived'
          ) || ':' ||
          count(*) FILTER (
            WHERE archived_by <> 'tenant_user:object-retirer'
              AND relationship_key <> 'matrix_archived'
          ) || ':' ||
          (SELECT count(*) FROM public.custom_object_relationship relationship
           JOIN incident ON incident.id=relationship.relationship_definition_id
           WHERE relationship.archived_at IS NULL) || ':' ||
          (SELECT count(*) FROM public.custom_object_audit_event audit
           JOIN incident ON incident.id=audit.relationship_definition_id
           WHERE audit.action='relationship_definition_archived') || ':' ||
          (SELECT count(*) FROM public.custom_object_audit_event audit
           JOIN public.custom_object_relationship relationship
             ON relationship.id=audit.relationship_id
           JOIN incident ON incident.id=relationship.relationship_definition_id
           WHERE audit.action='relationship_archived')
        FROM incident;`,
    });
    const [
      reviewableDefinitions,
      activeDefinitions,
      inconsistentArchiveTimes,
      inconsistentActors,
      activeIncidentEdges,
      definitionArchiveAudits,
      edgeArchiveAudits,
    ] = objectRetirement.trim().split(':').map(Number);
    assert.equal(reviewableDefinitions, 8);
    assert.equal(activeDefinitions, 0);
    assert.equal(inconsistentArchiveTimes, 0);
    assert.equal(inconsistentActors, 0);
    assert.equal(activeIncidentEdges, 0);
    assert.equal(definitionArchiveAudits, 7);
    assert.ok(edgeArchiveAudits > 0);

    const activeDefinitionsWithArchivedEndpoints = run(
      psql,
      [...connectionArgs, '-t', '-A'],
      {
        input: `
          SELECT count(*)
          FROM public.custom_object_relationship_definition definition
          LEFT JOIN public.custom_object_definition source_object
            ON source_object.tenant_id=definition.tenant_id
           AND source_object.id=definition.source_custom_object_id
          LEFT JOIN public.custom_object_definition target_object
            ON target_object.tenant_id=definition.tenant_id
           AND target_object.id=definition.target_custom_object_id
          WHERE definition.status <> 'archived'
            AND (
              (definition.source_kind='custom_object' AND source_object.status='archived')
              OR
              (definition.target_kind='custom_object' AND target_object.status='archived')
            );`,
      },
    );
    assert.equal(activeDefinitionsWithArchivedEndpoints.trim(), '0');

    const auditCount = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT count(*) > 0
        FROM public.custom_object_audit_event
        WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
          AND custom_object_id = '00000000-0000-4000-8000-000000000011';
      `,
    });
    assert.equal(auditCount.trim(), 't');

    const recordCountBeforeRejectedAudit = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT count(*)
        FROM public.custom_object_record
        WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
      `,
    }).trim();
    run(psql, connectionArgs, {
      input: `
        ALTER TABLE public.custom_object_audit_event
        ADD CONSTRAINT custom_object_audit_reject_record
        CHECK (action <> 'record_created') NOT VALID;
      `,
    });
    runFailure(
      psql,
      connectionArgs,
      /custom_object_audit_reject_record/,
      {
        input: `
          INSERT INTO public.custom_object_record(
            tenant_id, custom_object_id, data, created_by
          ) VALUES (
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000011',
            '{"field_2":"should roll back"}'::jsonb,
            'server-admin'
          );
        `,
      },
    );
    const rolledBack = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT count(*)
        FROM public.custom_object_record
        WHERE tenant_id = '00000000-0000-4000-8000-000000000001';
      `,
    });
    assert.equal(rolledBack.trim(), recordCountBeforeRejectedAudit);
  } finally {
    if (started) {
      spawnSync(pgCtl, ['-D', dataDir, '-m', 'immediate', 'stop'], {
        encoding: 'utf8',
      });
    }
    await rm(root, { recursive: true, force: true });
  }
});