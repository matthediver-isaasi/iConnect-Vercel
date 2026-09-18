import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFormEntityPipelines } from './formEntityPipelines.js';

test('observation polls never dispatch entity processing, including duplicate concurrent resumptions', async () => {
  const previousUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://internal.invalid';
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('unexpected entity replay'); };
  try {
    for (const status of ['waiting', 'attention', 'done']) {
      const db = {
        rpc: async (name) => {
          assert.equal(name, 'observe_or_begin_form_paid_pipeline_operation');
          return { data: { status }, error: null };
        },
        from() {
          const query = {
            select: () => query, eq: () => query,
            maybeSingle: async () => ({ data: { created_member_id: 'durable-member', payment_meta: {} } }),
          };
          return query;
        },
      };
      const results = await Promise.all(Array.from({ length: 2 }, () => runFormEntityPipelines({
        supabase: db,
        submission: {
          id: 's', tenant_id: 't',
          payment_meta: { completion: { awaiting_pipeline: { operation_id: 'original-owner' } } },
        },
        // Even a subsequent form configuration edit cannot bypass observation.
        form: { id: 'f', entity_pipelines: {} },
        completionOperationId: 'new-owner', observeLateSuccess: true,
      })));
      for (const result of results) {
        assert.equal(result.failed, status !== 'done');
        assert.equal(result.awaitingOperation === true, status === 'waiting');
        assert.equal(result.ambiguous === true, status === 'attention');
        assert.equal(result.memberId, status === 'done' ? 'durable-member' : null);
      }
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousUrl;
  }
});

test('observation migration fences identity/owner and retains existing queue states', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261110_paid_pipeline_late_success.sql', import.meta.url), 'utf8');
  assert.match(sql, /owner_token' IS DISTINCT FROM p_operation_id::TEXT/);
  assert.match(sql, /operation_id::TEXT IS DISTINCT FROM v_wait->>'operation_id'/);
  assert.match(sql, /v_operation.status = 'done'/);
  assert.match(sql, /INTERVAL '10 minutes'/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /SET status = 'processing'/);
});