import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMemberIndexPgClient,
  MEMBER_INDEX_RPC_ARGUMENTS,
} from './member-index-pg-client.mjs';
import { writeMemberContentGeneration } from '../../api/_lib/memberContentGenerationWriter.js';

class FakePg {
  constructor(result = { rows: [] }) {
    this.result = result;
    this.calls = [];
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';

test('read builder allowlists identifiers and parameterizes malicious values', async () => {
  const pg = new FakePg({ rows: [{ id: SOURCE }] });
  const facade = createMemberIndexPgClient({ client: pg });
  const malicious = `${TENANT}' OR 1=1 --`;

  const result = await facade
    .from('blog_post')
    .select('id, tenant_id, title')
    .eq('tenant_id', malicious)
    .gt('id', SOURCE)
    .order('id', { ascending: true })
    .limit(2);

  assert.deepEqual(result.data, [{ id: SOURCE }]);
  assert.equal(result.error, null);
  assert.equal(pg.calls.length, 1);
  const { sql, values } = pg.calls[0];
  assert.match(sql, /SELECT "id", "tenant_id", "title"/);
  assert.match(sql, /WHERE "tenant_id" = \$1 AND "id" > \$2/);
  assert.match(sql, /LIMIT \$3/);
  assert.deepEqual(values, [malicious, SOURCE, 2]);
  assert.equal(sql.includes(malicious), false);
});

test('unknown tables, columns, and select expressions are rejected', () => {
  const facade = createMemberIndexPgClient({ client: new FakePg() });
  assert.throws(() => facade.from('member_content_chunk; DROP TABLE resource'), {
    message: 'MEMBER_INDEX_TABLE_NOT_ALLOWED',
  });
  assert.throws(
    () => facade.from('blog_post').select('id, (SELECT secret FROM users)'),
    { message: 'MEMBER_INDEX_COLUMN_NOT_ALLOWED' },
  );
  assert.throws(() => facade.from('blog_post').select('*'), {
    message: 'MEMBER_INDEX_COLUMN_NOT_ALLOWED',
  });
});

test('member_content_chunk has no mutation methods', () => {
  const facade = createMemberIndexPgClient({ client: new FakePg() });
  const chunks = facade.from('member_content_chunk');
  assert.equal(typeof chunks.update, 'undefined');
  assert.equal(typeof chunks.delete, 'undefined');
  assert.equal(typeof chunks.insert, 'undefined');
  assert.equal(typeof chunks.upsert, 'undefined');
});

test('source release is the only permitted update and uses claim-token CAS', async () => {
  const pg = new FakePg({ rows: [], rowCount: 1 });
  const facade = createMemberIndexPgClient({ client: pg });
  const token = '33333333-3333-4333-8333-333333333333';

  const result = await facade
    .from('member_content_source')
    .update({ claim_token: null, claim_started_at: null })
    .eq('tenant_id', TENANT)
    .eq('content_type', 'blog_post')
    .eq('source_id', SOURCE)
    .eq('generation', 2)
    .eq('claim_token', token);

  assert.equal(result.error, null);
  assert.equal(pg.calls.length, 1);
  assert.match(
    pg.calls[0].sql,
    /UPDATE "public"\."member_content_source" SET "claim_token" = \$1, "claim_started_at" = \$2/,
  );
  assert.match(
    pg.calls[0].sql,
    /"tenant_id" = \$3 AND "content_type" = \$4 AND "source_id" = \$5 AND "generation" = \$6 AND "claim_token" = \$7/,
  );
  assert.deepEqual(pg.calls[0].values, [null, null, TENANT, 'blog_post', SOURCE, 2, token]);

  assert.throws(
    () =>
      facade
        .from('member_content_source')
        .update({ claim_token: null, claim_started_at: 'not-null' }),
    { message: 'MEMBER_INDEX_SOURCE_UPDATE_NOT_ALLOWED' },
  );
  await assert.rejects(
    facade
      .from('member_content_source')
      .update({ claim_token: null, claim_started_at: null })
      .eq('tenant_id', TENANT),
    { message: 'MEMBER_INDEX_SOURCE_CAS_REQUIRED' },
  );
});

test('only generation claim and publish RPCs are callable with exact arguments', async () => {
  const pg = new FakePg({ rows: [{ published: true }] });
  const facade = createMemberIndexPgClient({ client: pg });
  assert.deepEqual(
    MEMBER_INDEX_RPC_ARGUMENTS.publish_member_content_repair,
    ['p_tenant_id', 'p_content_type', 'p_source_id', 'p_generation', 'p_claim_token', 'p_rows'],
  );

  await facade.rpc('claim_member_content_generation', {
    p_tenant_id: TENANT,
    p_content_type: 'blog_post',
    p_source_id: SOURCE,
  });
  await facade.rpc('publish_member_content_repair', {
    p_tenant_id: TENANT,
    p_content_type: 'blog_post',
    p_source_id: SOURCE,
    p_generation: '1',
    p_claim_token: '33333333-3333-4333-8333-333333333333',
    p_rows: [{ tenant_id: TENANT, source_id: SOURCE, chunk_index: 0 }],
  });

  assert.equal(pg.calls.length, 2);
  assert.match(pg.calls[0].sql, /public\.claim_member_content_generation/);
  assert.match(pg.calls[1].sql, /public\.publish_member_content_repair/);
  assert.deepEqual(pg.calls[0].values, [TENANT, 'blog_post', SOURCE]);
  assert.deepEqual(pg.calls[1].values.slice(0, 5), [
    TENANT,
    'blog_post',
    SOURCE,
    '1',
    '33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(
    pg.calls[1].values[5],
    JSON.stringify([{ tenant_id: TENANT, source_id: SOURCE, chunk_index: 0 }]),
  );

  assert.throws(
    () => facade.rpc('exec_sql', { sql: 'DROP TABLE member_content_chunk' }),
    { message: 'MEMBER_INDEX_RPC_NOT_ALLOWED' },
  );
  assert.throws(
    () =>
      facade.rpc('publish_member_content_repair', {
        p_tenant_id: TENANT,
        p_content_type: 'blog_post',
        p_source_id: SOURCE,
        p_generation: 2,
        p_claim_token: '33333333-3333-4333-8333-333333333333',
        p_rows: [{ content: 'x', arbitrary: 'injection' }],
      }),
    { message: 'MEMBER_INDEX_REPAIR_ROW_COLUMN_NOT_ALLOWED' },
  );
  assert.throws(
    () =>
      facade.rpc('publish_member_content_repair', {
        p_tenant_id: TENANT,
        p_content_type: 'blog_post',
        p_source_id: SOURCE,
        p_generation: '01',
        p_claim_token: '33333333-3333-4333-8333-333333333333',
        p_rows: [],
      }),
    { message: 'MEMBER_INDEX_RPC_ARGUMENTS_INVALID' },
  );
  await facade.rpc('publish_member_content_repair', {
    p_tenant_id: TENANT,
    p_content_type: 'blog_post',
    p_source_id: SOURCE,
    p_generation: '9223372036854775807',
    p_claim_token: '33333333-3333-4333-8333-333333333333',
    p_rows: [],
  });
  assert.throws(
    () =>
      facade.rpc('publish_member_content_repair', {
        p_tenant_id: TENANT,
        p_content_type: 'blog_post',
        p_source_id: SOURCE,
        p_generation: '9223372036854775808',
        p_claim_token: '33333333-3333-4333-8333-333333333333',
        p_rows: [],
      }),
    { message: 'MEMBER_INDEX_RPC_ARGUMENTS_INVALID' },
  );
});

test('publisher readiness probe is the only all-null RPC allowed read-only', async () => {
  const pg = new FakePg({ rows: [{ publish_member_content_repair: false }] });
  const facade = createMemberIndexPgClient({ client: pg, allowWrites: false });
  const result = await facade.rpc('publish_member_content_repair', {
    p_tenant_id: null,
    p_content_type: null,
    p_source_id: null,
    p_generation: null,
    p_claim_token: null,
    p_rows: [],
  });

  assert.deepEqual(result, { data: false, error: null });
  assert.equal(pg.calls.length, 1);
  assert.match(
    pg.calls[0].sql,
    /public\.publish_member_content_repair\(\$1::uuid, \$2::text, \$3::uuid, \$4::bigint, \$5::uuid, \$6::jsonb\)/,
  );
  assert.deepEqual(pg.calls[0].values, [null, null, null, null, null, '[]']);

  assert.throws(
    () =>
      facade.rpc('publish_member_content_repair', {
        p_tenant_id: null,
        p_content_type: null,
        p_source_id: null,
        p_generation: null,
        p_claim_token: null,
        p_rows: [{ chunk_index: 0 }],
      }),
    { message: 'MEMBER_INDEX_RPC_ARGUMENTS_INVALID' },
  );
  assert.throws(
    () =>
      facade.rpc('claim_member_content_generation', {
        p_tenant_id: null,
        p_content_type: null,
        p_source_id: null,
      }),
    { message: 'MEMBER_INDEX_RPC_ARGUMENTS_INVALID' },
  );
});

test('database errors return an error code without exposing error text', async () => {
  const pgError = Object.assign(new Error('secret source text'), { code: '42501' });
  const facade = createMemberIndexPgClient({ client: new FakePg(pgError) });
  const result = await facade.from('blog_post').select('id').limit(1);
  assert.deepEqual(result, { data: null, error: { code: '42501' } });
  assert.equal(JSON.stringify(result).includes('secret source text'), false);
});

test('maybeSingle treats zero rows as a normal missing row', async () => {
  const pg = new FakePg({ rows: [] });
  const facade = createMemberIndexPgClient({ client: pg });
  const result = await facade
    .from('blog_post')
    .select('id')
    .eq('tenant_id', TENANT)
    .maybeSingle();
  assert.deepEqual(result, { data: null, error: null });
  assert.match(pg.calls[0].sql, /LIMIT \$2/);
});

test('chunk fingerprint ignores expected lease token and updated-at churn', async () => {
  const base = {
    id: SOURCE,
    created_at: '2026-01-01T00:00:00.000Z',
    content_type: 'blog_post',
    source_id: SOURCE,
    chunk_index: 0,
    content_hash: 'same-hash',
    embedding_model: 'text-embedding-3-small',
    provenance: { kind: 'authored_repair', generation: '1' },
    source_generation: '1',
    is_active: true,
    status: 'published',
    feature_key: 'content.articles',
    activation_token: 'lease-a',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  const pg = {
    calls: [],
    row: base,
    async query(sql, values) {
      this.calls.push({ sql, values });
      return { rows: [this.row] };
    },
  };
  const facade = createMemberIndexPgClient({ client: pg });
  const first = await facade.readScopedChunkFingerprint({
    tenantId: TENANT,
    contentType: 'blog_post',
  });
  const sql = pg.calls[0] ? pg.calls[0].sql : '';
  assert.match(sql, /"created_at"/);
  assert.match(sql, /"content_hash"/);
  assert.match(sql, /"embedding_model"/);
  assert.match(sql, /"provenance"/);
  assert.match(sql, /"access_scope"/);
  assert.doesNotMatch(sql, /"metadata"|"source"|"updated_at"|"activation_token"/);
  assert.equal(sql.includes('activation_token'), false);
  assert.equal(sql.includes('"updated_at"'), false);
  pg.row = {
    ...base,
    activation_token: 'lease-b',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
  const leaseChurn = await facade.readScopedChunkFingerprint({
    tenantId: TENANT,
    contentType: 'blog_post',
  });
  assert.deepEqual(leaseChurn.data, first.data);

  pg.row = { ...pg.row, content_hash: 'changed-hash' };
  const contentDrift = await facade.readScopedChunkFingerprint({
    tenantId: TENANT,
    contentType: 'blog_post',
  });
  assert.notEqual(contentDrift.data.fingerprint, first.data.fingerprint);

  pg.row = { ...pg.row, id: '44444444-4444-4444-8444-444444444444' };
  const idDrift = await facade.readScopedChunkFingerprint({
    tenantId: TENANT,
    contentType: 'blog_post',
  });
  assert.notEqual(idDrift.data.fingerprint, contentDrift.data.fingerprint);
});

test('dry-run facade blocks RPC and source updates without issuing SQL', async () => {
  const pg = new FakePg({ rows: [] });
  const facade = createMemberIndexPgClient({ client: pg, allowWrites: false });
  const rpc = await facade.rpc('claim_member_content_generation', {
    p_tenant_id: TENANT,
    p_content_type: 'blog_post',
    p_source_id: SOURCE,
  });
  assert.deepEqual(rpc, {
    data: null,
    error: { code: 'MEMBER_INDEX_DRY_RUN_WRITE_BLOCKED' },
  });
  const release = await facade
    .from('member_content_source')
    .update({ claim_token: null, claim_started_at: null })
    .eq('tenant_id', TENANT)
    .eq('content_type', 'blog_post')
    .eq('source_id', SOURCE)
    .eq('generation', 2)
    .eq('claim_token', '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(release, {
    data: null,
    error: { code: 'MEMBER_INDEX_DRY_RUN_WRITE_BLOCKED' },
  });
  assert.equal(pg.calls.length, 0);
});

test('generation writer releases a budget-failed claim through the guarded CAS', async () => {
  const token = '33333333-3333-4333-8333-333333333333';
  const pg = {
    calls: [],
    async query(sql, values = []) {
      this.calls.push({ sql, values });
      if (sql.includes('publish_member_content_repair')) {
        return { rows: [{ publish_member_content_repair: false }] };
      }
      if (sql.includes('claim_member_content_generation')) {
        return { rows: [{ generation: '1', claim_token: token }] };
      }
      if (sql.includes('FROM "public"."blog_post"')) {
        return {
          rows: [
            {
              id: SOURCE,
              tenant_id: TENANT,
              title: 'Persisted title',
              content: 'Persisted body',
              status: 'published',
            },
          ],
        };
      }
      if (sql.includes('FROM "public"."member_content_chunk"')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE "public"."member_content_source"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  const facade = createMemberIndexPgClient({ client: pg });

  await assert.rejects(
    writeMemberContentGeneration(
      'blog_post',
      { id: SOURCE, tenant_id: TENANT, title: 'stale', content: 'stale', status: 'published' },
      {
        supabase: facade,
        openai: undefined,
        embeddingBudget: { maxEmbeddingChunks: 0 },
      },
    ),
    (error) => error?.code === 'MEMBER_CONTENT_EMBEDDING_BUDGET',
  );

  const release = pg.calls.find((call) =>
    call.sql.includes('UPDATE "public"."member_content_source"'),
  );
  assert.ok(release);
  assert.deepEqual(release.values, [null, null, TENANT, 'blog_post', SOURCE, '1', token]);
  assert.equal(release.sql.includes(TENANT), false);
  assert.equal(release.sql.includes(token), false);
});
