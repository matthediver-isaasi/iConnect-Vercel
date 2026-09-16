import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRecoveryArgs,
  reportHasFailures,
  errorCodeFromValue,
  compareChunkFingerprints,
  createDestinationRestClient,
  runRecovery,
} from './recover-member-content-index.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';

test('recovery arguments require UUID tenant and enum type', () => {
  assert.throws(
    () => parseRecoveryArgs(['--tenant=not-a-uuid', '--type=blog_post']),
    { message: 'RECOVERY_TENANT_UUID_REQUIRED' },
  );
  assert.throws(
    () => parseRecoveryArgs([`--tenant=${TENANT}`, '--type=arbitrary']),
    { message: 'RECOVERY_TYPE_INVALID' },
  );
  assert.deepEqual(
    parseRecoveryArgs([`--tenant=${TENANT}`, '--type=blog_post']),
    {
      apply: false,
      repeat: false,
      transport: 'pg',
      tenant: TENANT,
      type: 'blog_post',
      maxItems: 2,
      seconds: 20,
      cursor: null,
      reportPath: null,
    },
  );
  assert.deepEqual(
    parseRecoveryArgs([
      `--tenant=${TENANT}`,
      '--type=canvas_page',
      '--transport=rest',
    ]),
    {
      apply: false,
      repeat: false,
      transport: 'rest',
      tenant: TENANT,
      type: 'canvas_page',
      maxItems: 2,
      seconds: 20,
      cursor: null,
      reportPath: null,
    },
  );
  assert.throws(
    () => parseRecoveryArgs([`--tenant=${TENANT}`, '--type=blog_post', '--transport=wat']),
    { message: 'RECOVERY_TRANSPORT_INVALID' },
  );
});

test('max item and time budgets are strictly bounded', () => {
  assert.equal(
    parseRecoveryArgs([
      `--tenant=${TENANT}`,
      '--type=all',
      '--max-items=5',
      '--seconds=30',
      '--repeat',
      '--cursor={"type":"blog_post","lastId":"x"}',
      '--report=/tmp/report.json',
      '--apply',
    ]).maxItems,
    5,
  );
  assert.throws(
    () => parseRecoveryArgs([`--tenant=${TENANT}`, '--type=blog_post', '--max-items=6']),
    { message: 'RECOVERY_MAX_ITEMS_INVALID' },
  );
  assert.throws(
    () => parseRecoveryArgs([`--tenant=${TENANT}`, '--type=blog_post', '--seconds=31']),
    { message: 'RECOVERY_SECONDS_INVALID' },
  );
  assert.throws(
    () => parseRecoveryArgs([`--tenant=${TENANT}`, '--type=blog_post', '--max-items=0']),
    { message: 'RECOVERY_MAX_ITEMS_INVALID' },
  );
});

test('nested run failures are visible to the CLI exit decision', () => {
  assert.equal(
    reportHasFailures({
      first: { errorCodes: ['MEMBER_CONTENT_EMBEDDING_BUDGET'] },
      repeat: null,
    }),
    true,
  );
  assert.equal(
    reportHasFailures({
      first: { errorCodes: [] },
      repeat: {
        result: { errorCodes: ['MEMBER_CONTENT_GENERATION_STALE'] },
      },
    }),
    true,
  );
  assert.equal(
    reportHasFailures({
      errorCodes: [],
      first: { errorCodes: [] },
      repeat: { result: { errorCodes: [] } },
    }),
    false,
  );
});

test('SQLSTATE detail codes are retained in source-free reports', () => {
  assert.equal(errorCodeFromValue({ code: '22P02', message: 'invalid jsonb' }), '22P02');
  assert.equal(errorCodeFromValue({ error: 'pg rejected value (22P02)' }), '22P02');
  assert.equal(errorCodeFromValue('MEMBER_CONTENT_EMBEDDING_BUDGET: no vector'), 'MEMBER_CONTENT_EMBEDDING_BUDGET');
});

test('repeat compares first-after to repeat-after and flags real drift', () => {
  const stable = {
    rows: 1,
    fingerprint: 'id-created-hash-access',
    hashFingerprint: 'hash-access',
  };
  assert.equal(
    compareChunkFingerprints(
      { before: stable, after: stable },
      { before: { ...stable, fingerprint: 'new-generation-id' }, after: stable },
    ),
    true,
  );
  assert.equal(
    compareChunkFingerprints(
      { after: stable },
      { after: { ...stable, fingerprint: 'drifted-id' } },
    ),
    false,
  );
  assert.equal(
    reportHasFailures({
      errorCodes: ['MEMBER_CONTENT_REPEAT_FINGERPRINT_DRIFT'],
      first: { errorCodes: [] },
      repeat: { result: { errorCodes: ['MEMBER_CONTENT_REPEAT_FINGERPRINT_DRIFT'] } },
    }),
    true,
  );
});

test('REST client factory pins destination hostname without logging credentials', () => {
  const calls = [];
  const secret = 'destination-secret-that-must-not-be-printed';
  const client = createDestinationRestClient({
    env: {
      DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
      DEST_SUPABASE_KEY: secret,
    },
    createClient: (...args) => {
      calls.push(args);
      return { kind: 'rest-client' };
    },
  });
  assert.deepEqual(client, { kind: 'rest-client' });
  assert.equal(calls[0][0], 'https://lvmzliemqnieeoruhkik.supabase.co');
  assert.equal(calls[0][1], secret);
  assert.equal(calls[0][2].auth.persistSession, false);
  assert.throws(
    () =>
      createDestinationRestClient({
        env: {
          DEST_SUPABASE_URL: 'https://evil.supabase.co',
          DEST_SUPABASE_KEY: secret,
        },
        createClient: () => ({ kind: 'never' }),
      }),
    { message: 'RECOVERY_DEST_SUPABASE_URL_INVALID' },
  );
});

test('PG transport rejects Canvas and all before opening a database', async () => {
  let connected = false;
  await assert.rejects(
    runRecovery(
      {
        transport: 'pg',
        tenant: TENANT,
        type: 'canvas_page',
        apply: true,
        repeat: false,
        maxItems: 1,
        seconds: 1,
        cursor: null,
      },
      {
        connect: async () => {
          connected = true;
          return { query() {}, end() {} };
        },
      },
    ),
    { code: 'RECOVERY_REST_TRANSPORT_REQUIRED' },
  );
  assert.equal(connected, false);
});
