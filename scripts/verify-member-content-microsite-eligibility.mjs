// DEST-only rollback probe: no provider, backfill or persistent content writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';

const client = await connectDestination();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='30s'");
  const sql = await readFile(new URL('./sql/member-content-repair/005-microsite-knowledge-eligibility.sql', import.meta.url), 'utf8');
  await client.query(sql);
  await client.query(sql); // idempotent; never replay the foundation.
  const row = (await client.query(`
    SELECT c.tenant_id,c.source_id,c.source_generation,c.embedding::text,
      p.microsite_id
    FROM member_content_chunk c
    JOIN member_content_source s ON s.tenant_id=c.tenant_id
      AND s.content_type=c.content_type AND s.source_id=c.source_id
      AND s.active_generation=c.source_generation
    JOIN i_edit_page p ON p.id=c.source_id AND p.tenant_id=c.tenant_id
    JOIN microsite m ON m.id=p.microsite_id AND m.tenant_id=p.tenant_id
    WHERE c.content_type='canvas_page' AND c.is_active IS TRUE
      AND c.embedding IS NOT NULL AND c.access_scope='public'
      AND p.status='published' AND p.builder_type='canvas' AND m.is_active IS TRUE
    LIMIT 1
  `)).rows[0];
  assert.ok(row, 'A real active indexed public microsite page is required');
  const matches = async (authenticated) => (await client.query(`
    SELECT source_id FROM match_member_content_chunks(
      $1::vector,$2::uuid,100,$3::boolean,false,NULL::uuid,
      '{}'::uuid[],'{}'::uuid[],'{}'::uuid[],'{}'::text[],
      ARRAY['content.resources','events.browse-events','content.news','content.articles'],
      '{}'::uuid[],'',ARRAY['canvas_page'])
    WHERE source_id=$4::uuid
  `, [row.embedding,row.tenant_id,authenticated,row.source_id])).rows;
  for (const member of [false,true]) assert.ok((await matches(member)).length);
  await client.query('UPDATE microsite SET is_active=false WHERE id=$1 AND tenant_id=$2',
    [row.microsite_id,row.tenant_id]);
  const registry = (await client.query(`SELECT active_generation FROM member_content_source
    WHERE tenant_id=$1 AND content_type='canvas_page' AND source_id=$2`,
  [row.tenant_id,row.source_id])).rows[0];
  assert.equal(registry.active_generation,null,'availability change invalidates source immediately');
  assert.ok((await client.query(`SELECT 1 FROM member_content_reindex_job
    WHERE tenant_id=$1 AND content_type='canvas_page' AND source_id=$2`,
  [row.tenant_id,row.source_id])).rowCount, 'availability change queues safe rebuild');
  // Simulate a stale active index so this proves the live predicate as well as
  // the existing trigger. This deliberately inconsistent state is rolled back.
  await client.query(`UPDATE member_content_source SET active_generation=$3
    WHERE tenant_id=$1 AND content_type='canvas_page' AND source_id=$2`,
  [row.tenant_id,row.source_id,row.source_generation]);
  for (const member of [false,true]) assert.deepEqual(await matches(member),[]);
  console.log('PASS: active guest/member retrieval; disable invalidation + reindex job; stale-index live denial; idempotent focused SQL. All changes rolled back.');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}