import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const publishPath = fileURLToPath(new URL('./001-publish.sql', import.meta.url));
const canvasPath = fileURLToPath(new URL('./002-canvas.sql', import.meta.url));
const fencePath = fileURLToPath(new URL('./003-microsite-fence.sql', import.meta.url));
const manifestPath = fileURLToPath(new URL('./manifest.json', import.meta.url));

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const SITE_A = '10000000-0000-4000-8000-000000000001';
const PAGE_A = '20000000-0000-4000-8000-000000000001';
const PAGE_B = '20000000-0000-4000-8000-000000000002';
const TOKEN_A_1 = '30000000-0000-4000-8000-000000000001';
const TOKEN_A_2 = '30000000-0000-4000-8000-000000000002';
const TOKEN_A_3 = '30000000-0000-4000-8000-000000000003';
const TOKEN_B_1 = '30000000-0000-4000-8000-000000000011';

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
    ('${TENANT_A}', 'canvas_page', '${PAGE_A}', 1),
    ('${TENANT_B}', 'canvas_page', '${PAGE_B}', 1);

  INSERT INTO microsite(id, tenant_id, path_prefix, is_active)
  VALUES ('${SITE_A}', '${TENANT_A}', 'members', true);

  INSERT INTO i_edit_page(id, tenant_id, slug, microsite_id, builder_type)
  VALUES
    ('${PAGE_A}', '${TENANT_A}', 'canvas-page', '${SITE_A}', 'canvas'),
    ('${PAGE_B}', '${TENANT_B}', 'canvas-page', '${SITE_A}', 'canvas');
`;

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

function rows({
  tenantId = TENANT_A,
  sourceId = PAGE_A,
  micrositeId = SITE_A,
  slug = 'canvas-page',
  link = '/members/canvas-page',
} = {}) {
  return JSON.stringify([{
    tenant_id: tenantId,
    content_type: 'canvas_page',
    source_id: sourceId,
    source_generation: 900,
    activation_token: '40000000-0000-4000-8000-000000000001',
    is_active: true,
    slug,
    title: 'Canvas page',
    link,
    status: 'published',
    feature_key: null,
    access_scope: 'public',
    layout_type: 'public',
    microsite_id: micrositeId,
    source_updated_at: '2026-10-27T00:00:00Z',
    symbol_versions: {},
    provenance: {
      kind: 'authored_repair',
      adapter: 'canvas_page',
      tenant_id: tenantId,
      content_type: 'canvas_page',
      source_id: sourceId,
      generation: 1,
      dependencies: [],
    },
    chunk_index: 0,
    content: 'public canvas text',
    content_hash: 'canvas-hash',
    embedding: '[0.1,0.2]',
  }]);
}

function callSql({
  tenantId = TENANT_A,
  sourceId = PAGE_A,
  generation,
  token,
  payload,
}) {
  return `
    SELECT public.publish_member_content_repair(
      '${tenantId}', 'canvas_page', '${sourceId}', ${generation},
      '${token}', '${payload.replace(/'/g, "''")}'::jsonb
    );
  `;
}

function startDelete(psql, args) {
  const child = spawn(psql, [
    ...args,
    '-t',
    '-A',
    '-c',
    `
      BEGIN;
      DELETE FROM microsite WHERE id='${SITE_A}';
      SELECT 'delete-ready';
      SELECT pg_sleep(1.5);
      COMMIT;
    `,
  ], { encoding: 'utf8' });
  let output = '';
  let error = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output, error }));
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('delete-ready')) readyResolve();
  });
  child.stderr.on('data', (chunk) => {
    error += chunk;
    if (error && !output.includes('delete-ready')) {
      // The close handler still reports the complete psql error.
      readyReject(new Error(error));
    }
  });
  return { child, ready, done };
}

test('microsite fence survives repeat application and real PostgreSQL races', {
  timeout: 60_000,
}, async (t) => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) {
    t.skip('PostgreSQL command-line tools are unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'member-content-microsite-fence-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  const port = String(55620 + (process.pid % 100));
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
    // Replaying the complete targeted manifest must refresh the private core
    // and leave the final public wrapper in place on every pass.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const sqlPath of orderedSql) {
        run(psql, [...args, '-f', sqlPath]);
      }
    }

    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT has_function_privilege(
        'service_role',
        'public.publish_member_content_repair_unfenced(uuid,text,uuid,bigint,uuid,jsonb)',
        'EXECUTE'
      ) || ':' || has_function_privilege(
        'service_role',
        'public.publish_member_content_repair(uuid,text,uuid,bigint,uuid,jsonb)',
        'EXECUTE'
      ) || ':' || has_function_privilege(
        'service_role',
        'public.microsite_member_content_uri_component(text)',
        'EXECUTE'
      );
    `), 'false:true:false');

    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='${TOKEN_A_1}', claim_started_at=now()
       WHERE tenant_id='${TENANT_A}' AND content_type='canvas_page'
         AND source_id='${PAGE_A}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 1,
      token: TOKEN_A_1,
      payload: rows(),
    })), 't');
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT (SELECT active_generation FROM member_content_source
               WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}')
             || ':' ||
             (SELECT count(*) FROM member_content_chunk
               WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}');
    `), '1:1');

    // A cross-tenant association is never allowed to make tenant B's source
    // look current, and tenant A's microsite change does not invalidate it.
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='${TOKEN_B_1}', claim_started_at=now()
       WHERE tenant_id='${TENANT_B}' AND content_type='canvas_page'
         AND source_id='${PAGE_B}';
      UPDATE microsite SET path_prefix='renamed' WHERE id='${SITE_A}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT generation FROM member_content_source
       WHERE tenant_id='${TENANT_B}' AND source_id='${PAGE_B}';
    `), '1');
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      tenantId: TENANT_B,
      sourceId: PAGE_B,
      generation: 1,
      token: TOKEN_B_1,
      payload: rows({
        tenantId: TENANT_B,
        sourceId: PAGE_B,
        link: '/renamed/canvas-page',
      }),
    })), 'f');

    // The pre-rename snapshot is stale; the unchanged current snapshot is
    // stable once it uses the current canonical route.
    run(psql, args, `
      UPDATE member_content_source
         SET claim_token='${TOKEN_A_2}', claim_started_at=now()
       WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 2,
      token: TOKEN_A_2,
      payload: rows(),
    })), 'f');
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 2,
      token: TOKEN_A_2,
      payload: rows({ link: '/renamed/canvas-page' }),
    })), 't');

    // The SQL route must match the helper's encodeURIComponent behavior for
    // every segment, including Unicode, slash, percent, and space characters.
    run(psql, args, `
      UPDATE i_edit_page
         SET slug='hello/world % café'
       WHERE id='${PAGE_A}';
      UPDATE microsite
         SET path_prefix='品牌 /% café'
       WHERE id='${SITE_A}';
      UPDATE member_content_source
         SET claim_token='${TOKEN_A_3}', claim_started_at=now()
       WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 3,
      token: TOKEN_A_3,
      payload: rows({
        slug: 'hello/world % café',
        link: '/%E5%93%81%E7%89%8C%20%2F%25%20caf%C3%A9/hello%2Fworld%20%25%20caf%C3%A9',
      }),
    })), 't');

    run(psql, args, `
      UPDATE i_edit_page
         SET slug='canvas-page'
       WHERE id='${PAGE_A}';
      UPDATE microsite
         SET path_prefix='renamed'
       WHERE id='${SITE_A}';
    `);
    run(psql, args, `
      UPDATE microsite SET is_active=false WHERE id='${SITE_A}';
      UPDATE member_content_source
         SET claim_token='${TOKEN_A_3}', claim_started_at=now()
       WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}';
    `);
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 5,
      token: TOKEN_A_3,
      payload: rows({ link: '/renamed/canvas-page' }),
    })), 'f');

    // Re-activate and hold the microsite DELETE transaction after its FK
    // action has locked the page. The publisher must wait for the site lock,
    // reread the page, and reject the now-unassigned stale snapshot.
    run(psql, args, `
      UPDATE microsite
         SET is_active=true, path_prefix='race'
       WHERE id='${SITE_A}';
      UPDATE member_content_source
         SET claim_token='${TOKEN_A_1}', claim_started_at=now()
       WHERE tenant_id='${TENANT_A}' AND source_id='${PAGE_A}';
    `);
    const deletion = startDelete(psql, args);
    await deletion.ready;
    assert.equal(run(psql, [...args, '-t', '-A'], callSql({
      generation: 7,
      token: TOKEN_A_1,
      payload: rows({ link: '/race/canvas-page' }),
    })), 'f');
    const deletionResult = await deletion.done;
    assert.equal(deletionResult.code, 0, deletionResult.error);
    assert.equal(run(psql, [...args, '-t', '-A'], `
      SELECT (SELECT microsite_id IS NULL FROM i_edit_page WHERE id='${PAGE_A}')
             || ':' ||
             (SELECT microsite_id IS NULL FROM i_edit_page WHERE id='${PAGE_B}');
    `), 'true:true');
  } finally {
    if (started) spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});