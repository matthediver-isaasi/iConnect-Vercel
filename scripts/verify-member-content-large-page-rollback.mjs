// Explicit rollback-only DEST contract verification. Never calls a provider,
// commits a fixture, or changes the publisher. Synthetic vectors are test data.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const client = await connectDestination();
const observer = await connectDestination();
const tenantId = randomUUID();
const sourceId = randomUUID();
const title = 'Rollback-only large-page contract fixture';
const slug = `rollback-contract-${sourceId}`;
const vector = JSON.stringify(Array(1536).fill(0.125));
const digest = value => createHash('sha256').update(value).digest('hex');
let rolledBack = false;
const proof = { project: PROJECT, syntheticFixture: true, providerCalls: 0 };
const count = async (connection, table) => {
  assert.ok(['tenant', 'i_edit_page', 'member_content_source', 'member_content_chunk',
    'member_content_embedding_checkpoint', 'member_content_reindex_job'].includes(table));
  const key = table === 'tenant' ? 'id' : 'tenant_id';
  const result = await connection.query(`SELECT count(*)::int n FROM public.${table} WHERE ${key}=$1`, [tenantId]);
  return result.rows[0].n;
};
try {
  // Read actual deployed authority first; refuse rather than relaxing checks.
  let definition;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.query(`SELECT pg_get_functiondef(
      'public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)'::regprocedure) definition`);
    definition = result.rows[0].definition;
    if (definition.includes("THEN 2000 ELSE 100 END")) break;
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.match(definition, /THEN 2000 ELSE 100 END/, 'Large-page migration must be applied first');
  assert.match(definition, /512000/);
  proof.publisherSha256 = digest(definition);
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await client.query('INSERT INTO public.tenant(id,name,slug) VALUES($1,$2,$3)',
    [tenantId, title, slug]);
  await client.query(`INSERT INTO public.i_edit_page(id,tenant_id,title,slug,status,builder_type,layout_type)
    VALUES($1,$2,$3,$4,'published','iedit','public')`, [sourceId, tenantId, title, slug]);
  await client.query('SET LOCAL ROLE service_role');
  const claimResult = await client.query(
    "SELECT * FROM public.claim_member_content_generation($1,'iedit_page',$2)", [tenantId, sourceId]);
  const { generation, claim_token: token } = claimResult.rows[0];
  assert.ok(token);
  const rows = Array.from({ length: 284 }, (_, chunk_index) => {
    const content = `${title}\n\nSynthetic contract block ${chunk_index}`;
    return {
      tenant_id: tenantId, source_id: sourceId, content_type: 'iedit_page',
      source_generation: Number(generation), chunk_index, title, slug,
      status: 'published', layout_type: 'public', access_scope: 'public',
      content, content_hash: digest(JSON.stringify({ title, content })),
      embedding: vector, embedding_model: 'text-embedding-3-small',
      provenance: {
        kind: 'knowledge', adapter: 'iedit_page', dependencies: [],
        iedit: { sectionKey: digest(`fixture-section-${chunk_index}`),
          contentHash: digest(content), elementId: null, displayDependencies: [], coverage: [] },
      },
    };
  });
  const identity = [tenantId, sourceId, generation, token];
  for (const [offset, size] of [[0, 100], [100, 100], [200, 84]]) {
    const saved = await client.query(`SELECT public.save_member_content_embedding_checkpoints(
      $1,'iedit_page',$2,$3,$4,$5::jsonb) saved`, [...identity, JSON.stringify(rows.slice(offset, offset + size))]);
    assert.equal(saved.rows[0].saved, true);
    const read = await client.query(`SELECT count(*)::int n FROM public.read_member_content_embedding_checkpoints(
      $1,'iedit_page',$2,$3,$4)`, identity);
    assert.equal(read.rows[0].n, offset + size);
    assert.equal(await count(client, 'member_content_chunk'), 0, 'Checkpoint batch entered searchable corpus');
  }
  proof.checkpointBatches = [100, 100, 84];
  proof.searchableRowsBeforePublication = await count(client, 'member_content_chunk');
  const stale = await client.query(`SELECT public.publish_member_content_knowledge(
    $1,'iedit_page',$2,$3,$4,$5::jsonb) published`,
  [tenantId, sourceId, generation, randomUUID(), JSON.stringify(rows)]);
  assert.equal(stale.rows[0].published, false);
  assert.equal(await count(client, 'member_content_chunk'), 0);
  const publication = await client.query(`SELECT public.publish_member_content_knowledge(
    $1,'iedit_page',$2,$3,$4,$5::jsonb) published`, [...identity, JSON.stringify(rows)]);
  assert.equal(publication.rows[0].published, true);
  assert.equal(await count(client, 'member_content_chunk'), 284);
  await client.query('RESET ROLE');
  const active = await client.query(`SELECT active_generation=generation active,
    claim_token IS NULL AND claim_started_at IS NULL released
    FROM public.member_content_source WHERE tenant_id=$1 AND source_id=$2`, [tenantId, sourceId]);
  assert.equal(active.rows[0].active, true);
  assert.equal(active.rows[0].released, true);
  assert.equal(await count(client, 'member_content_embedding_checkpoint'), 0);
  proof.publishedRowsInsideTransaction = 284;
  proof.checkpointsAfterPublication = 0;
  proof.claimReleased = true;
  proof.externalRowsBeforeRollback = await count(observer, 'member_content_chunk');
  assert.equal(proof.externalRowsBeforeRollback, 0, 'Uncommitted rows leaked to another session');
  // A bad last row must not replace or truncate the complete preceding corpus.
  await client.query('SET LOCAL ROLE service_role');
  const nextClaim = await client.query(
    "SELECT * FROM public.claim_member_content_generation($1,'iedit_page',$2)", [tenantId, sourceId]);
  const invalid = structuredClone(rows);
  invalid[283].content = null;
  await client.query('SAVEPOINT invalid_last_row');
  let invalidCode;
  try {
    await client.query(`SELECT public.publish_member_content_knowledge(
      $1,'iedit_page',$2,$3,$4,$5::jsonb)`,
    [tenantId, sourceId, generation, nextClaim.rows[0].claim_token, JSON.stringify(invalid)]);
  } catch (error) {
    invalidCode = error.code;
  }
  await client.query('ROLLBACK TO SAVEPOINT invalid_last_row');
  assert.equal(invalidCode, '22023');
  assert.equal(await count(client, 'member_content_chunk'), 284);
  proof.invalidLastRowPreservedCompleteGeneration = true;
  await client.query('ROLLBACK');
  rolledBack = true;
  proof.remainingFixtureRowsAfterRollback = {};
  for (const table of ['tenant', 'i_edit_page', 'member_content_source', 'member_content_chunk',
    'member_content_embedding_checkpoint', 'member_content_reindex_job']) {
    const remaining = await count(observer, table);
    assert.equal(remaining, 0);
    proof.remainingFixtureRowsAfterRollback[table] = remaining;
  }
  proof.rolledBack = true;
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
  await Promise.all([client.end(), observer.end()]);
}
