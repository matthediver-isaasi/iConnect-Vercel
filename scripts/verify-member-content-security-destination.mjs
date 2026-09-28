/**
 * Rollback-scoped destination verification for the P0 member-content
 * lockdown.  It checks effective grants/RLS and proves that every supported
 * content family remains tenant isolated before ranking. It also proves an
 * unapproved derived PDF cannot take a top-K slot, even for an administrator.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) throw new Error('DEST_DATABASE_URL is required');

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});
const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000002';
const families = [
  ['resource', 'active'],
  ['event', 'published'],
  ['complex_event', 'published'],
  ['news_post', 'published'],
  ['blog_post', 'published'],
  ['canvas_page', 'published'],
];
const signature = 'public.match_member_content_chunks(vector,uuid,integer,boolean,boolean,uuid,uuid[],uuid[],uuid[],text[],text[],uuid[],text,text[])';
const memberContentTables = [
  'member_content_chunk',
  'member_content_source',
  'member_content_reindex_job',
  'member_content_reindex_operation',
];
const aiTables = [
  'member_ai_conversation',
  'member_ai_message',
  'member_ai_settings',
  'member_ai_usage_event',
  'member_ai_public_usage_event',
  'member_ai_platform_settings',
];
const aiFunctions = [
  'public.claim_member_ai_usage(uuid,uuid,text)',
  'public.claim_public_member_ai_usage(uuid,text,text)',
  'public.claim_admin_member_ai_usage(uuid,text,text)',
];

async function expectSecurity() {
  const tableList = memberContentTables.map((table) => `'public.${table}'::regclass`).join(', ');
  const rls = await client.query(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid IN (${tableList})
  `);
  assert.equal(rls.rows.length, memberContentTables.length);
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} must have RLS`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
  }
  const roles = ['anon', 'authenticated'];
  for (const table of memberContentTables) {
    for (const role of roles) {
      const result = await client.query(
        'SELECT has_table_privilege($1, $2, $3) AS allowed',
        [role, `public.${table}`, 'SELECT,INSERT,UPDATE,DELETE']
      );
      assert.equal(result.rows[0].allowed, false, `${role} must not access ${table}`);
    }
    const service = await client.query(
      'SELECT has_table_privilege($1, $2, $3) AS allowed',
      ['service_role', `public.${table}`, 'SELECT,INSERT,UPDATE,DELETE']
    );
    assert.equal(service.rows[0].allowed, true, `service_role needs ${table}`);
  }
  const publicAcl = await client.query(`
    SELECT c.relname, count(*)::int AS grants
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid IN (${tableList})
      AND acl.grantee = 0
    GROUP BY c.relname
  `);
  assert.ok(publicAcl.rows.every((row) => row.grants === 0), 'PUBLIC table grants must be absent');

  const functionRows = await client.query(`
    SELECT p.oid::regprocedure::text AS identity, p.pronargdefaults
    FROM pg_proc p
    INNER JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'match_member_content_chunks'
  `);
  assert.equal(functionRows.rows.length, 1, 'exactly one matcher overload must exist');
  assert.equal(
    functionRows.rows[0].identity.replace(/\s+/g, ''),
    signature.replace('public.', '').replace(/\s+/g, ''),
    'matcher must use the canonical fourteen-argument identity'
  );
  assert.equal(
    Number(functionRows.rows[0].pronargdefaults),
    0,
    'all matcher arguments must be required; no legacy three-argument fallback'
  );
  const functions = [
    signature,
    'public.claim_member_content_generation(uuid,text,uuid)',
    'public.activate_member_content_generation(uuid,text,uuid,bigint,uuid)',
    'public.invalidate_member_content_source(uuid,text,uuid)',
    'public.claim_member_content_reindex_operation(uuid,jsonb,integer)',
    'public.renew_member_content_reindex_operation(uuid,jsonb)',
    'public.complete_member_content_reindex_operation(uuid,boolean)',
  ];
  for (const fn of functions) {
    for (const role of roles) {
      const result = await client.query(
        'SELECT has_function_privilege($1, $2, $3) AS allowed',
        [role, fn, 'EXECUTE']
      );
      assert.equal(result.rows[0].allowed, false, `${role} must not execute ${fn}`);
    }
    const service = await client.query(
      'SELECT has_function_privilege($1, $2, $3) AS allowed',
      ['service_role', fn, 'EXECUTE']
    );
    assert.equal(service.rows[0].allowed, true, `service_role needs ${fn}`);
  }
}

async function expectMemberAiSecurity() {
  const tableList = aiTables.map((table) => `'public.${table}'::regclass`).join(', ');
  const rls = await client.query(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid IN (${tableList})
  `);
  assert.equal(rls.rows.length, aiTables.length, 'all AI tables must exist');
  for (const row of rls.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} must have RLS`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
  }
  // These are the exact table privileges PostgREST evaluates for anon and
  // authenticated REST requests. No privilege means REST cannot SELECT or
  // mutate AI data even before RLS is considered.
  for (const table of aiTables) {
    for (const role of ['anon', 'authenticated']) {
      const denied = await client.query(
        'SELECT has_table_privilege($1, $2, $3) AS allowed',
        [role, `public.${table}`, 'SELECT,INSERT,UPDATE,DELETE']
      );
      assert.equal(denied.rows[0].allowed, false, `${role} REST must not access ${table}`);
    }
    const service = await client.query(
      'SELECT has_table_privilege($1, $2, $3) AS allowed',
      ['service_role', `public.${table}`, 'SELECT,INSERT,UPDATE,DELETE']
    );
    assert.equal(service.rows[0].allowed, true, `service_role needs ${table}`);
  }
  const publicAcl = await client.query(`
    SELECT c.relname, count(*)::int AS grants
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
    WHERE c.oid IN (${tableList})
      AND acl.grantee = 0
    GROUP BY c.relname
  `);
  assert.ok(publicAcl.rows.every((row) => row.grants === 0), 'PUBLIC AI table grants must be absent');
  for (const fn of aiFunctions) {
    for (const role of ['anon', 'authenticated']) {
      const denied = await client.query(
        'SELECT has_function_privilege($1, $2, $3) AS allowed',
        [role, fn, 'EXECUTE']
      );
      assert.equal(denied.rows[0].allowed, false, `${role} must not execute ${fn}`);
    }
    const service = await client.query(
      'SELECT has_function_privilege($1, $2, $3) AS allowed',
      ['service_role', fn, 'EXECUTE']
    );
    assert.equal(service.rows[0].allowed, true, `service_role needs ${fn}`);
  }
}

async function expectAnonymousRestRoleDenied() {
  // PostgREST executes anonymous API calls as this exact database role.  Run
  // the probes against DEST rather than the workspace's unrelated public
  // Supabase URL, whose anon key may point at a different project.
  await client.query('SET LOCAL ROLE anon');
  for (const table of aiTables) {
    await client.query('SAVEPOINT anon_ai_table_probe');
    try {
      await client.query(`SELECT * FROM public.${table} LIMIT 1`);
      assert.fail(`anonymous REST role unexpectedly selected ${table}`);
    } catch (error) {
      assert.equal(error.code, '42501', `anonymous REST role must be denied for ${table}`);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT anon_ai_table_probe');
    }
  }
  const requests = [
    ['claim_member_ai_usage', "SELECT * FROM public.claim_member_ai_usage('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'anonymous-security-probe')"],
    ['claim_public_member_ai_usage', "SELECT * FROM public.claim_public_member_ai_usage('00000000-0000-4000-8000-000000000001', 'anonymous-security-probe', 'anonymous-security-probe')"],
    ['claim_admin_member_ai_usage', "SELECT * FROM public.claim_admin_member_ai_usage('00000000-0000-4000-8000-000000000001', 'anonymous-security-probe', 'anonymous-security-probe')"],
  ];
  for (const [rpc, sql] of requests) {
    await client.query('SAVEPOINT anon_ai_rpc_probe');
    try {
      await client.query(sql);
      assert.fail(`anonymous REST role unexpectedly executed ${rpc}`);
    } catch (error) {
      assert.equal(error.code, '42501', `anonymous REST role must not execute ${rpc}`);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT anon_ai_rpc_probe');
    }
  }
  await client.query('RESET ROLE');
}

async function insertTenant(tenantId, prefix) {
  for (let index = 0; index < families.length; index++) {
    const [contentType, status] = families[index];
    const sourceId = `${prefix}000000${index + 1}-0000-4000-8000-000000000001`;
    const chunkId = `${prefix}100000${index + 1}-0000-4000-8000-000000000001`;
    await client.query(
      `INSERT INTO member_content_source(tenant_id, content_type, source_id, generation, active_generation)
       VALUES ($1, $2, $3, 1, 1)`,
      [tenantId, contentType, sourceId]
    );
    await client.query(
      `INSERT INTO member_content_chunk(
        id, tenant_id, content_type, source_id, source_generation, is_active,
        title, chunk_index, content, content_hash, embedding, status, is_public, provenance
      ) VALUES (
        $1, $2, $3, $4, 1, true, $5, 0, $5, $5,
        array_fill(0::real, ARRAY[1536])::vector, $6, true, '{"dependencies":[]}'::jsonb
      )`,
      [chunkId, tenantId, contentType, sourceId, `${contentType}-${prefix}`, status]
    );
  }
}

async function matchedTenant(tenantId, eligiblePdfIds = [], {
  authenticated = true, admin = true, role = null, groups = [],
  allowedFeatures = families.map(([type]) => type),
} = {}) {
  return client.query(
    `SELECT tenant_id, content_type
     FROM public.match_member_content_chunks(
        array_fill(0::real, ARRAY[1536])::vector, $1, 20, $3, $4, $5::uuid,
        $6::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::text[],
        $7::text[], $2::uuid[], 'tenant isolation',
       ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]
     )`,
    [tenantId, eligiblePdfIds, authenticated, admin, role, groups, allowedFeatures]
  );
}

await client.connect();
try {
  await client.query('BEGIN');
  await expectSecurity();
  await expectMemberAiSecurity();
  await expectAnonymousRestRoleDenied();
  await insertTenant(tenantA, 'a');
  await insertTenant(tenantB, 'b');

  const resultA = await matchedTenant(tenantA);
  const resultB = await matchedTenant(tenantB);
  assert.equal(resultA.rows.length, families.length, 'tenant A must receive every supported family only');
  assert.equal(resultB.rows.length, families.length, 'tenant B must receive every supported family only');
  assert.ok(resultA.rows.every((row) => row.tenant_id === tenantA));
  assert.ok(resultB.rows.every((row) => row.tenant_id === tenantB));
  assert.deepEqual(new Set(resultA.rows.map((row) => row.content_type)), new Set(families.map(([type]) => type)));

  // All six adapters participate in the same permission-first candidate pool.
  // Protect the fixtures, then exercise guest/member/module denial before top-k.
  await client.query(`UPDATE member_content_chunk SET access_scope='authenticated',
    feature_key=CASE content_type WHEN 'canvas_page' THEN NULL ELSE content_type END
    WHERE tenant_id=ANY($1::uuid[])`,[[tenantA,tenantB]]);
  assert.equal((await matchedTenant(tenantA,[],{authenticated:false,admin:false})).rows.length,0);
  assert.equal((await matchedTenant(tenantB,[],{authenticated:false,admin:false})).rows.length,0);
  const memberA = { authenticated:true, admin:false, role:'a3000000-0000-4000-8000-000000000001' };
  assert.equal((await matchedTenant(tenantA,[],memberA)).rows.length,families.length);
  assert.equal((await matchedTenant(tenantA,[],{...memberA,
    allowedFeatures:[]})).rows.length,1,
  'only Canvas remains when native content module permissions are revoked');
  // A source mutation invalidates every family in both ranking modes; no
  // stale high-similarity chunk fills the remaining result slots.
  await client.query(`UPDATE member_content_source SET active_generation=NULL
    WHERE tenant_id=$1 AND content_type='canvas_page'`,[tenantA]);
  assert.equal((await matchedTenant(tenantA,[],memberA)).rows.length,families.length-1);
  assert.equal((await matchedTenant(tenantB,[],memberA)).rows.length,families.length,
    'tenant A revocation never changes tenant B');
  await client.query(`UPDATE member_content_source SET active_generation=generation
    WHERE tenant_id=$1 AND content_type='canvas_page'`,[tenantA]);

  // A file-derived resource chunk has both a source-generation dependency and
  // an explicit file-policy allow-list requirement before SQL ranking.
  const pdfSource = 'a2000000-0000-4000-8000-000000000001';
  const fileSource = 'a2000000-0000-4000-8000-000000000002';
  const pdfChunk = 'a2000000-0000-4000-8000-000000000003';
  await client.query(
    `INSERT INTO member_content_source(tenant_id, content_type, source_id, generation, active_generation)
     VALUES ($1, 'resource', $2, 1, 1), ($1, 'file_repository', $3, 1, 1)`,
    [tenantA, pdfSource, fileSource]
  );
  await client.query(
    `INSERT INTO member_content_chunk(
      id, tenant_id, content_type, source_id, source_generation, is_active,
      title, chunk_index, content, content_hash, embedding, status, is_public, provenance
    ) VALUES (
      $1, $2, 'resource', $3, 1, true, 'private policy PDF', 99, 'private policy PDF',
      'private-policy-pdf', array_fill(0::real, ARRAY[1536])::vector, 'active', true,
      jsonb_build_object('kind', 'resource_pdf', 'fileId', $4::text,
        'dependencies', jsonb_build_array(jsonb_build_object(
          'contentType', 'file_repository', 'sourceId', $4::text, 'generation', 1
        )))
    )`,
    [pdfChunk, tenantA, pdfSource, fileSource]
  );
  assert.equal((await matchedTenant(tenantA)).rows.length, families.length);
  assert.equal((await matchedTenant(tenantA, [pdfChunk])).rows.length, families.length + 1);
  console.log('Member AI/content P0 grants, anonymous REST-role denial, tenant isolation, and pre-rank file-policy verification passed.');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}