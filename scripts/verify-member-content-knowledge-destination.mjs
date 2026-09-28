// Rollback-only compatibility probe. Never installs SQL or leaves indexed test
// content behind; uses the deployed repaired schema and authentic source IDs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';

const client = await connectDestination();
await client.query('BEGIN');
try {
  await client.query("SET LOCAL lock_timeout='3s'");
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query(await readFile(new URL('./sql/member-content-repair/004-knowledge.sql', import.meta.url), 'utf8'));
  const source = (await client.query(`
    SELECT to_jsonb(c) AS chunk FROM member_content_chunk c
    JOIN resource r ON r.id=c.source_id AND r.tenant_id=c.tenant_id
    WHERE c.content_type='resource' AND r.status='active' LIMIT 1
  `)).rows[0]?.chunk;
  assert.ok(source, 'an indexed real resource is required');
  const claim = async () => (await client.query(
    'SELECT * FROM claim_member_content_generation($1,$2,$3)',
    [source.tenant_id, source.content_type, source.source_id]
  )).rows[0];
  const publish = async (claim, rows, tenant = source.tenant_id) => (await client.query(
    'SELECT publish_member_content_knowledge($1,$2,$3,$4,$5,$6::jsonb) AS published',
    [tenant, source.content_type, source.source_id, claim.generation, claim.claim_token, JSON.stringify(rows)]
  )).rows[0].published;
  const first = await claim();
  assert.ok(first.claim_token);
  const rows = ['public', 'authenticated'].map((scope, index) => ({
    ...source, id: null, chunk_index: index, source_generation: first.generation,
    content: `Knowledge acceptance projection ${scope}`, access_scope: scope,
    content_hash: `knowledge-acceptance-${scope}`, embedding_model: 'text-embedding-3-small',
    provenance: { kind: 'knowledge', dependencies: [] },
  }));
  const file = (await client.query(`SELECT s.source_id,s.active_generation FROM member_content_source s
    JOIN file_repository f ON f.id=s.source_id AND f.tenant_id=s.tenant_id
    WHERE s.tenant_id=$1 AND s.content_type='file_repository' AND s.active_generation=s.generation LIMIT 1`,
  [source.tenant_id])).rows[0];
  assert.ok(file,'an active tenant-owned file dependency is required');
  rows.push({ ...rows[1],chunk_index:2,content:'Protected PDF acceptance evidence',content_hash:'acceptance-pdf',
    provenance:{kind:'resource_pdf',fileId:file.source_id,page:1,
      dependencies:[{contentType:'file_repository',sourceId:file.source_id,generation:Number(file.active_generation)}]} });
  assert.equal(await publish(first,rows,'a1000000-0000-4000-8000-000000000099'),false,'cross-tenant publication denied');
  assert.equal(await publish(first, rows), true);
  const visible = (await client.query(`
    SELECT id,access_scope,is_active,source_generation FROM member_content_chunk
    WHERE tenant_id=$1 AND content_type=$2 AND source_id=$3 ORDER BY chunk_index
  `, [source.tenant_id,source.content_type,source.source_id])).rows;
  assert.deepEqual(visible.map(r=>r.access_scope), ['public','authenticated','authenticated']);
  assert.ok(visible.every(r=>r.is_active));
  assert.equal(await publish(first, rows), false, 'completed claims cannot publish twice');
  const second = await claim();
  assert.equal(await publish(second, rows), true);
  const ids = (await client.query(`SELECT id FROM member_content_chunk
    WHERE tenant_id=$1 AND content_type=$2 AND source_id=$3 ORDER BY chunk_index`,
  [source.tenant_id,source.content_type,source.source_id])).rows;
  assert.deepEqual(ids.map(r=>r.id),visible.map(r=>r.id),'unchanged generation preserves citation IDs');
  const stale = await claim();
  await client.query(`UPDATE member_content_source SET active_generation=NULL
    WHERE tenant_id=$1 AND content_type='file_repository' AND source_id=$2`,[source.tenant_id,file.source_id]);
  assert.equal(await publish(stale,rows),false,'a revoked file cannot be republished from an old extraction');
  await client.query('SELECT invalidate_member_content_source($1,$2,$3)',
    [source.tenant_id,source.content_type,source.source_id]);
  assert.equal(await publish(stale, rows.slice(0,2)),false,'source revocation fences already-claimed work');
  for (const role of ['anon','authenticated']) {
    const allowed = (await client.query(`SELECT has_function_privilege($1,
      'public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)','EXECUTE') AS allowed`,[role])).rows[0];
    assert.equal(allowed.allowed,false);
  }
  console.log('Knowledge publisher DEST rollback probe passed: mixed scopes/PDF, tenant isolation, atomic publication, stable citation IDs, file/source revocation and grants.');
} finally {
  await client.query('ROLLBACK');
  await client.end();
}