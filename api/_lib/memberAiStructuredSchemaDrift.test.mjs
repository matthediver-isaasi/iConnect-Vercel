// Task #2423: Schema drift guard for the member AI structured Q&A catalog.
//
// STRUCTURED_ENTITIES (api/_lib/memberAiStructured.js) is a hand-maintained
// whitelist of tables/columns the AI assistant may query. If a migration
// renames or drops one of those columns, the assistant silently degrades to
// "I can't answer that" with no signal to anyone. This suite introspects the
// real destination database and asserts every whitelisted table and column
// still exists, so drift is caught at validation time.
//
// Unlike the other api/_lib tests this one needs a database connection. It
// uses the pooler URL (DEST_DATABASE_URL — IPv4-reachable from the Replit
// workspace) or DATABASE_URL as a fallback for environments with IPv6
// outbound. When no credentials are available, or the database host is
// unreachable from the running environment, the suite SKIPS with an explicit
// warning rather than passing silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STRUCTURED_ENTITIES } from './memberAiStructured.js';

// ---------------------------------------------------------------------------
// Executor-selected columns.
//
// The executors in memberAiStructured.js select more columns than the
// catalog's nativeFields/dateFields (visibility columns, scoping columns,
// join keys). Keep this map in sync with the .select(...) strings there —
// the "every catalog table is declared here" test below forces an update
// when a new entity is added to the catalog.
// ---------------------------------------------------------------------------

const EXECUTOR_SELECTED_COLUMNS = {
  member: ['id', 'tenant_id', 'job_title', 'tags', 'show_in_directory', 'login_enabled', 'email'],
  organization: ['id', 'tenant_id', 'name', 'address', 'tags'],
  event: [
    'id',
    'tenant_id',
    'title',
    'status',
    'event_state',
    'member_group_id',
    'group_event_public',
    'event_type',
    'location',
    'start_date',
    'end_date',
  ],
  complex_event: [
    'id',
    'tenant_id',
    'title',
    'status',
    'event_state',
    'member_group_id',
    'group_event_public',
    'event_type',
    'location',
    'start_date',
    'end_date',
  ],
  resource: [
    'id',
    'tenant_id',
    'title',
    'status',
    'member_group_id',
    'allowed_role_ids',
    'resource_type',
    'subcategories',
    'tags',
    'release_date',
  ],
  booking: ['tenant_id', 'event_id', 'status'],
  complex_event_booking: ['tenant_id', 'event_id', 'status'],
};

// Support tables the structured path reads outside the entity catalog.
const SUPPORT_TABLE_COLUMNS = {
  preference_field: [
    'id',
    'tenant_id',
    'label',
    'entity_scope',
    'field_type',
    'options',
    'is_active',
    'directory_visibility',
    'show_in_directory_card',
    'show_in_member_directory',
  ],
  member_preference_value: ['member_id', 'field_id', 'value'],
  organization_preference_value: ['organization_id', 'field_id', 'value'],
  dynamic_directory: ['id', 'tenant_id', 'entity_type', 'filter_field_id', 'filter_value', 'is_active'],
  system_settings: ['tenant_id', 'setting_key', 'setting_value'],
};

// Catalog fields that are NOT real columns on the entity's own table: the
// booking executors derive event_title/event_start_date by joining visible
// events in JS. Each derived field maps to the real (table, column) it
// resolves from, which is asserted instead.
const DERIVED_FIELDS = {
  booking: {
    event_title: { table: 'event', column: 'title' },
    event_start_date: { table: 'event', column: 'start_date' },
  },
  complex_event_booking: {
    event_title: { table: 'complex_event', column: 'title' },
    event_start_date: { table: 'complex_event', column: 'start_date' },
  },
};

// ---------------------------------------------------------------------------
// Schema introspection helper: table -> Set(column names) from the live DB.
// ---------------------------------------------------------------------------

export async function fetchPublicTableColumns(connectionString, tables) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  });
  await client.connect();
  try {
    const res = await client.query(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public' and table_name = any($1)`,
      [tables]
    );
    const byTable = new Map();
    for (const row of res.rows) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name).add(row.column_name);
    }
    return byTable;
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Connect once (top-level await; node --test supports it). Decide whether to
// run or skip the whole suite.
// ---------------------------------------------------------------------------

const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

function isUnreachableError(err) {
  if (!err) return false;
  if (UNREACHABLE_CODES.has(err.code)) return true;
  if (/timeout/i.test(err.message || '')) return true;
  // pg AggregateError wraps per-address connection errors
  if (Array.isArray(err.errors)) return err.errors.some(isUnreachableError);
  return false;
}

const ALL_TABLES = [
  ...new Set([
    ...Object.values(STRUCTURED_ENTITIES).map((e) => e.table),
    ...Object.values(DERIVED_FIELDS).flatMap((m) =>
      Object.values(m).map((d) => d.table)
    ),
    ...Object.keys(SUPPORT_TABLE_COLUMNS),
  ]),
];

const connectionString =
  process.env.DEST_DATABASE_URL || process.env.DATABASE_URL || null;

let columnsByTable = null;
let skipReason = null;

if (!connectionString) {
  skipReason =
    'SKIPPED (no false pass): DEST_DATABASE_URL / DATABASE_URL not set — schema drift NOT verified in this environment.';
} else {
  try {
    columnsByTable = await fetchPublicTableColumns(connectionString, ALL_TABLES);
  } catch (err) {
    if (isUnreachableError(err)) {
      skipReason = `SKIPPED (no false pass): database unreachable from this environment (${err.code || err.message}) — schema drift NOT verified.`;
    } else {
      throw err; // real query/auth failure: fail loudly, never skip
    }
  }
}

if (skipReason) {
  console.warn(`\n[memberAiStructuredSchemaDrift] ${skipReason}\n`);
}

const skip = skipReason || false;

function tableColumns(table) {
  return columnsByTable.get(table) || new Set();
}

function assertColumn(table, column, context) {
  assert.ok(
    tableColumns(table).has(column),
    `${context}: column "${column}" is missing from table "${table}" — the AI structured catalog (api/_lib/memberAiStructured.js) or EXECUTOR_SELECTED_COLUMNS in this test references a column that no longer exists. Rename/remove it in the catalog or restore the column.`
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('schema drift: every catalog table exists in the database', { skip }, () => {
  for (const [entity, entry] of Object.entries(STRUCTURED_ENTITIES)) {
    assert.ok(
      columnsByTable.has(entry.table) && tableColumns(entry.table).size > 0,
      `entity "${entity}": table "${entry.table}" not found in the public schema`
    );
  }
  for (const table of Object.keys(SUPPORT_TABLE_COLUMNS)) {
    assert.ok(
      columnsByTable.has(table) && tableColumns(table).size > 0,
      `support table "${table}" not found in the public schema`
    );
  }
});

test('schema drift: catalog nativeFields and dateFields are real columns', { skip }, () => {
  for (const [entity, entry] of Object.entries(STRUCTURED_ENTITIES)) {
    const derived = DERIVED_FIELDS[entity] || {};
    const fields = [
      ...Object.keys(entry.nativeFields || {}),
      ...Object.keys(entry.dateFields || {}),
    ];
    for (const field of fields) {
      if (derived[field]) {
        const d = derived[field];
        assertColumn(d.table, d.column, `entity "${entity}" derived field "${field}"`);
      } else {
        assertColumn(entry.table, field, `entity "${entity}" field "${field}"`);
      }
    }
  }
});

test('schema drift: executor-selected columns are real columns', { skip }, () => {
  for (const [entity, columns] of Object.entries(EXECUTOR_SELECTED_COLUMNS)) {
    const entry = STRUCTURED_ENTITIES[entity];
    assert.ok(entry, `EXECUTOR_SELECTED_COLUMNS lists unknown entity "${entity}"`);
    for (const column of columns) {
      assertColumn(entry.table, column, `entity "${entity}" executor select`);
    }
  }
  for (const [table, columns] of Object.entries(SUPPORT_TABLE_COLUMNS)) {
    for (const column of columns) {
      assertColumn(table, column, `support table "${table}"`);
    }
  }
});

test('schema drift: every catalog entity declares its executor columns', { skip }, () => {
  for (const entity of Object.keys(STRUCTURED_ENTITIES)) {
    assert.ok(
      EXECUTOR_SELECTED_COLUMNS[entity],
      `entity "${entity}" is in STRUCTURED_ENTITIES but has no EXECUTOR_SELECTED_COLUMNS entry in memberAiStructuredSchemaDrift.test.mjs — add the columns its executor selects so drift stays covered.`
    );
  }
});
