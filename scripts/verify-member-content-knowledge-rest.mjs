// Explicit isolated fixture test against DEST REST. Creates one temporary tenant
// and resource, never reads/mutates a live source, and always removes the fixture.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';
import { createDestinationRestClient } from './recover-member-content-index.mjs';
import { reindexMemberContentItem, buildMemberContentMetadata } from '../api/_lib/memberContentIndexer.js';
import { chunkMemberContent } from '../api/_lib/memberContentChunker.js';

if (!process.argv.includes('--isolated-fixtures')) throw new Error('Pass --isolated-fixtures to authorize temporary DEST test data');
const tenant = crypto.randomUUID();
const sourceId = crypto.randomUUID();
const client = await connectDestination();
const supabase = createDestinationRestClient();
let providerCalls = 0;
const provider = { embeddings: { create: async () => {
  providerCalls++;
  throw new Error('Fixture must never contact an embedding provider');
} } };
async function rpc(name,args) {
  const {data,error} = await supabase.rpc(name,args);
  if (error) throw Object.assign(new Error(`REST ${name} failed`),{code:error.code});
  return Array.isArray(data) ? data[0] : data;
}
const identity = {p_tenant_id:tenant,p_content_type:'resource',p_source_id:sourceId};
try {
  await client.query('INSERT INTO tenant(id,name) VALUES($1,$2)',[tenant,`knowledge-isolated-rest-${tenant}`]);
  const source = (await client.query(`INSERT INTO resource(id,tenant_id,title,resource_type,target_url,status,description,is_public)
    VALUES($1,$2,'Knowledge isolated REST fixture','article','/fixture','active','Isolated fixture text.',true) RETURNING *`,
  [sourceId,tenant])).rows[0];
  const claim = await rpc('claim_member_content_generation',identity);
  assert.ok(claim.claim_token);
  const chunks = chunkMemberContent(source,'resource');
  const rows = chunks.map(chunk=>({
    ...buildMemberContentMetadata('resource',source),
    chunk_index:chunk.chunkIndex,content:chunk.content,access_scope:'public',
    source_generation:claim.generation,embedding_model:'text-embedding-3-small',
    embedding:`[${Array(1536).fill(0).join(',')}]`,
    content_hash:crypto.createHash('sha256').update(JSON.stringify({title:source.title,content:chunk.content})).digest('hex'),
    provenance:{kind:'knowledge',dependencies:[]},
  }));
  const payload = {...identity,p_generation:claim.generation,p_claim_token:claim.claim_token,p_rows:rows};
  assert.equal(await rpc('publish_member_content_knowledge',payload),true);
  assert.equal(await rpc('publish_member_content_knowledge',payload),false,'a consumed claim cannot publish again');
  const before = (await client.query('SELECT id FROM member_content_chunk WHERE tenant_id=$1',[tenant])).rows;
  const result = await reindexMemberContentItem('resource',{id:sourceId,tenant_id:tenant},{
    supabase,openai:provider,embeddingBudget:{maxEmbeddingChunks:0},
  });
  assert.equal(result.embedded,0);
  assert.equal(result.reused,chunks.length);
  assert.deepEqual((await client.query('SELECT id FROM member_content_chunk WHERE tenant_id=$1',[tenant])).rows,before);
  const stale = await rpc('claim_member_content_generation',identity);
  const changed = await supabase.from('resource').update({description:'Changed isolated fixture text.'})
    .eq('tenant_id',tenant).eq('id',sourceId);
  assert.ifError(changed.error);
  assert.equal(await rpc('publish_member_content_knowledge',{
    ...payload,p_generation:stale.generation,p_claim_token:stale.claim_token,
  }),false,'real REST source update invalidates an in-flight claim');
  await assert.rejects(reindexMemberContentItem('resource',{id:sourceId,tenant_id:tenant},{
    supabase,openai:provider,embeddingBudget:{maxEmbeddingChunks:0},
  }),{code:'MEMBER_CONTENT_EMBEDDING_BUDGET'});
  const registry = (await client.query('SELECT active_generation,claim_token FROM member_content_source WHERE tenant_id=$1',[tenant])).rows[0];
  assert.equal(registry.active_generation,null);
  assert.equal(registry.claim_token,null,'failed zero-budget work releases its own claim');
  for (const role of ['anon','authenticated','service_role']) {
    const allowed = (await client.query(`SELECT has_function_privilege($1,
      'public.publish_member_content_knowledge(uuid,text,uuid,bigint,uuid,jsonb)','EXECUTE') AS allowed`,[role])).rows[0].allowed;
    assert.equal(allowed,role==='service_role');
  }
  assert.equal(providerCalls,0);
  console.log('Actual DEST REST fixture passed: publication/reuse, claims, revocation, restricted grants, zero provider calls.');
} finally {
  // Source deletion triggers a final invalidation/job, so remove it before the
  // polymorphic registry rows. Every cleanup statement targets our random UUID.
  await client.query('DELETE FROM resource WHERE tenant_id=$1',[tenant]);
  for (const table of ['member_content_chunk','member_content_reindex_job','member_content_source']) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
  }
  await client.query('DELETE FROM tenant WHERE id=$1',[tenant]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM tenant WHERE id=$1',[tenant])).rows[0].n,0);
  await client.end();
  console.log('Isolated REST fixture cleanup verified; no live content mutated.');
}