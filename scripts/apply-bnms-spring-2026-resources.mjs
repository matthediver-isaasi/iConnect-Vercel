/**
 * Approved BNMS Spring Meeting 2026 reconciliation.
 *
 * --dry-run performs a complete pinned read and prints the current plan.
 * --apply refreshes the same plan, takes an atomic SQL transaction, checks the
 * complete before-state under a table lock, verifies in-transaction, commits,
 * runs the same path again for zero-write replay, and records durable audits.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { projectPublicResourceAccess } from '../api/_lib/publicResourceProjection.js';
import { isChunkVisibleToMember } from '../api/_lib/memberContentVisibility.js';
import {
  buildReport,
  checksum,
  DESTINATION_PROJECT,
  DESTINATION_URL,
  DOWNLOAD_RESOURCE_TYPE,
  HEADERS,
  INPUT,
  readAll,
  readWorkbook,
  RESOURCE_COLUMNS,
  SOURCE_CHECKSUM,
  SOURCE_ROWS,
  TENANT_ID,
} from './bnms-spring-2026-resources-proposal.mjs';
import {
  destinationConfig,
  durableFile,
  syncDirectory,
  writeComplete,
} from './bnms-youtube-categorisation-io.mjs';

const CATEGORY_COLUMNS = Object.freeze([
  'id',
  'name',
  'description',
  'subcategories',
  'display_order',
  'is_active',
  'applies_to_content_types',
  'tenant_id',
  'excluded_role_ids',
  'subcategory_excluded_role_ids',
]);

const UPDATE_FIELDS = Object.freeze([
  'title',
  'description',
  'release_date',
  'subcategories',
  'is_public',
  'resource_type',
]);

export const CA_CHECKSUM = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';

function normalizedSnapshot(snapshot) {
  const normalizeDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  };
  return {
    tenant: snapshot.tenant,
    categories: [...snapshot.categories]
      .map((category) => ({ ...category }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    resources: [...snapshot.resources]
      .map((resource) => ({
        ...resource,
        release_date: normalizeDate(resource.release_date),
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
}

export function assertSnapshot(actual, expected, message = 'Destination drift') {
  assert.deepEqual(normalizedSnapshot(actual), normalizedSnapshot(expected), message);
}

export function resourceId(row, sourceChecksum = SOURCE_CHECKSUM) {
  const hash = createHash('sha1')
    .update(Buffer.from(TENANT_ID.replaceAll('-', ''), 'hex'))
    .update(`spring-meeting-2026:${sourceChecksum}:${row}`)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resourceRecord(row, sourceChecksum) {
  const record = {
    ...Object.fromEntries(RESOURCE_COLUMNS.map((column) => [column, null])),
    is_sample: false,
    ...row.proposed,
    id: resourceId(row.row, sourceChecksum),
  };
  assert.deepEqual(
    Object.keys(record).sort(),
    [...RESOURCE_COLUMNS].sort(),
    'Resource schema changed',
  );
  assert.equal(record.id, resourceId(row.row, sourceChecksum));
  assert.equal(record.tenant_id, TENANT_ID);
  assert.equal(record.resource_type, DOWNLOAD_RESOURCE_TYPE);
  assert.equal(record.status, 'active');
  assert.equal(record.is_public, false);
  assert.deepEqual(record.tags, []);
  assert.deepEqual(record.allowed_role_ids, []);
  assert.deepEqual(record.linked_events, []);
  assert.equal(record.member_group_id, null);
  return record;
}

export function planApproved({ report, before, sourceChecksum = SOURCE_CHECKSUM }) {
  assert.equal(report.tenantId, TENANT_ID);
  assert.deepEqual(before.tenant, { id: TENANT_ID, name: 'BNMS' });
  assert(before.resources.every((resource) => resource.tenant_id === TENANT_ID), 'Foreign resource');
  assert(before.categories.every((category) => category.tenant_id === TENANT_ID), 'Foreign taxonomy');
  const inserts = [];
  const updates = [];
  const skipped = [];

  for (const row of report.rows) {
    if (row.status === 'blocked' || row.status === 'unchanged') {
      skipped.push({ row: row.row, status: row.status, issues: row.issues });
      continue;
    }
    assert(['insert', 'update'].includes(row.status), `Unapproved action at row ${row.row}`);
    assert.equal(row.issues.length, 0, `Blocked row ${row.row} entered the plan`);
    assert.equal(row.proposed.tenant_id, TENANT_ID);
    assert.equal(row.proposed.is_public, false, 'Member Only Yes must remain restricted');
    assert.equal(row.source['Member Only'], 'Yes');
    assert.equal(row.proposed.resource_type, DOWNLOAD_RESOURCE_TYPE);
    if (row.status === 'insert') {
      assert.equal(row.before, null);
      assert.equal(row.candidateIds.length, 0);
      const record = resourceRecord(row, sourceChecksum);
      assert(!before.resources.some((resource) => resource.id === record.id), 'Insert ID collides');
      inserts.push({ row: row.row, record });
      continue;
    }
    assert(row.before && row.before.tenant_id === TENANT_ID);
    assert(
      Object.keys(row.patch).every((field) => UPDATE_FIELDS.includes(field)),
      `Unapproved update field at row ${row.row}`,
    );
    assert.deepEqual(row.proposed, { ...row.before, ...row.patch });
    for (const tag of row.before.tags ?? []) {
      assert(row.proposed.tags.includes(tag), 'Tag removed');
    }
    for (const subcategory of row.before.subcategories ?? []) {
      assert(row.proposed.subcategories.includes(subcategory), 'Classification removed');
    }
    assert.deepEqual(row.proposed.allowed_role_ids, row.before.allowed_role_ids);
    updates.push({ row: row.row, before: row.before, record: row.proposed });
  }

  const ids = [...inserts.map((item) => item.record.id), ...updates.map((item) => item.record.id)];
  assert.equal(new Set(ids).size, ids.length, 'Several approved writes target one resource ID');
  const expected = structuredClone(before);
  for (const item of updates) {
    const index = expected.resources.findIndex((resource) => resource.id === item.record.id);
    assert(index >= 0, `Update resource ${item.record.id} disappeared`);
    expected.resources[index] = item.record;
  }
  expected.resources.push(...inserts.map((item) => item.record));
  expected.resources.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    inserts,
    updates,
    skipped,
    expected,
    summary: {
      inserts: inserts.length,
      updates: updates.length,
      unchanged: report.rows.filter((row) => row.status === 'unchanged').length,
      blocked: report.rows.filter((row) => row.status === 'blocked').length,
    },
  };
}

export function verifyAuthorization(after, plan, report) {
  const applied = report.rows.filter((row) => ['insert', 'update', 'unchanged'].includes(row.status));
  const records = new Map(after.resources.map((resource) => [resource.id, resource]));
  let locked = 0;
  let targetSuppressed = 0;
  let memberVisible = 0;
  let inactive = 0;

  for (const row of applied) {
    const id = row.status === 'insert'
      ? resourceId(row.row, report.inputChecksum)
      : row.before?.id;
    const record = records.get(id);
    assert(record, `Missing affected resource for source row ${row.row}`);
    assert.equal(record.tenant_id, TENANT_ID);
    assert.equal(record.is_public, false, `Source row ${row.row} is not member-only`);
    const projection = projectPublicResourceAccess(record, 'bnms.example.test');
    assert.equal(projection.is_locked, true);
    assert.equal(projection.target_url, null);
    locked += 1;
    targetSuppressed += 1;
    const allowedRoleIds = Array.isArray(record.allowed_role_ids) ? record.allowed_role_ids : [];
    const context = {
      isAdmin: false,
      roleId: allowedRoleIds[0] ?? null,
      groupIds: record.member_group_id ? new Set([record.member_group_id]) : new Set(),
      canAccessFeature: () => true,
      tenantId: TENANT_ID,
    };
    const visible = isChunkVisibleToMember({
      ...record,
      content_type: 'resource',
    }, context);
    if (record.status === 'active') {
      assert.equal(visible, true, `Active member resource row ${row.row} is not visible to a permitted member`);
      memberVisible += 1;
    } else {
      assert.equal(visible, false, `Inactive resource row ${row.row} unexpectedly visible`);
      inactive += 1;
    }
  }
  return {
    checked: applied.length,
    locked,
    publicTargetSuppressed: targetSuppressed,
    activeMemberVisible: memberVisible,
    inactivePreserved: inactive,
  };
}

export async function sqlSnapshot(client) {
  const tenant = await client.query(
    'SELECT id, name FROM public.tenant WHERE id = $1',
    [TENANT_ID],
  );
  assert.deepEqual(tenant.rows, [{ id: TENANT_ID, name: 'BNMS' }], 'SQL tenant identity mismatch');
  const read = async (table) => (await client.query(
    `SELECT to_jsonb(r) AS record FROM public.${table} r WHERE tenant_id = $1 ORDER BY id`,
    [TENANT_ID],
  )).rows.map((row) => row.record);
  return {
    tenant: tenant.rows[0],
    resources: await read('resource'),
    categories: await read('resource_category'),
  };
}

async function schemaGuards(client) {
  const resourceSchema = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resource' ORDER BY ordinal_position",
  );
  assert.deepEqual(
    resourceSchema.rows.map((row) => row.column_name),
    RESOURCE_COLUMNS,
    'Resource schema changed',
  );
  const categorySchema = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resource_category' ORDER BY ordinal_position",
  );
  assert.deepEqual(
    categorySchema.rows.map((row) => row.column_name),
    CATEGORY_COLUMNS,
    'Resource category schema changed',
  );
  const resourceTypeSchema = await client.query(
    "SELECT data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resource' AND column_name='resource_type'",
  );
  assert.deepEqual(resourceTypeSchema.rows, [{ data_type: 'text', udt_name: 'text' }], 'Resource type schema changed');
  const downloadType = await client.query(
    'SELECT 1 FROM public.resource WHERE resource_type = $1 LIMIT 1',
    [DOWNLOAD_RESOURCE_TYPE],
  );
  assert.equal(downloadType.rowCount, 1, 'DEST does not contain the approved Download resource type');
  for (const table of ['resource', 'resource_category']) {
    const triggers = await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND NOT tgisinternal`,
    );
    assert.equal(triggers.rows.length, 0, `Unreviewed ${table} trigger`);
  }
  return {
    resourceTypeStorage: {
      dataType: resourceTypeSchema.rows[0].data_type,
      udtName: resourceTypeSchema.rows[0].udt_name,
      observedValue: DOWNLOAD_RESOURCE_TYPE,
    },
  };
}

export async function applyTransaction({ client, bundle, journal }) {
  const { plan, before, report } = bundle;
  let writes = 0;
  let commitStarted = false;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`bnms-spring-meeting-2026:${TENANT_ID}`],
    );
    await client.query('LOCK TABLE public.resource, public.resource_category IN SHARE ROW EXCLUSIVE MODE');
    await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR SHARE', [TENANT_ID]);
    const schema = await schemaGuards(client);
    const current = await sqlSnapshot(client);
    try {
      assertSnapshot(current, plan.expected);
      await client.query('ROLLBACK');
      journal({ status: 'already_applied', writes: 0 });
      return {
        status: 'already_applied',
        writes: 0,
        inserted: 0,
        updated: 0,
        after: current,
        ...schema,
      };
    } catch {
      // The exact approved before-state below is the only writable state.
    }
    assertSnapshot(current, before, 'SQL destination drift; no writes permitted');
    journal({
      status: 'transaction_intent',
      inserts: plan.inserts.map((item) => ({ row: item.row, id: item.record.id })),
      updates: plan.updates.map((item) => ({ row: item.row, id: item.record.id })),
      skipped: plan.skipped,
    });
    if (plan.inserts.length) {
      const result = await client.query(
        `INSERT INTO public.resource (${RESOURCE_COLUMNS.join(', ')})
         SELECT ${RESOURCE_COLUMNS.map((column) => `p.${column}`).join(', ')}
         FROM jsonb_populate_recordset(NULL::public.resource, $1::jsonb) p
         WHERE p.tenant_id = $2
         RETURNING id`,
        [JSON.stringify(plan.inserts.map((item) => item.record)), TENANT_ID],
      );
      assert.equal(result.rowCount, plan.inserts.length, 'Insert count mismatch');
      assert.deepEqual(
        result.rows.map((row) => row.id).sort(),
        plan.inserts.map((item) => item.record.id).sort(),
      );
      writes += result.rowCount;
    }
    if (plan.updates.length) {
      const result = await client.query(
        `UPDATE public.resource r
         SET title = p.title,
             description = p.description,
             release_date = p.release_date,
             subcategories = p.subcategories,
             is_public = p.is_public,
             resource_type = p.resource_type
         FROM jsonb_to_recordset($1::jsonb) AS p
           (id uuid, title text, description text, release_date timestamptz,
            subcategories text[], is_public boolean, resource_type text, before jsonb)
         WHERE r.id = p.id AND r.tenant_id = $2 AND to_jsonb(r) = p.before
         RETURNING r.id`,
        [JSON.stringify(plan.updates.map((item) => ({ ...item.record, before: item.before }))), TENANT_ID],
      );
      assert.equal(result.rowCount, plan.updates.length, 'Conditional update count mismatch');
      assert.deepEqual(
        result.rows.map((row) => row.id).sort(),
        plan.updates.map((item) => item.record.id).sort(),
      );
      writes += result.rowCount;
    }
    const after = await sqlSnapshot(client);
    assertSnapshot(after, plan.expected, 'Unexpected data inside transaction');
    journal({
      status: 'verified_in_transaction',
      writes,
      sourceRows: report.summary.sourceRows,
    });
    journal({ status: 'commit_intent', writes });
    commitStarted = true;
    await client.query('COMMIT');
    journal({
      status: 'committed',
      writes,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
    });
    return {
      status: 'applied',
      writes,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      after,
      ...schema,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    journal({
      status: commitStarted ? 'commit_outcome_requires_reconciliation' : 'rolled_back',
      attemptedWrites: writes,
      confirmedWrites: commitStarted ? null : 0,
      error: error.message,
    });
    throw error;
  }
}

export function verifyApplied({ workbook, report, before, plan }, after) {
  assertSnapshot(after, plan.expected, 'Unexpected data or taxonomy after commit');
  const replay = buildReport(workbook, after.resources, after.categories);
  for (const row of report.rows) {
    const result = replay.rows.find((candidate) => candidate.row === row.row);
    assert(result, `Missing replay row ${row.row}`);
    if (['insert', 'update', 'unchanged'].includes(row.status)) {
      assert.equal(result.status, 'unchanged', `Row ${row.row} is not replay-safe`);
    } else {
      assert.equal(result.status, 'blocked', `Blocked row ${row.row} unexpectedly resolved`);
    }
  }
  assert.equal(replay.summary.inserts, 0);
  assert.equal(replay.summary.updates, 0);
  const authorization = verifyAuthorization(after, plan, report);
  return { replay, authorization };
}

function readOnlyFetch(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  assert.equal(method, 'GET', `REST transport is read-only; refused ${method}`);
  return fetch(input, init);
}

function makeRestClient() {
  assert.equal(process.env.DEST_SUPABASE_URL, DESTINATION_URL, 'Unapproved REST destination');
  assert(process.env.DEST_SUPABASE_KEY, 'DEST read verification credentials required');
  return createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });
}

async function readStableRest(client) {
  const read = async () => {
    const tenantResult = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
    assert(!tenantResult.error
      && tenantResult.data?.id === TENANT_ID
      && tenantResult.data?.name === 'BNMS', 'REST tenant identity mismatch');
    const resources = await readAll(client, 'resource', '*');
    const categories = await readAll(client, 'resource_category', '*');
    return {
      snapshot: {
        tenant: tenantResult.data,
        resources: resources.rows,
        categories: categories.rows,
      },
      coverage: {
        resourceTotal: resources.total,
        resourcePages: resources.pages,
        categoryTotal: categories.total,
        categoryPages: categories.pages,
      },
    };
  };
  const first = await read();
  const second = await read();
  assert.equal(
    checksum(JSON.stringify(first.snapshot)),
    checksum(JSON.stringify(second.snapshot)),
    'Destination changed during paginated verification; stop',
  );
  return { ...first, secondReadIdentical: true };
}

export async function loadBundle() {
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.rows.length, SOURCE_ROWS, 'Source row count changed');
  assert.equal(workbook.checksum, SOURCE_CHECKSUM, 'Workbook differs from pinned source');
  assert.deepEqual(workbook.headers, HEADERS, 'Workbook headers differ from pinned mapping');
  const rest = makeRestClient();
  const initial = await readStableRest(rest);
  const report = buildReport(
    workbook,
    initial.snapshot.resources,
    initial.snapshot.categories,
  );
  const before = initial.snapshot;
  const plan = planApproved({
    report,
    before,
    sourceChecksum: workbook.checksum,
  });
  return { workbook, rest, initial, report, before, plan };
}

function summaryOutput(bundle) {
  return {
    mode: 'READ_ONLY',
    sourceRows: bundle.report.summary.sourceRows,
    inserts: bundle.plan.inserts.length,
    updates: bundle.plan.updates.length,
    unchanged: bundle.plan.summary.unchanged,
    blocked: bundle.plan.summary.blocked,
    accessChanges: bundle.report.summary.accessChangeRows,
    displayTypeChanges: bundle.report.summary.displayTypeChangeRows,
    databaseWrites: 0,
    destinationProject: DESTINATION_PROJECT,
    tenantId: TENANT_ID,
    coverage: bundle.initial.coverage,
    secondReadIdentical: bundle.initial.secondReadIdentical,
  };
}

function executionWorkbook(bundle, verification) {
  const book = XLSX.utils.book_new();
  const sheet = (name, rows) => XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.json_to_sheet(rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value !== null && typeof value === 'object' ? JSON.stringify(value) : value,
      ]),
    ))),
    name,
  );
  sheet('Verification', Object.entries(verification).map(([metric, value]) => ({ metric, value })));
  const rows = bundle.report.rows.map((row) => ({
    sourceRow: row.row,
    action: row.status === 'insert' ? 'inserted'
      : row.status === 'update' ? 'updated' : 'skipped',
    resourceId: bundle.plan.inserts.find((item) => item.row === row.row)?.record.id
      ?? row.before?.id
      ?? '',
    title: row.source.Title,
    resourceUrl: row.url,
    status: row.status,
    issues: row.issues,
    notes: row.notes,
    coreChanges: row.coreChanges,
    accessChange: row.accessChange,
    displayTypeChange: row.displayTypeChange,
    date: row.date,
  }));
  sheet('All source rows', rows);
  sheet('Skipped rows', rows.filter((row) => row.action === 'skipped'));
  sheet('Access changes', rows.filter((row) => row.accessChange));
  return book;
}

async function fetchTrustedCa() {
  const response = await fetch(
    'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt',
  );
  assert(response.ok, 'Could not load trusted Supabase CA');
  const ca = await response.text();
  assert.equal(checksum(ca), CA_CHECKSUM, 'Trusted Supabase CA checksum changed');
  return ca;
}

async function run() {
  const args = process.argv.slice(2);
  assert(args.length === 1 && ['--dry-run', '--apply'].includes(args[0]), 'Exactly --dry-run or --apply is required');
  const bundle = await loadBundle();
  if (args[0] === '--dry-run') {
    console.log(JSON.stringify(summaryOutput(bundle)));
    return;
  }

  const config = destinationConfig(process.env.DEST_SUPABASE_URL, process.env.DEST_DATABASE_URL);
  const ca = await fetchTrustedCa();
  const client = new pg.Client({ ...config, ssl: { rejectUnauthorized: true, ca } });
  const directory = `reports/bnms-spring-2026-resources/execution/${new Date().toISOString().replaceAll(':', '-')}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of [
    directory,
    `${directory}/..`,
    'reports/bnms-spring-2026-resources',
    'reports',
    '.',
  ]) syncDirectory(path);
  const save = (name, value) => durableFile(
    `${directory}/${name}.json`,
    JSON.stringify(value, null, 2),
  );
  save('plan', {
    source: INPUT,
    inputChecksum: bundle.workbook.checksum,
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenantId: TENANT_ID,
    resourceType: DOWNLOAD_RESOURCE_TYPE,
    memberOnlyOverride: true,
    sourceRows: bundle.report.summary.sourceRows,
    summary: bundle.plan.summary,
    reportSummary: bundle.report.summary,
    plan: bundle.plan,
  });
  save('before', bundle.before);
  const fd = openSync(`${directory}/journal.jsonl`, 'ax', 0o600);
  const journal = (entry) => writeComplete(
    fd,
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
  );
  try {
    await client.connect();
    const result = await applyTransaction({ client, bundle, journal });
    save('transaction-result', result);
    const replay = await applyTransaction({ client, bundle, journal });
    assert.equal(replay.writes, 0, 'Zero-write replay wrote records');
    save('replay-result', replay);
    const final = await readStableRest(bundle.rest);
    const verificationResult = verifyApplied(bundle, final.snapshot);
    const verification = {
      status: result.status,
      tenantId: TENANT_ID,
      destinationProject: DESTINATION_PROJECT,
      inputChecksum: bundle.workbook.checksum,
      sourceRows: bundle.report.summary.sourceRows,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: bundle.plan.summary.unchanged,
      blocked: bundle.plan.summary.blocked,
      skippedRows: bundle.plan.skipped.length,
      writes: result.writes,
      replayWrites: replay.writes,
      resourceType: DOWNLOAD_RESOURCE_TYPE,
      resourceTypeStorage: result.resourceTypeStorage,
      memberOnlyOverrideApplied: true,
      initialResourceCount: bundle.before.resources.length,
      finalResourceCount: final.snapshot.resources.length,
      initialCategoryCount: bundle.before.categories.length,
      finalCategoryCount: final.snapshot.categories.length,
      blankDatesPreserved: true,
      existingTagsAndClassificationsPreserved: true,
      existingRoleRestrictionsPreserved: true,
      taxonomyUnchanged: true,
      completePaginatedVerification: true,
      prewriteSecondReadIdentical: bundle.initial.secondReadIdentical,
      finalSecondReadIdentical: final.secondReadIdentical,
      replaySummary: verificationResult.replay.summary,
      authorization: verificationResult.authorization,
      finalCoverage: final.coverage,
    };
    save('after', final);
    save('verification', verification);
    XLSX.writeFile(
      executionWorkbook(bundle, verification),
      `${directory}/execution-report.xlsx`,
      { compression: true },
    );
    console.log(JSON.stringify({ auditDirectory: directory, ...verification }));
  } finally {
    closeSync(fd);
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}