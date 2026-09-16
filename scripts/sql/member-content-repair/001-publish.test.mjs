import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const migrationPath = fileURLToPath(new URL(
  './001-publish.sql',
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
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const SOURCE = '10000000-0000-4000-8000-000000000001';
const RICH_SOURCE = '10000000-0000-4000-8000-000000000002';
const INVALID_SOURCE = '10000000-0000-4000-8000-000000000003';

// The fixture intentionally uses text for embedding.  The migration populates
// through the deployed table composite type, so this exercises the same JSON
// vector-string contract without requiring pgvector in a temporary cluster.
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
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    content_type text NOT NULL,
    source_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued'
  );

  INSERT INTO member_content_source(
    tenant_id, content_type, source_id, generation, active_generation
  ) VALUES
    ('${TENANT}', 'resource', '${SOURCE}', 1, NULL),
    ('${TENANT}', 'resource', '${RICH_SOURCE}', 1, NULL),
    ('${TENANT}', 'resource', '${INVALID_SOURCE}', 1, NULL);
`;

function rowsJson(title = 'Canonical title', indexes = [0, 1], overrides = {}) {
  return JSON.stringify(indexes.map((chunkIndex) => ({
    // Deliberately hostile identity values prove the RPC overwrites them.
    tenant_id: OTHER_TENANT,
    content_type: 'canvas_page',
    source_id: RICH_SOURCE,
    source_generation: 999,
    activation_token: '20000000-0000-4000-8000-000000000001',
    is_active: true,
    title,
    slug: 'canonical',
    link: '/Resources?resourceId=1',
    status: 'active',
    feature_key: 'content.resources',
    access_scope: 'public',
    // Extra owned-source fields must remain an accepted authored marker.
    provenance: {
      kind: 'authored_repair',
      source: 'raw',
      source_id: SOURCE,
      generation: 1,
    },
    chunk_index: chunkIndex,
    content: `chunk ${chunkIndex}`,
    content_hash: `hash-${chunkIndex}`,
    embedding: '[0.1,0.2]',
    ...overrides,
  })));
}

function callSql(rows, generation, token, source = SOURCE) {
  const payload = rows.replace(/'/g, "''");
  return `
    SELECT public.publish_member_content_repair(
      '${TENANT}', 'resource', '${source}', ${generation},
      '${token}', '${payload}'::jsonb
    );
  `;
}

test('publishes fenced complete snapshots and rolls back unsafe repairs in real temporary PostgreSQL', {
  timeout: 60_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'member-content-repair-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const port = String(55460 + (process.pid % 100));
  spawnSync('mkdir', ['-p', socket]);
  const args = [
    '-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres',
    '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q',
  ];
  let started = false;

  try {
    run(initdb, ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions']);
    run(pgCtl, [
      '-D', data,
      '-l', path.join(root, 'postgres.log'),
      '-o', `-F -k ${socket} -c listen_addresses= -p ${port}`,
      '-w', 'start',
    ]);
    started = true;
    run(psql, args, baseline);
    run(psql, [...args, '-f', migrationPath]);

    // Insert, activate, remove the queued job, and overwrite untrusted scope.
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='30000000-0000-4000-8000-000000000001',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
      INSERT INTO member_content_reindex_job(tenant_id, content_type, source_id)
      VALUES ('${TENANT}', 'resource', '${SOURCE}');
      ${callSql(rowsJson(), 1, '30000000-0000-4000-8000-000000000001')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT
        (SELECT count(*) FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='resource'
            AND source_id='${SOURCE}') || ':' ||
        (SELECT count(*) FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='resource'
            AND source_id='${SOURCE}' AND is_active) || ':' ||
        (SELECT count(*) FROM member_content_reindex_job
          WHERE tenant_id='${TENANT}' AND content_type='resource'
            AND source_id='${SOURCE}') || ':' ||
        (SELECT count(*) FROM member_content_chunk
          WHERE tenant_id='${TENANT}' AND content_type='resource'
            AND source_id='${SOURCE}' AND tenant_id='${TENANT}');
    `), '2:2:0:2');

    // Re-publishing the same generation/index updates content in place.  The
    // five-key conflict target must preserve row identity and created_at.
    const originalIdentity = run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(
        id::text || '|' || created_at::text, ',' ORDER BY chunk_index
      )
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
    `);
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='30000000-0000-4000-8000-000000000001',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
      ${callSql(rowsJson('Repeated title', [0, 1], { content: 'replaced text' }),
        1, '30000000-0000-4000-8000-000000000001')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT string_agg(
        id::text || '|' || created_at::text, ',' ORDER BY chunk_index
      ) || ':' || string_agg(content, ',' ORDER BY chunk_index)
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
    `), `${originalIdentity}:replaced text,replaced text`);

    // A later generation replaces the complete snapshot, not merely its
    // prefix, and removes all superseded-generation rows.
    run(psql, args, `
      UPDATE member_content_source
         SET generation=2,
             claim_token='30000000-0000-4000-8000-000000000002',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
      ${callSql(rowsJson('Updated title', [0]), 2,
        '30000000-0000-4000-8000-000000000002')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) || ':' ||
             min(source_generation) || ':' ||
             max(source_generation) || ':' ||
             min(title)
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
    `), '1:2:2:Updated title');

    // Stale generation/token is a no-op, including against a valid payload.
    run(psql, args, `
      UPDATE member_content_source
         SET generation=3,
             claim_token='30000000-0000-4000-8000-000000000003',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
      ${callSql(rowsJson('stale', [0, 1]), 2,
        '30000000-0000-4000-8000-000000000002')}
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT generation || ':' || claim_token::text || ':' ||
             (SELECT count(*) FROM member_content_chunk
               WHERE tenant_id='${TENANT}' AND content_type='resource'
                 AND source_id='${SOURCE}')
        FROM member_content_source
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
    `), '3:30000000-0000-4000-8000-000000000003:1');

    // Conflicting canonical metadata fails before deleting the old snapshot.
    const conflicting = rowsJson('A', [0, 1]).replace(
      '"title":"A","slug"',
      '"title":"A","slug"',
    ).replace(
      /"chunk_index":1,"content":"chunk 1"/,
      '"title":"B","chunk_index":1,"content":"chunk 1"',
    );
    const conflictResult = runResult(psql, [...args, '-c', `
      ${callSql(conflicting, 3, '30000000-0000-4000-8000-000000000003')}
    `]);
    assert.notEqual(conflictResult.status, 0, conflictResult.stdout);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) || ':' ||
             (SELECT claim_token::text FROM member_content_source
               WHERE tenant_id='${TENANT}' AND content_type='resource'
                 AND source_id='${SOURCE}')
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${SOURCE}';
    `), '1:30000000-0000-4000-8000-000000000003');

    // Rich PDF/Canvas provenance is a destructive-repair fence.
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='30000000-0000-4000-8000-000000000004',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${RICH_SOURCE}';
      INSERT INTO member_content_chunk(
        tenant_id, content_type, source_id, title, chunk_index, content,
        content_hash, embedding, source_generation, is_active, provenance
      ) VALUES (
        '${TENANT}', 'resource', '${RICH_SOURCE}', 'PDF', 0, 'rich',
        'rich-hash', '[0.3,0.4]', 1, true, '{"kind":"pdf"}'::jsonb
      );
    `);
    const richResult = runResult(psql, [...args, '-c', `
      ${callSql(rowsJson('replacement', [0]),
        1, '30000000-0000-4000-8000-000000000004', RICH_SOURCE)}
    `]);
    assert.notEqual(richResult.status, 0, richResult.stdout);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) || ':' || min(provenance->>'kind')
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${RICH_SOURCE}';
    `), '1:pdf');

    // Missing indexes, duplicate indexes, and a bad embedding all roll back.
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='30000000-0000-4000-8000-000000000005',
             claim_started_at=now()
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${INVALID_SOURCE}';
      INSERT INTO member_content_chunk(
        tenant_id, content_type, source_id, title, chunk_index, content,
        content_hash, embedding, source_generation, is_active
      ) VALUES (
        '${TENANT}', 'resource', '${INVALID_SOURCE}', 'old', 0, 'old',
        'old-hash', '[0.5,0.6]', 1, true
      );
    `);
    for (const invalidRows of [
      rowsJson('missing', [0, 2]),
      rowsJson('duplicate', [0, 0]),
      rowsJson('missing hash', [0], { content_hash: '' }),
      rowsJson('missing embedding', [0], { embedding: null }),
      rowsJson('missing scope', [0], { access_scope: null }),
    ]) {
      const invalidResult = runResult(psql, [...args, '-c', `
        ${callSql(invalidRows, 1,
          '30000000-0000-4000-8000-000000000005', INVALID_SOURCE)}
      `]);
      assert.notEqual(invalidResult.status, 0, invalidResult.stdout);
    }
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT count(*) || ':' || min(content) || ':' || min(source_generation)
        FROM member_content_chunk
       WHERE tenant_id='${TENANT}' AND content_type='resource'
         AND source_id='${INVALID_SOURCE}';
    `), '1:old:1');

    // Replaying the migration is idempotent, while a legacy unique key is a
    // hard failure and is never dropped.
    run(psql, [...args, '-f', migrationPath]);
    run(psql, args, `
      CREATE UNIQUE INDEX member_content_chunk_source_idx
        ON member_content_chunk(content_type, source_id, chunk_index);
    `);
    const legacyResult = runResult(psql, [...args, '-f', migrationPath]);
    assert.notEqual(legacyResult.status, 0, legacyResult.stdout);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT to_regclass('public.member_content_chunk_source_idx') IS NOT NULL;
    `), 't');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
