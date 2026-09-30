import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionVerificationOptIn,
  createAuditedReadOnlyQuery,
  productionPgClientOptions,
} from './_lib/productionReadOnlyVerification.mjs';
import { main } from './verify-custom-object-relationship-list-live.mjs';

const PROJECT = 'lvmzliemqnieeoruhkik';
const validEnvironment = {
  ICONNECT_PRODUCTION_READ_ONLY_VERIFY: 'custom-object-relationship-list',
  ICONNECT_PRODUCTION_VERIFY_TENANT_ID: '69c638d8-e2e8-45e7-9836-1a73298d7c09',
  DEST_SUPABASE_URL: `https://${PROJECT}.supabase.co`,
  DEST_DATABASE_URL: `postgresql://postgres.${PROJECT}:secret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`,
};

test('production verification requires exact opt-in before connection details are returned', () => {
  assert.throws(
    () => assertProductionVerificationOptIn({
      ...validEnvironment,
      ICONNECT_PRODUCTION_READ_ONLY_VERIFY: '',
    }),
    /Refusing production verification.*set ICONNECT_PRODUCTION_READ_ONLY_VERIFY/,
  );
});

test('missing opt-in is rejected before a database client is constructed or connected', async () => {
  let constructed = false;
  class MustNotConstruct {
    constructor() {
      constructed = true;
    }
  }
  await assert.rejects(
    () => main({
      env: {
        ...validEnvironment,
        ICONNECT_PRODUCTION_READ_ONLY_VERIFY: undefined,
      },
      Client: MustNotConstruct,
    }),
    /Refusing production verification/,
  );
  assert.equal(constructed, false);
});

test('production verification rejects a wrong Supabase API or database target', () => {
  assert.throws(
    () => assertProductionVerificationOptIn({
      ...validEnvironment,
      DEST_SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
    }),
    /DEST_SUPABASE_URL must be exactly/,
  );
  for (const DEST_SUPABASE_URL of [
    `https://user:password@${PROJECT}.supabase.co`,
    `https://${PROJECT}.supabase.co?unsafe=true`,
    `https://${PROJECT}.supabase.co#unsafe`,
  ]) {
    assert.throws(
      () => assertProductionVerificationOptIn({ ...validEnvironment, DEST_SUPABASE_URL }),
      /DEST_SUPABASE_URL must be exactly/,
    );
  }
  assert.throws(
    () => assertProductionVerificationOptIn({
      ...validEnvironment,
      DEST_DATABASE_URL: 'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:secret@pooler.example.test/postgres',
    }),
    /DEST_DATABASE_URL must identify/,
  );
  for (const DEST_DATABASE_URL of [
    `postgresql://postgres.${PROJECT}:secret@attacker.example.test:5432/postgres`,
    `postgresql://postgres.${PROJECT}:secret@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`,
    `http://postgres.${PROJECT}:secret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${PROJECT}:secret@aws-1-eu-central-1.pooler.supabase.com:5432/other`,
    `postgresql://postgres.${PROJECT}:secret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=disable`,
  ]) {
    assert.throws(
      () => assertProductionVerificationOptIn({ ...validEnvironment, DEST_DATABASE_URL }),
      /DEST_DATABASE_URL must identify/,
    );
  }
});

test('production PostgreSQL connections require certificate validation', () => {
  assert.deepEqual(productionPgClientOptions(validEnvironment.DEST_DATABASE_URL), {
    connectionString: validEnvironment.DEST_DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  });
});

test('production verification requires an explicit tenant UUID', () => {
  assert.throws(
    () => assertProductionVerificationOptIn({
      ...validEnvironment,
      ICONNECT_PRODUCTION_VERIFY_TENANT_ID: '',
    }),
    /explicit tenant UUID/,
  );
  assert.equal(
    assertProductionVerificationOptIn(validEnvironment).tenantId,
    validEnvironment.ICONNECT_PRODUCTION_VERIFY_TENANT_ID,
  );
});

test('audited query adapter allows reads and transaction controls but blocks writes', async () => {
  const executed = [];
  const audit = [];
  const query = createAuditedReadOnlyQuery({
    async query(text, values) {
      executed.push({ text, values });
      return { rows: [] };
    },
  }, audit);

  await query('BEGIN READ ONLY', [], 'transaction:begin-read-only');
  await query(
    'SELECT id FROM tenant WHERE id = $1',
    [validEnvironment.ICONNECT_PRODUCTION_VERIFY_TENANT_ID],
    'test:tenant-read',
  );
  await query('ROLLBACK', [], 'transaction:rollback');
  await assert.rejects(
    () => query('UPDATE tenant SET name = $1', ['unsafe'], 'test:tenant-read'),
    /blocked non-read-only SQL/,
  );
  await assert.rejects(
    () => query('SELECT do_write() INTO changed_rows', [], 'test:tenant-read'),
    /blocked non-read-only SQL/,
  );
  await assert.rejects(
    () => query('SELECT id FROM tenant WHERE id = $1; SELECT set_config($2, $3, false)', [], 'test:tenant-read'),
    /blocked non-read-only SQL/,
  );
  await assert.rejects(
    () => query('SELECT id FROM tenant WHERE id = $1', [], 'unreviewed-operation'),
    /blocked non-read-only SQL/,
  );
  assert.equal(executed.length, 3);
  assert.deepEqual(audit.map((entry) => entry.operation), ['BEGIN', 'SELECT', 'ROLLBACK']);
});

test('every production verification statement uses a reviewed read-only operation', async () => {
  const routedRecordId = 'b55f24d4-81eb-4ae6-b16e-87f74b71d63d';
  let clientOptions;
  class FakeClient {
    constructor(options) {
      clientOptions = options;
    }
    async connect() {}
    async end() {}
    async query(text) {
      const sql = String(text).replace(/\s+/g, ' ');
      if (/current_setting\('transaction_read_only'\)/.test(sql)) {
        return { rows: [{ transaction_read_only: 'on' }] };
      }
      if (sql.includes('FROM public.tenant')) return { rows: [{ id: validEnvironment.ICONNECT_PRODUCTION_VERIFY_TENANT_ID }] };
      if (sql.includes('FROM pg_proc')) {
        return {
          rows: [
            'custom_object_record_relationship_list',
            'custom_object_record_relationship_projection',
          ].map((proname) => ({
            proname,
            prosecdef: true,
            proconfig: ['search_path=public'],
            anon_execute: false,
            authenticated_execute: false,
            service_execute: true,
          })),
        };
      }
      if (sql.includes('WITH candidates AS')) {
        return {
          rows: [{
            tenant_id: validEnvironment.ICONNECT_PRODUCTION_VERIFY_TENANT_ID,
            relationship_id: '6c82d3a4-1a24-4b0c-a6d5-afd64c3ad6fc',
            routed_side: 'source',
            routed_object_id: '73c25efd-1573-41c1-a1d8-3ef9aeb994be',
            endpoint_object_id: '2de1f85f-9ae2-4699-b08a-71aa496385c5',
            endpoint_display_key: 'name',
            routed_record_id: routedRecordId,
            endpoint_record_id: '9dccba35-1f19-4e12-9783-e86d79ac7ba7',
          }],
        };
      }
      if (sql.includes('custom_object_record_relationship_projection')) {
        return {
          rows: [{
            list_field_id: 'relationship:6c82d3a4-1a24-4b0c-a6d5-afd64c3ad6fc:source',
            routed_record_id: routedRecordId,
            opposite_record_id: '9dccba35-1f19-4e12-9783-e86d79ac7ba7',
            total_count: '1',
          }],
        };
      }
      if (sql.includes('custom_object_record_relationship_list')) {
        if (sql.includes('$5, 5')) return { rows: [{ record_id: null, total_count: '1' }] };
        return { rows: [{ record_id: routedRecordId, total_count: '1' }] };
      }
      return { rows: [] };
    }
  }

  const originalLog = console.log;
  console.log = () => {};
  try {
    await main({ env: validEnvironment, Client: FakeClient });
  } finally {
    console.log = originalLog;
  }
  assert.equal(clientOptions.ssl.rejectUnauthorized, true);
});