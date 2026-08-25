import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(
  new URL('../../supabase/migrations/20260825_custom_object_foundation.sql', import.meta.url),
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

    const auditCount = run(psql, [...connectionArgs, '-t', '-A'], {
      input: `
        SELECT count(*) > 0
        FROM public.custom_object_audit_event
        WHERE tenant_id = '00000000-0000-4000-8000-000000000001'
          AND custom_object_id = '00000000-0000-4000-8000-000000000011';
      `,
    });
    assert.equal(auditCount.trim(), 't');

    run(psql, connectionArgs, {
      input: `
        ALTER TABLE public.custom_object_audit_event
        ADD CONSTRAINT custom_object_audit_reject_record
        CHECK (action <> 'record_created');
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
    assert.equal(rolledBack.trim(), '0');
  } finally {
    if (started) {
      spawnSync(pgCtl, ['-D', dataDir, '-m', 'immediate', 'stop'], {
        encoding: 'utf8',
      });
    }
    await rm(root, { recursive: true, force: true });
  }
});