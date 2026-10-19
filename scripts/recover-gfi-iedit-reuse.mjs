// Scoped recovery through the normal fenced publisher. Never purchases embeddings.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
const apply = process.argv.includes('--apply');
assert.ok(process.argv.slice(2).every(arg => arg === '--apply'));
const tenantId = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const peopleId = 'b1012823-fe46-4cc2-98a7-2e40e3c9ce89';
const url = new URL(process.env.DEST_SUPABASE_URL);
assert.equal(url.origin, 'https://lvmzliemqnieeoruhkik.supabase.co');
process.env.SUPABASE_URL = url.origin;
process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
const db = createClient(url.origin, process.env.DEST_SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { reindexMemberContentItem } = await import('../api/_lib/memberContentIndexer.js');
const { revalidateMemberContentCandidates } = await import('../api/_lib/memberContentAccess.js');
const sources = await db.from('member_content_source')
  .select('source_id,generation,active_generation').eq('tenant_id', tenantId)
  .eq('content_type', 'iedit_page').order('source_id').limit(100);
if (sources.error) throw sources.error;
assert.ok(sources.data.length <= 55, 'Scope grew; review before recovery');
const pending = sources.data.filter(s => String(s.generation) !== String(s.active_generation))
  .sort((a,b) => Number(b.source_id === peopleId) - Number(a.source_id === peopleId));
console.log(JSON.stringify({ apply, sources: sources.data.length, pending: pending.length, embeddingBudget: 0 }));
if (apply) {
  for (const source of pending) {
    try {
      const result = await reindexMemberContentItem('iedit_page', { id: source.source_id, tenant_id: tenantId }, {
        supabase: db, embeddingBudget: { maxEmbeddingChunks: 0 },
        openai: { embeddings: { create: async () => { throw new Error('Provider calls forbidden in reuse-only repair'); } } },
      });
      assert.equal(result.embeddingChunksSpent || 0, 0);
      console.log(JSON.stringify({ sourceId: source.source_id, chunks: result.chunks,
        reused: result.reused, deferred: result.deferred, reason: result.reason, removed: result.removed }));
    } catch (error) {
      console.log(JSON.stringify({ sourceId: source.source_id, error: error.code || 'recovery_failed' }));
      process.exitCode = 1;
    }
  }
}
const chunks = await db.from('member_content_chunk').select('*')
  .eq('tenant_id', tenantId).eq('content_type', 'iedit_page').eq('source_id', peopleId).limit(100);
if (chunks.error) throw chunks.error;
const visible = await revalidateMemberContentCandidates({ supabase: db,
  visibilityCtx: { tenantId, isAuthenticated: false, isAdmin: false, roleId: null },
  candidates: chunks.data });
console.log(JSON.stringify({ peopleStoredChunks: chunks.data.length, peopleRetrievableChunks: visible.length,
  boardRetrievableChunks: visible.filter(c => /\bboard\b/i.test(c.content)).length,
  verification: 'normal retrieval access revalidation; not a signed-in model answer' }));
