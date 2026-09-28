/**
 * Transactional integration verification for the Member AI generation
 * lifecycle. It writes only rollback-scoped probes against DEST_DATABASE_URL:
 * source-trigger invalidation, stale-worker rejection, activation and hybrid
 * lexical/vector retrieval all run in the real Postgres schema.
 */
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) throw new Error('DEST_DATABASE_URL is required');

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

await client.connect();
try {
  await client.query('BEGIN');
  // The dedicated operations state is the authority for cron/manual ownership,
  // not browser-writable system_settings. This rollback-scoped probe covers
  // atomic claim, foreign-owner denial, renewal, and compare-and-delete.
  await client.query(`DELETE FROM member_content_reindex_operation WHERE operation_key = 'global'`);
  const operationRun = 'aaaaaaaa-0000-4000-8000-000000000001';
  const competingRun = 'aaaaaaaa-0000-4000-8000-000000000002';
  const operationClaim = (await client.query(
    `SELECT * FROM claim_member_content_reindex_operation($1, '{}'::jsonb, 300)`,
    [operationRun]
  )).rows[0];
  if (operationClaim?.acquired !== true) throw new Error('operation lock did not claim a free run');
  const competingClaim = (await client.query(
    `SELECT * FROM claim_member_content_reindex_operation($1, '{}'::jsonb, 300)`,
    [competingRun]
  )).rows[0];
  if (competingClaim?.acquired !== false || competingClaim?.active_run_id !== operationRun) {
    throw new Error('operation lock admitted a concurrent reindex run');
  }
  const renewed = (await client.query(
    `SELECT * FROM renew_member_content_reindex_operation($1, '{}'::jsonb)`,
    [operationRun]
  )).rows[0];
  if (renewed?.owns !== true) throw new Error('operation lock owner could not renew');
  const foreignCompletion = (await client.query(
    `SELECT complete_member_content_reindex_operation($1, true) AS completed`,
    [competingRun]
  )).rows[0];
  if (foreignCompletion?.completed !== false) throw new Error('foreign run released operation lock');
  const completion = (await client.query(
    `SELECT complete_member_content_reindex_operation($1, true) AS completed`,
    [operationRun]
  )).rows[0];
  if (completion?.completed !== true) throw new Error('operation lock owner could not complete');
  await client.query(
    `INSERT INTO member_content_source(tenant_id, content_type, source_id, generation, active_generation)
     VALUES ($1, 'resource', $2, 3, NULL)`,
    [tenantId, sourceId]
  );
  const claim = (await client.query(
    `SELECT * FROM claim_member_content_generation($1, 'resource', $2)`,
    [tenantId, sourceId]
  )).rows[0];
  if (!claim?.claim_token || String(claim.generation) !== '3') {
    throw new Error('generation claim did not return its expected token');
  }
  await client.query(
    `INSERT INTO member_content_chunk(
       tenant_id, content_type, source_id, source_generation, activation_token,
       is_active, title, chunk_index, content, content_hash, embedding, status
     ) VALUES (
       $1, 'resource', $2, 3, $3, false, 'October Event', 0,
       'Approved event date 16 October 2026', 'integration',
       array_fill(0::real, ARRAY[1536])::vector, 'active'
     )`,
    [tenantId, sourceId, claim.claim_token]
  );
  const activation = (await client.query(
    `SELECT activate_member_content_generation($1, 'resource', $2, 3, $3) AS activated`,
    [tenantId, sourceId, claim.claim_token]
  )).rows[0];
  if (activation.activated !== true) throw new Error('staged generation did not activate');

  const result = await client.query(
    `SELECT count(*)::int AS count
     FROM match_member_content_chunks(
       array_fill(0::real, ARRAY[1536])::vector, $1, 5, true, true, NULL,
       ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::text[],
         ARRAY[]::text[], ARRAY[]::uuid[], '16 October 2026',
         ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]
     )`,
    [tenantId]
  );
  if (result.rows[0].count !== 1) {
    throw new Error('hybrid retrieval did not return the activated generation');
  }

  await client.query(`SELECT invalidate_member_content_source($1, 'resource', $2)`, [
    tenantId, sourceId,
  ]);
  const staleActivation = (await client.query(
    `SELECT activate_member_content_generation($1, 'resource', $2, 3, $3) AS activated`,
    [tenantId, sourceId, claim.claim_token]
  )).rows[0];
  if (staleActivation.activated !== false) {
    throw new Error('a stale worker activated after source invalidation');
  }

  // Real table-trigger coverage for a dependency: symbols have no corpus
  // chunks, so their generation stays active immediately. A Canvas chunk with
  // the preceding dependency snapshot will therefore be rejected by the
  // generation comparison rather than permanently blocked at NULL.
  const realTenant = (await client.query('SELECT id FROM tenant ORDER BY id LIMIT 1')).rows[0]?.id;
  if (!realTenant) throw new Error('destination has no tenant for symbol trigger probe');
  const symbol = (await client.query(
    `INSERT INTO canvas_symbol(tenant_id, name, design)
     VALUES ($1, 'Member content lifecycle probe', '{}'::jsonb)
     RETURNING id`,
    [realTenant]
  )).rows[0];
  const firstDependency = (await client.query(
    `SELECT generation, active_generation FROM member_content_source
     WHERE tenant_id = $1 AND content_type = 'canvas_symbol' AND source_id = $2`,
    [realTenant, symbol.id]
  )).rows[0];
  if (String(firstDependency?.generation) !== '1' || String(firstDependency?.active_generation) !== '1') {
    throw new Error('Canvas Symbol insert trigger did not activate dependency generation');
  }
  const canvasSourceId = '12121212-1212-4121-8121-121212121212';
  await client.query(
    `INSERT INTO member_content_source(tenant_id, content_type, source_id, generation, active_generation)
     VALUES ($1, 'canvas_page', $2, 1, 1)`,
    [realTenant, canvasSourceId]
  );
  await client.query(
    `INSERT INTO member_content_chunk(
       tenant_id, content_type, source_id, source_generation, is_active,
       title, chunk_index, content, content_hash, embedding, status, provenance
     ) VALUES (
       $1, 'canvas_page', $2, 1, true, 'Dependency race probe', 0,
       'Canvas dependency race content', 'symbol-race',
       array_fill(0::real, ARRAY[1536])::vector, 'published',
       jsonb_build_object('dependencies', jsonb_build_array(jsonb_build_object(
         'contentType', 'canvas_symbol', 'sourceId', $3::text, 'generation', 1
       )))
     )`,
    [realTenant, canvasSourceId, symbol.id]
  );
  const dependencyVisible = await client.query(
    `SELECT count(*)::int AS count FROM match_member_content_chunks(
       array_fill(0::real, ARRAY[1536])::vector, $1, 100, true, true, NULL,
       ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::text[],
        ARRAY[]::text[], ARRAY[]::uuid[], 'dependency',
        ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]
     ) WHERE source_id = $2`,
    [realTenant, canvasSourceId]
  );
  if (dependencyVisible.rows[0].count !== 1) {
    throw new Error('current Canvas symbol dependency did not admit its chunk');
  }
  await client.query(`UPDATE canvas_symbol SET name = 'Member content lifecycle probe changed' WHERE id = $1`, [symbol.id]);
  const changedDependency = (await client.query(
    `SELECT generation, active_generation FROM member_content_source
     WHERE tenant_id = $1 AND content_type = 'canvas_symbol' AND source_id = $2`,
    [realTenant, symbol.id]
  )).rows[0];
  if (String(changedDependency?.generation) !== '2' || String(changedDependency?.active_generation) !== '2') {
    throw new Error('Canvas Symbol update trigger did not advance active dependency generation');
  }
  const dependencyDenied = await client.query(
    `SELECT count(*)::int AS count FROM match_member_content_chunks(
       array_fill(0::real, ARRAY[1536])::vector, $1, 100, true, true, NULL,
       ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::uuid[], ARRAY[]::text[],
        ARRAY[]::text[], ARRAY[]::uuid[], 'dependency',
        ARRAY['resource','event','complex_event','news_post','blog_post','canvas_page']::text[]
     ) WHERE source_id = $2`,
    [realTenant, canvasSourceId]
  );
  if (dependencyDenied.rows[0].count !== 0) {
    throw new Error('old Canvas chunk survived a real Canvas Symbol generation race');
  }

  // A real corpus-source mutation must instead fail closed and enqueue durable
  // retry work. This uses rollback-scoped data only.
  const resource = (await client.query(
    `INSERT INTO resource(tenant_id, title, resource_type, target_url, status)
     VALUES ($1, 'Lifecycle source trigger probe', 'article', '/probe', 'active')
     RETURNING id`,
    [realTenant]
  )).rows[0];
  const queued = (await client.query(
    `SELECT s.generation, s.active_generation, j.attempts
     FROM member_content_source s
     JOIN member_content_reindex_job j
       ON j.tenant_id=s.tenant_id AND j.content_type=s.content_type AND j.source_id=s.source_id
     WHERE s.tenant_id=$1 AND s.content_type='resource' AND s.source_id=$2`,
    [realTenant, resource.id]
  )).rows[0];
  if (String(queued?.generation) !== '1' || queued.active_generation !== null || queued.attempts !== 0) {
    throw new Error('resource trigger did not fail-close and enqueue a durable reindex job');
  }
  console.log('Member-content lifecycle destination integration verification passed.');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}