import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const publishPath = fileURLToPath(new URL(
  './001-publish.sql',
  import.meta.url,
));
const canvasPath = fileURLToPath(new URL(
  './002-canvas.sql',
  import.meta.url,
));
const fencePath = fileURLToPath(new URL(
  './003-microsite-fence.sql',
  import.meta.url,
));
const manifestPath = fileURLToPath(new URL(
  './manifest.json',
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
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runResult(command, args, input = '') {
  return spawnSync(command, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

const TENANT = '00000000-0000-4000-8000-000000000001';
const SOURCE = '10000000-0000-4000-8000-000000000001';
const RICH_SOURCE = '10000000-0000-4000-8000-000000000002';
const SYMBOL = '20000000-0000-4000-8000-000000000001';
const MISSING_SYMBOL = '20000000-0000-4000-8000-000000000099';
const SITE = '30000000-0000-4000-8000-000000000001';

const baseline = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;

  CREATE TABLE member_content_source (
    tenant_id uuid NOT NULL,
    content_type text NOT NULL,
    source_id uuid NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    active_generation bigint,
    claim_token uuid,
    claim_started_at timestamp,
    PRIMARY KEY (tenant_id, content_type, source_id)
  );

  CREATE TABLE member_content_chunk (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    content_type text NOT NULL,
    source_id uuid NOT NULL,
    slug text,
    title text NOT NULL,
    chunk_index integer NOT NULL,
    content text NOT NULL,
    link text,
    status text,
    event_state text,
    member_group_id uuid,
    group_event_public boolean,
    allowed_role_ids uuid[],
    is_public boolean,
    published_date timestamptz,
    start_date timestamptz,
    feature_key text,
    content_hash text NOT NULL DEFAULT '',
    embedding text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    source_generation bigint NOT NULL,
    activation_token uuid,
    is_active boolean NOT NULL DEFAULT false,
    access_scope text DEFAULT 'public',
    linked_events jsonb,
    subcategories text[],
    layout_type text,
    microsite_id uuid,
    source_updated_at timestamptz,
    symbol_versions jsonb,
    provenance jsonb DEFAULT '{}'::jsonb,
    embedding_model text
  );

  CREATE TABLE member_content_reindex_job (
    tenant_id uuid NOT NULL,
    content_type text NOT NULL,
    source_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, content_type, source_id)
  );

  CREATE TABLE microsite (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    path_prefix text NOT NULL,
    is_active boolean NOT NULL DEFAULT true
  );

  CREATE TABLE i_edit_page (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    microsite_id uuid REFERENCES microsite(id) ON DELETE SET NULL,
    builder_type text NOT NULL
  );

  CREATE OR REPLACE FUNCTION invalidate_member_content_source(
    p_tenant_id uuid,
    p_content_type text,
    p_source_id uuid
  ) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    UPDATE member_content_source
       SET generation = generation + 1,
           claim_token = NULL,
           claim_started_at = NULL
     WHERE tenant_id = p_tenant_id
       AND content_type = p_content_type
       AND source_id = p_source_id;
    INSERT INTO member_content_reindex_job(tenant_id, content_type, source_id)
    VALUES (p_tenant_id, p_content_type, p_source_id)
    ON CONFLICT (tenant_id, content_type, source_id) DO NOTHING;
  END;
  $$;

  INSERT INTO member_content_source(
    tenant_id, content_type, source_id, generation
  ) VALUES
    ('${TENANT}', 'canvas_page', '${SOURCE}', 1),
    ('${TENANT}', 'canvas_page', '${RICH_SOURCE}', 1),
    ('${TENANT}', 'canvas_symbol', '${SYMBOL}', 7);
  INSERT INTO microsite(id, tenant_id, path_prefix, is_active)
  VALUES ('${SITE}', '${TENANT}', '', true);
  INSERT INTO i_edit_page(id, tenant_id, slug, microsite_id, builder_type)
  VALUES ('${SOURCE}', '${TENANT}', 'canvas-page', '${SITE}', 'canvas');
  UPDATE member_content_source
     SET active_generation=7
   WHERE tenant_id='${TENANT}' AND content_type='canvas_symbol'
     AND source_id='${SYMBOL}';
`;

function canvasRows({
  sourceId = SOURCE,
  dependency = SYMBOL,
  generation = 7,
  layoutType = 'public',
  accessScope = 'public',
  dependenciesOverride,
} = {}) {
  const dependencies = dependenciesOverride ?? [{
    contentType: 'canvas_symbol',
    sourceId: dependency,
    generation,
  }];
  return JSON.stringify([{
    tenant_id: '00000000-0000-4000-8000-000000000099',
    content_type: 'resource',
    source_id: '30000000-0000-4000-8000-000000000001',
    source_generation: 900,
    activation_token: '40000000-0000-4000-8000-000000000001',
    is_active: true,
    slug: 'canvas-page',
    title: 'Canvas page',
    link: '/canvas-page',
    status: 'published',
    feature_key: null,
    access_scope: accessScope,
    layout_type: layoutType,
    microsite_id: SITE,
    source_updated_at: '2026-10-27T00:00:00Z',
    symbol_versions: {
      [dependency]: { updated_at: '2026-10-27T00:00:00Z', generation },
    },
    provenance: {
      kind: 'authored_repair',
      adapter: 'canvas_page',
      tenant_id: TENANT,
      content_type: 'canvas_page',
      source_id: sourceId,
      generation: 1,
      dependencies,
    },
    chunk_index: 0,
    content: 'public canvas text',
    content_hash: 'canvas-hash',
    embedding: '[0.1,0.2]',
  }]);
}

function callSql(rows, generation, token, sourceId = SOURCE) {
  return `
    SELECT public.publish_member_content_repair(
      '${TENANT}', 'canvas_page', '${sourceId}', ${generation},
      '${token}', '${rows.replace(/'/g, "''")}'::jsonb
    );
  `;
}

test('Canvas dependency-fenced publication uses JSON provenance without a registry table', {
  timeout: 60_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'member-content-canvas-repair-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const port = String(55520 + (process.pid % 100));
  spawnSync('mkdir', ['-p', socket]);
  const args = [
    '-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q',
  ];
  let started = false;

  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', data, '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`, '-w', 'start',
    ]);
    started = true;
    run(psql, args, baseline);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const sqlByName = {
      '001-publish.sql': publishPath,
      '002-canvas.sql': canvasPath,
      '003-microsite-fence.sql': fencePath,
    };
    const orderedSql = manifest.files.map((file) => sqlByName[file]);
    assert.equal(orderedSql.every(Boolean), true);
    // The targeted runner is deliberately repeatable.  Applying the explicit
    // manifest twice must leave the Canvas publisher as the final definition.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const sqlPath of orderedSql) {
        run(psql, [...args, '-f', sqlPath]);
      }
    }

    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT to_regclass('public.member_content_dependency') IS NULL;
    `), 't');

    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='60000000-0000-4000-8000-000000000001',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
         AND source_id='${SOURCE}';
      INSERT INTO member_content_reindex_job(tenant_id, content_type, source_id)
      VALUES ('${TENANT}', 'canvas_page', '${SOURCE}');
      ${callSql(canvasRows(), 1,
        '60000000-0000-4000-8000-000000000001')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT
        (SELECT count(*) FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
            AND source_id='${SOURCE}') || ':' ||
        (SELECT count(*) FROM member_content_reindex_job
          WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
            AND source_id='${SOURCE}') || ':' ||
        (SELECT provenance->'dependencies'->0->>'contentType'
          FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
            AND source_id='${SOURCE}') || ':' ||
        (SELECT provenance->'dependencies'->0->>'generation'
          FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
            AND source_id='${SOURCE}');
    `), '1:0:canvas_symbol:7');

    // The dependency registry is stale, so the parent claim and chunk remain
    // untouched.  Child rows were locked before the parent CAS was attempted.
    run(psql, args, `
      UPDATE member_content_source
         SET generation=8, active_generation=8
       WHERE tenant_id='${TENANT}' AND content_type='canvas_symbol'
         AND source_id='${SYMBOL}';
      UPDATE member_content_source
         SET generation=2,
             claim_token='60000000-0000-4000-8000-000000000002',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
         AND source_id='${SOURCE}';
    `);
    const stale = run(psql, [...args, '-t', '-A'], `
      SELECT public.publish_member_content_repair(
        '${TENANT}', 'canvas_page', '${SOURCE}', 2,
        '60000000-0000-4000-8000-000000000002',
        '${canvasRows().replace(/'/g, "''")}'::jsonb
      ) || ':' ||
      (SELECT count(*) FROM member_content_chunk
        WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
          AND source_id='${SOURCE}') || ':' ||
      (SELECT claim_token::text FROM member_content_source
        WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
          AND source_id='${SOURCE}');
    `);
    assert.equal(
      stale,
      'false:1:60000000-0000-4000-8000-000000000002'
    );

    // Restore the child and exercise missing, duplicate/conflicting, and
    // malformed dependency metadata fences.
    run(psql, args, `
      UPDATE member_content_source
         SET generation=7, active_generation=7
       WHERE tenant_id='${TENANT}' AND content_type='canvas_symbol'
         AND source_id='${SYMBOL}';
    `);
    run(psql, args, `
      UPDATE member_content_source
         SET generation=3,
             claim_token='60000000-0000-4000-8000-000000000003',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
         AND source_id='${SOURCE}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      ${callSql(canvasRows(), 2,
        '60000000-0000-4000-8000-000000000002')}
    `), 'f');
    run(psql, args, `
      UPDATE member_content_source
         SET generation=2,
             claim_token='60000000-0000-4000-8000-000000000002',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
         AND source_id='${SOURCE}';
    `);
    const missingResult = run(psql, [...args, '-t', '-A'], `
      ${callSql(canvasRows({ dependency: MISSING_SYMBOL }), 2,
        '60000000-0000-4000-8000-000000000002')}
    `);
    assert.equal(missingResult, 'f');

    const invalidPayloads = [
      canvasRows({
        dependenciesOverride: [
          { contentType: 'canvas_symbol', sourceId: SYMBOL, generation: 7 },
          { contentType: 'canvas_symbol', sourceId: SYMBOL, generation: 8 },
        ],
      }),
      canvasRows({
        dependenciesOverride: {
          content_type: 'canvas_symbol',
          source_id: SYMBOL,
          generation: 7,
        },
      }),
      canvasRows({ layoutType: 'member' }),
      canvasRows({ accessScope: 'authenticated' }),
    ];
    for (const payload of invalidPayloads) {
      const result = runResult(psql, [...args, '-c', `
        ${callSql(payload, 2, '60000000-0000-4000-8000-000000000002')}
      `]);
      assert.notEqual(result.status, 0, result.stdout);
    }

    // Empty Canvas rows are an atomic tombstone and clean authored rows.
    run(psql, args, `
      ${callSql('[]', 2, '60000000-0000-4000-8000-000000000002')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) || ':' ||
             (SELECT active_generation FROM member_content_source
               WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
                 AND source_id='${SOURCE}')
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='canvas_page'
         AND source_id='${SOURCE}';
    `), '0:2');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
