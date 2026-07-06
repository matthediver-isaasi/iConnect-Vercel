// Task #2363 — regression tests for the Member AI index reconcile path.
//
// The critical guarantee: content hard-deleted OUTSIDE the on-save hooks (e.g.
// the multi-step event deletion flow) must not leave orphaned chunks that the
// assistant could still retrieve and cite. These tests drive
// sweepOrphanedMemberContentChunks + deleteMemberContentChunks against a small
// fake Supabase query builder so the orphan-detection logic is covered without a
// live DB. Run: node --test api/_lib/memberContentIndexer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sweepOrphanedMemberContentChunks,
  deleteMemberContentChunks,
} from './memberContentIndexer.js';

// Minimal thenable query-builder mock. `handler(state)` receives the accumulated
// query state and returns { data, error, count }.
function makeSupabaseMock(handler) {
  function builder(table) {
    const state = { table, op: 'select', filters: {}, range: null };
    const b = {
      select(cols) {
        state.op = 'select';
        state.cols = cols;
        return b;
      },
      delete(opts) {
        state.op = 'delete';
        state.deleteOpts = opts;
        return b;
      },
      eq(col, val) {
        state.filters[col] = val;
        return b;
      },
      in(col, vals) {
        state.filters[`in:${col}`] = vals;
        return b;
      },
      order() {
        return b;
      },
      range(from, to) {
        state.range = [from, to];
        return b;
      },
      then(resolve, reject) {
        try {
          resolve(handler(state));
        } catch (err) {
          reject(err);
        }
      },
    };
    return b;
  }
  return { from: (t) => builder(t) };
}

test('sweep purges chunks whose source row no longer exists', async () => {
  const deletes = [];
  let chunkPage = 0;

  const supabase = makeSupabaseMock((state) => {
    if (state.table === 'member_content_chunk' && state.op === 'select') {
      // First page: two indexed sources; second page: empty (end).
      if (chunkPage++ === 0) {
        return { data: [{ source_id: 'b1' }, { source_id: 'b2' }], error: null };
      }
      return { data: [], error: null };
    }
    if (state.table === 'blog_post' && state.op === 'select') {
      // Only b1 still exists; b2 was hard-deleted.
      return { data: [{ id: 'b1' }], error: null };
    }
    if (state.table === 'member_content_chunk' && state.op === 'delete') {
      deletes.push(state.filters);
      return { data: null, error: null, count: 3 };
    }
    throw new Error(`unexpected query: ${JSON.stringify(state)}`);
  });

  const summary = await sweepOrphanedMemberContentChunks({
    supabase,
    contentType: 'blog_post',
  });

  assert.equal(summary.removedSources, 1);
  assert.equal(summary.removedChunks, 3);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].content_type, 'blog_post');
  assert.equal(deletes[0].source_id, 'b2');
});

test('sweep removes nothing when every source still exists', async () => {
  const deletes = [];
  let chunkPage = 0;

  const supabase = makeSupabaseMock((state) => {
    if (state.table === 'member_content_chunk' && state.op === 'select') {
      if (chunkPage++ === 0) {
        return { data: [{ source_id: 'b1' }], error: null };
      }
      return { data: [], error: null };
    }
    if (state.table === 'blog_post' && state.op === 'select') {
      return { data: [{ id: 'b1' }], error: null };
    }
    if (state.table === 'member_content_chunk' && state.op === 'delete') {
      deletes.push(state.filters);
      return { data: null, error: null, count: 0 };
    }
    throw new Error(`unexpected query: ${JSON.stringify(state)}`);
  });

  const summary = await sweepOrphanedMemberContentChunks({
    supabase,
    contentType: 'blog_post',
  });

  assert.equal(summary.removedSources, 0);
  assert.equal(summary.removedChunks, 0);
  assert.equal(deletes.length, 0);
});

test('sweep scopes source existence + delete by tenant when tenantId given', async () => {
  const seen = [];
  let chunkPage = 0;

  const supabase = makeSupabaseMock((state) => {
    seen.push(state);
    if (state.table === 'member_content_chunk' && state.op === 'select') {
      if (chunkPage++ === 0) return { data: [{ source_id: 'e9' }], error: null };
      return { data: [], error: null };
    }
    if (state.table === 'event' && state.op === 'select') {
      return { data: [], error: null }; // e9 gone in this tenant
    }
    if (state.table === 'member_content_chunk' && state.op === 'delete') {
      return { data: null, error: null, count: 2 };
    }
    throw new Error(`unexpected query: ${JSON.stringify(state)}`);
  });

  const summary = await sweepOrphanedMemberContentChunks({
    supabase,
    tenantId: 'tenant-1',
    contentType: 'event',
  });

  assert.equal(summary.removedSources, 1);
  const del = seen.find((s) => s.table === 'member_content_chunk' && s.op === 'delete');
  assert.equal(del.filters.tenant_id, 'tenant-1');
  const src = seen.find((s) => s.table === 'event' && s.op === 'select');
  assert.equal(src.filters.tenant_id, 'tenant-1');
});

test('deleteMemberContentChunks applies tenant scope when provided', async () => {
  let captured = null;
  const supabase = makeSupabaseMock((state) => {
    captured = state;
    return { data: null, error: null };
  });

  await deleteMemberContentChunks('event', 'e1', {
    supabase,
    tenantId: 'tenant-1',
  });

  assert.equal(captured.op, 'delete');
  assert.equal(captured.filters.content_type, 'event');
  assert.equal(captured.filters.source_id, 'e1');
  assert.equal(captured.filters.tenant_id, 'tenant-1');
});

test('deleteMemberContentChunks omits tenant filter when not given', async () => {
  let captured = null;
  const supabase = makeSupabaseMock((state) => {
    captured = state;
    return { data: null, error: null };
  });

  await deleteMemberContentChunks('event', 'e1', { supabase });

  assert.equal(captured.filters.tenant_id, undefined);
  assert.equal(captured.filters.source_id, 'e1');
});
