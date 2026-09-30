import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReindexMemberContentHandler,
  DEFAULT_MAX_EMBEDDING_CHUNKS,
  MAX_ITEMS_PER_SLICE,
} from './reindex-member-content.js';

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

function request(body = {}, overrides = {}) {
  return {
    headers: { authorization: 'Bearer test-cron-secret' },
    query: {},
    body,
    ...overrides,
  };
}

function makeHandler({
  reindex = async () => ({ done: true, nextCursor: null, errors: 0, embedded: 0 }),
  dispatch = async () => ({ ok: true }),
  origin = () => 'https://portal.example',
  onComplete = () => {},
} = {}) {
  const calls = {
    acquire: 0,
    renew: 0,
    complete: [],
    reindex: [],
    dispatch: [],
  };
  const handler = createReindexMemberContentHandler({
    supabase: {},
    getOpenAIClient: () => ({}),
    acquireRun: async () => {
      calls.acquire += 1;
      return { acquired: true, runId: 'run-1' };
    },
    renewRun: async () => {
      calls.renew += 1;
      return { owns: true };
    },
    completeRun: async (value) => {
      calls.complete.push(value);
      onComplete(value);
    },
    reindex: async (options) => {
      calls.reindex.push(options);
      return reindex(options);
    },
    origin,
    dispatch: async (dispatchOrigin, body) => {
      calls.dispatch.push({ dispatchOrigin, body });
      return dispatch(dispatchOrigin, body);
    },
  });
  return { handler, calls };
}

async function withCronSecret(callback) {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret';
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

test('reindex cron fails closed when CRON_SECRET is absent', async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  let indexed = false;
  try {
    const { handler } = makeHandler({
      reindex: async () => {
        indexed = true;
        return { done: true, nextCursor: null, errors: 0, embedded: 0 };
      },
    });
    const res = responseRecorder();
    await handler(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'Cron authentication is not configured');
    assert.equal(indexed, false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('reindex cron rejects malformed or over-ceiling incoming budgets before indexing', async () => {
  await withCronSecret(async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 21, 1.5, '2', null]) {
      let indexed = false;
      const { handler } = makeHandler({
        reindex: async () => {
          indexed = true;
          return { done: true, nextCursor: null, errors: 0, embedded: 0 };
        },
      });
      const res = responseRecorder();
      await handler(request({ maxEmbeddingChunks: value }), res);
      assert.equal(res.statusCode, 400, `expected 400 for ${String(value)}`);
      assert.match(res.body.error, /maxEmbeddingChunks/);
      assert.equal(indexed, false);
    }
  });
});

test('default budget is passed to each slice and only the remaining allowance is continued', async () => {
  await withCronSecret(async () => {
    const { handler, calls } = makeHandler({
      reindex: async () => ({
        done: false,
        nextCursor: { type: 'blog_post', lastId: 'blog-5' },
        errors: 0,
        embedded: 5,
      }),
    });
    const res = responseRecorder();
    await handler(request(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.reindex.length, 1);
    assert.equal(calls.reindex[0].maxItems, MAX_ITEMS_PER_SLICE);
    assert.equal(
      calls.reindex[0].maxEmbeddingChunks,
      DEFAULT_MAX_EMBEDDING_CHUNKS
    );
    assert.equal(calls.dispatch.length, 1);
    assert.deepEqual(calls.dispatch[0], {
      dispatchOrigin: 'https://portal.example',
      body: {
        tenantId: null,
        contentType: null,
        cursor: { type: 'blog_post', lastId: 'blog-5' },
        hop: 1,
        runId: 'run-1',
        maxEmbeddingChunks: 15,
      },
    });
    assert.equal(res.body.embeddingChunksSpent, 5);
    assert.equal(res.body.embeddingChunksRemaining, 15);
    assert.equal(res.body.embeddingBudget.remaining, 15);
    assert.equal(calls.complete.length, 0);
  });
});

test('provider-spent chunks are counted even when embedded successes are zero', async () => {
  await withCronSecret(async () => {
    const { handler, calls } = makeHandler({
      reindex: async () => ({
        done: false,
        nextCursor: { type: 'blog_post', lastId: 'blog-1' },
        errors: 1,
        embedded: 0,
        embeddingChunksSpent: 3,
        stopReason: 'embedding_budget',
      }),
    });
    const res = responseRecorder();
    await handler(request({ maxEmbeddingChunks: 7 }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stopReason, 'embedding_budget');
    assert.deepEqual(res.body.nextCursor, {
      type: 'blog_post',
      lastId: 'blog-1',
    });
    assert.equal(res.body.embeddingChunksSpent, 3);
    assert.equal(res.body.embeddingChunksRemaining, 4);
    assert.deepEqual(res.body.continuation, {
      dispatched: false,
      reason: 'embedding_budget',
    });
    assert.equal(calls.dispatch.length, 0);
    assert.deepEqual(calls.complete, [
      { supabase: {}, runId: 'run-1', completed: false },
    ]);
  });
});

test('explicit zero budget is forwarded and remains bounded', async () => {
  await withCronSecret(async () => {
    const { handler, calls } = makeHandler({
      reindex: async (options) => ({
        done: false,
        nextCursor: { type: 'blog_post', lastId: null },
        errors: 1,
        embedded: 0,
        stopReason: 'embedding_budget',
        receivedBudget: options.maxEmbeddingChunks,
      }),
    });
    const res = responseRecorder();
    await handler(request({ maxEmbeddingChunks: 0 }), res);
    assert.equal(calls.reindex[0].maxEmbeddingChunks, 0);
    assert.equal(res.body.receivedBudget, 0);
    assert.equal(res.body.embeddingChunksRemaining, 0);
    assert.equal(calls.dispatch.length, 0);
  });
});