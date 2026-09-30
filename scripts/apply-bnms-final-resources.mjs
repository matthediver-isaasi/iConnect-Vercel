/**
 * Approved BNMS final Resources import.
 *
 * --dry-run refreshes the complete pinned destination snapshot and prints the
 * approved plan without writes. --apply performs one atomic SQL transaction,
 * after the same refresh/drift checks, then performs a zero-DML replay and a
 * complete REST verification.
 *
 * The four approved Resource Type values are the only taxonomy mutations.
 * Existing access changes remain held, as do every other source blocker.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import {
  buildReport,
  checksum,
  DESTINATION_PROJECT,
  DESTINATION_URL,
  INPUT,
  readAll,
  readWorkbook,
  TENANT_ID,
} from './bnms-final-resources-proposal.mjs';
import {
  destinationConfig,
  durableFile,
  syncDirectory,
  writeComplete,
} from './bnms-youtube-categorisation-io.mjs';

export const SOURCE_CHECKSUM = '0c408805b7dabb1ae84fb152de29043de8d3ebb045626f74fffb32d3b95e838e';
export const APPROVED_RESOURCE_TYPES = Object.freeze([
  'NM Images',
  'Patient Information leaflet',
  'Educational Resources',
  'Historical Resources',
]);
export const RESOURCE_COLUMNS = Object.freeze([
  'id',
  'title',
  'description',
  'subcategories',
  'resource_type',
  'target_url',
  'open_in_new_tab',
  'image_url',
  'release_date',
  'is_public',
  'allowed_role_ids',
  'tags',
  'author_id',
  'author_name',
  'folder_id',
  'status',
  'tenant_id',
  'search_text',
  'linked_events',
  'seo_title',
  'seo_description',
  'og_image_url',
  'is_sample',
  'member_group_id',
]);
export const CATEGORY_COLUMNS = Object.freeze([
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
export const APPROVAL_TEXT = 'Explicit user approval: add the four missing Resource Type subcategories and import all otherwise valid rows; hold all other blockers including access changes.';

const ACCESS_HOLD_ISSUE = 'approved_access_change_held';
const ADDITIONAL_CATEGORY_ISSUES = APPROVED_RESOURCE_TYPES.map(
  (value) => `missing_taxonomy:Resource Type:${value}`,
);

const normalizeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};

function normalizedSnapshot(snapshot) {
  return {
    tenant: snapshot.tenant,
    categories: [...snapshot.categories]
      .map((category) => ({
        ...category,
      }))
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
  // UUIDv5-shaped deterministic ID: fixed tenant namespace, source checksum
  // and workbook row. Re-running the approved plan cannot create duplicates.
  const hash = createHash('sha1')
    .update(Buffer.from(TENANT_ID.replaceAll('-', ''), 'hex'))
    .update(`final-resources:${sourceChecksum}:${row}`)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recount(report) {
  const rows = report.rows;
  const count = (predicate) => rows.filter(predicate).length;
  report.summary = {
    ...report.summary,
    inserts: count((row) => row.status === 'insert'),
    updates: count((row) => row.status === 'update'),
    unchanged: count((row) => row.status === 'unchanged'),
    blocked: count((row) => row.status === 'blocked'),
    coreChangeRows: count((row) => row.coreChanges.length > 0),
    nonBlockedCoreChangeRows: count((row) => row.status !== 'blocked' && row.coreChanges.length > 0),
    accessChangeRows: count((row) => row.accessChange),
    accessChanges: count((row) => row.accessChange),
    nonBlockedAccessChangeRows: count((row) => row.status !== 'blocked' && row.accessChange),
    classificationChangeRows: count((row) => row.classificationChange),
    databaseWrites: 0,
  };
  return report;
}

export function approvedCategories(categories) {
  const resourceTypeCategories = categories.filter((category) => category.name === 'Resource Type');
  assert.equal(resourceTypeCategories.length, 1, 'Resource Type taxonomy is missing or ambiguous');
  const current = resourceTypeCategories[0];
  assert(Array.isArray(current.subcategories), 'Resource Type subcategories are invalid');
  const existing = new Set(current.subcategories);
  const present = APPROVED_RESOURCE_TYPES.filter((value) => existing.has(value));
  assert(
    present.length === 0 || present.length === APPROVED_RESOURCE_TYPES.length,
    'Some, but not all, approved Resource Type values already exist; stop for drift review',
  );
  if (present.length === APPROVED_RESOURCE_TYPES.length) return categories.map((category) => ({ ...category }));
  return categories.map((category) => category.name === 'Resource Type'
    ? {
      ...category,
      subcategories: [...category.subcategories, ...APPROVED_RESOURCE_TYPES],
    }
    : { ...category });
}

export function prepareApprovedReport(workbook, resources, categories) {
  const initial = buildReport(workbook, resources, categories);
  assert(
    initial.missingTaxonomy.every((issue) => ADDITIONAL_CATEGORY_ISSUES.includes(issue)),
    'Source has an unapproved missing taxonomy value',
  );
  const afterCategories = approvedCategories(categories);
  const report = buildReport(workbook, resources, afterCategories);
  assert.equal(report.missingTaxonomy.length, 0, 'Approved taxonomy additions did not resolve all missing values');
  // Access changes were not included in the approval. Keep them blocked even
  // when adding the four Resource Type values would otherwise make them valid.
  for (const row of report.rows) {
    if (!row.accessChange) continue;
    row.issues.push(ACCESS_HOLD_ISSUE);
    row.status = 'blocked';
  }
  recount(report);
  return { initial, report, afterCategories };
}

function resourceRecord(row, sourceChecksum) {
  const record = {
    ...Object.fromEntries(RESOURCE_COLUMNS.map((column) => [column, null])),
    is_sample: false,
    ...row.proposed,
    id: resourceId(row.row, sourceChecksum),
  };
  assert.deepEqual(Object.keys(record).sort(), [...RESOURCE_COLUMNS].sort(), 'Resource schema changed');
  assert.equal(record.tenant_id, TENANT_ID);
  assert.equal(record.resource_type, 'external_link');
  assert.equal(record.status, 'active');
  assert.deepEqual(record.tags, []);
  assert.deepEqual(record.allowed_role_ids, []);
  assert.equal(record.member_group_id, null);
  return record;
}

export function planApproved({ report, before, afterCategories, sourceChecksum = SOURCE_CHECKSUM }) {
  assert.equal(report.tenantId, TENANT_ID);
  assert.deepEqual(before.tenant, { id: TENANT_ID, name: 'BNMS' });
  assert(before.resources.every((resource) => resource.tenant_id === TENANT_ID), 'Foreign resource');
  assert(before.categories.every((category) => category.tenant_id === TENANT_ID), 'Foreign taxonomy');
  const beforeType = before.categories.find((category) => category.name === 'Resource Type');
  const afterType = afterCategories.find((category) => category.name === 'Resource Type');
  assert(beforeType && afterType, 'Resource Type category missing');
  const taxonomyAlreadyApplied = afterType.subcategories.length === beforeType.subcategories.length;
  assert.deepEqual(
    afterType.subcategories,
    taxonomyAlreadyApplied
      ? beforeType.subcategories
      : [...beforeType.subcategories, ...APPROVED_RESOURCE_TYPES],
    'Unapproved Resource Type taxonomy change',
  );
  const categoryUpdates = beforeType.subcategories.length === afterType.subcategories.length
    ? []
    : [{
      id: beforeType.id,
      subcategories: afterType.subcategories,
      before: beforeType,
    }];
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
    assert.equal(row.accessChange, false, `Access change escaped hold at row ${row.row}`);
    if (row.status === 'insert') {
      assert.equal(row.before, null);
      assert.equal(row.candidateIds.length, 0);
      const record = resourceRecord(row, sourceChecksum);
      assert(!before.resources.some((resource) => resource.id === record.id), 'Insert ID collides with before snapshot');
      inserts.push({ row: row.row, record });
    } else {
      assert(row.before && row.before.tenant_id === TENANT_ID);
      assert(
        Object.keys(row.patch).every((field) => ['title', 'description', 'release_date', 'subcategories'].includes(field)),
        `Unapproved update field at row ${row.row}`,
      );
      assert.deepEqual(row.proposed, { ...row.before, ...row.patch }, `Patch mismatch at row ${row.row}`);
      for (const tag of row.before.tags ?? []) assert(row.proposed.tags.includes(tag), 'Tag removed');
      for (const subcategory of row.before.subcategories ?? []) {
        assert(row.proposed.subcategories.includes(subcategory), 'Classification removed');
      }
      assert.deepEqual(row.proposed.allowed_role_ids, row.before.allowed_role_ids);
      updates.push({ row: row.row, before: row.before, record: row.proposed });
    }
  }
  const ids = [...inserts.map((item) => item.record.id), ...updates.map((item) => item.record.id)];
  assert.equal(new Set(ids).size, ids.length, 'Several approved writes target one resource ID');
  const expected = structuredClone(before);
  expected.categories = afterCategories;
  for (const item of updates) {
    const index = expected.resources.findIndex((resource) => resource.id === item.record.id);
    assert(index >= 0, `Update resource ${item.record.id} disappeared`);
    expected.resources[index] = item.record;
  }
  expected.resources.push(...inserts.map((item) => item.record));
  expected.resources.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    categoryUpdates,
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

function holdAccessChanges(report) {
  for (const row of report.rows) {
    if (!row.accessChange || row.issues.includes(ACCESS_HOLD_ISSUE)) continue;
    row.issues.push(ACCESS_HOLD_ISSUE);
    row.status = 'blocked';
  }
  return recount(report);
}

export function verifyApplied({ workbook, report, before, plan, afterCategories }, after) {
  assertSnapshot(after, plan.expected, 'Unexpected data or taxonomy after commit');
  const replayBuild = buildReport(workbook, after.resources, after.categories);
  const replay = holdAccessChanges(replayBuild);
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
  assert.deepEqual(
    after.categories.find((category) => category.name === 'Resource Type'),
    afterCategories.find((category) => category.name === 'Resource Type'),
  );
  return replay;
}

async function readRest(client) {
  const tenantResult = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
  assert(!tenantResult.error && tenantResult.data?.id === TENANT_ID && tenantResult.data.name === 'BNMS', 'REST tenant identity mismatch');
  const resources = await readAll(client, 'resource', '*');
  const categories = await readAll(client, 'resource_category', '*');
  return {
    snapshot: {
      tenant: tenantResult.data,
      resources: resources.rows,
      categories: categories.rows,
    },
    coverage: {
      resources: resources.pages,
      categories: categories.pages,
      resourceTotal: resources.total,
      categoryTotal: categories.total,
    },
  };
}

async function readStableRest(client) {
  const first = await readRest(client);
  const second = await readRest(client);
  assert.equal(
    checksum(JSON.stringify(first.snapshot)),
    checksum(JSON.stringify(second.snapshot)),
    'Destination changed during paginated verification; stop',
  );
  return { ...first, secondReadIdentical: true };
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

export async function sqlSnapshot(client) {
  const tenant = await client.query('SELECT id, name FROM public.tenant WHERE id = $1', [TENANT_ID]);
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
  assert.deepEqual(resourceSchema.rows.map((row) => row.column_name), RESOURCE_COLUMNS, 'Resource schema changed');
  const categorySchema = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='resource_category' ORDER BY ordinal_position",
  );
  assert.deepEqual(categorySchema.rows.map((row) => row.column_name), CATEGORY_COLUMNS, 'Resource category schema changed');
  for (const table of ['resource', 'resource_category']) {
    const triggers = await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid='public.${table}'::regclass AND NOT tgisinternal`,
    );
    assert.equal(triggers.rows.length, 0, `Unreviewed ${table} trigger`);
  }
}

export async function applyTransaction({ client, bundle, journal }) {
  const { plan, before } = bundle;
  let writes = 0;
  let commitStarted = false;
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`bnms-final-resources:${TENANT_ID}`],
    );
    await client.query('LOCK TABLE public.resource, public.resource_category IN SHARE ROW EXCLUSIVE MODE');
    await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR SHARE', [TENANT_ID]);
    await schemaGuards(client);
    const current = await sqlSnapshot(client);
    try {
      assertSnapshot(current, plan.expected);
      await client.query('ROLLBACK');
      journal({ status: 'already_applied', writes: 0 });
      return { status: 'already_applied', writes: 0, inserted: 0, updated: 0, taxonomyAdded: 0, after: current };
    } catch {
      // The exact before-state below is the only writable state.
    }
    assertSnapshot(current, before, 'SQL destination drift; no writes permitted');
    journal({
      status: 'transaction_intent',
      taxonomyAdds: APPROVED_RESOURCE_TYPES,
      inserts: plan.inserts.map((item) => ({ row: item.row, id: item.record.id })),
      updates: plan.updates.map((item) => ({ row: item.row, id: item.record.id })),
      skipped: plan.skipped,
    });
    const categoryResult = await client.query(
      `UPDATE public.resource_category c
       SET subcategories = p.subcategories
       FROM jsonb_to_recordset($1::jsonb) AS p
         (id uuid, subcategories text[], before jsonb)
       WHERE c.id = p.id AND c.tenant_id = $2 AND to_jsonb(c) = p.before
       RETURNING c.id`,
      [JSON.stringify(plan.categoryUpdates), TENANT_ID],
    );
    assert.equal(categoryResult.rowCount, plan.categoryUpdates.length, 'Taxonomy update count mismatch');
    writes += categoryResult.rowCount;
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
         SET title = p.title, description = p.description,
             release_date = p.release_date, subcategories = p.subcategories
         FROM jsonb_to_recordset($1::jsonb) AS p
           (id uuid, title text, description text, release_date timestamptz,
            subcategories text[], before jsonb)
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
    journal({ status: 'verified_in_transaction', writes });
    journal({ status: 'commit_intent', writes });
    commitStarted = true;
    await client.query('COMMIT');
    journal({
      status: 'committed',
      writes,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      taxonomyAdded: APPROVED_RESOURCE_TYPES.length,
    });
    return {
      status: 'applied',
      writes,
      inserted: plan.inserts.length,
      updated: plan.updates.length,
      taxonomyAdded: APPROVED_RESOURCE_TYPES.length,
      after,
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

function executionWorkbook(report, verification, plan) {
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
  const rows = report.rows.map((row) => ({
    sourceRow: row.row,
    action: row.status === 'insert' ? 'inserted'
      : row.status === 'update' ? 'updated'
        : 'skipped',
    resourceId: plan.inserts.find((item) => item.row === row.row)?.record.id ?? row.before?.id ?? '',
    title: row.source.Title,
    resourceUrl: row.url,
    status: row.status,
    issues: row.issues,
    notes: row.notes,
    coreChanges: row.coreChanges,
    accessChange: row.accessChange,
    date: row.date,
  }));
  sheet('All source rows', rows);
  sheet('Skipped rows', rows.filter((row) => row.action === 'skipped'));
  sheet('Taxonomy additions', APPROVED_RESOURCE_TYPES.map((value) => ({
    category: 'Resource Type',
    subcategory: value,
    action: 'added additively',
  })));
  return book;
}

async function loadBundle() {
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.rows.length, 530, 'Source row count changed');
  assert.equal(workbook.checksum, SOURCE_CHECKSUM, 'Workbook differs from approved source');
  const rest = makeRestClient();
  const initial = await readStableRest(rest);
  const { report, afterCategories } = prepareApprovedReport(
    workbook,
    initial.snapshot.resources,
    initial.snapshot.categories,
  );
  const before = initial.snapshot;
  const plan = planApproved({ report, before, afterCategories, sourceChecksum: workbook.checksum });
  return { workbook, rest, initial, report, before, afterCategories, plan };
}

function summaryOutput(bundle) {
  return {
    mode: 'READ_ONLY_APPROVED_PLAN',
    sourceRows: bundle.report.summary.sourceRows,
    inserts: bundle.plan.inserts.length,
    updates: bundle.plan.updates.length,
    unchanged: bundle.plan.summary.unchanged,
    blocked: bundle.plan.summary.blocked,
    taxonomyAdditions: bundle.plan.categoryUpdates.length ? APPROVED_RESOURCE_TYPES : [],
    taxonomyPending: bundle.plan.categoryUpdates.length,
    accessChangesHeld: bundle.report.summary.accessChangeRows,
    databaseWrites: 0,
    destinationProject: DESTINATION_PROJECT,
    tenantId: TENANT_ID,
    coverage: bundle.initial.coverage,
    secondReadIdentical: bundle.initial.secondReadIdentical,
  };
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
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert(response.ok, 'Could not load trusted Supabase CA');
  const ca = await response.text();
  assert.equal(checksum(ca), '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
  const client = new pg.Client({ ...config, ssl: { rejectUnauthorized: true, ca } });
  const directory = `reports/bnms-final-resources/execution/${new Date().toISOString().replaceAll(':', '-')}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of [directory, `${directory}/..`, 'reports/bnms-final-resources', 'reports', '.']) syncDirectory(path);
  const save = (name, value) => durableFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2));
  const planBundle = {
    approval: APPROVAL_TEXT,
    input: INPUT,
    inputChecksum: bundle.workbook.checksum,
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenantId: TENANT_ID,
    taxonomyAdditions: APPROVED_RESOURCE_TYPES,
    accessChangesHeld: true,
    sourceRows: bundle.report.summary.sourceRows,
    summary: bundle.plan.summary,
    plan: bundle.plan,
  };
  save('plan', planBundle);
  save('before', bundle.before);
  save('taxonomy-before', bundle.before.categories);
  save('taxonomy-after', bundle.afterCategories);
  save('expected', bundle.plan.expected);
  const fd = openSync(`${directory}/journal.jsonl`, 'ax', 0o600);
  const journal = (entry) => writeComplete(fd, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  try {
    await client.connect();
    const result = await applyTransaction({ client, bundle, journal });
    save('transaction-result', result);
    // A successful replay must discover the exact expected state and issue
    // ROLLBACK without any category/resource DML.
    const replay = await applyTransaction({ client, bundle, journal });
    assert.equal(replay.writes, 0, 'Zero-DML replay wrote records');
    save('replay-result', replay);
    const final = await readStableRest(bundle.rest);
    const replayVerification = verifyApplied(bundle, final.snapshot);
    save('after', final);
    save('replay-after', final);
    const verification = {
      status: result.status,
      approval: APPROVAL_TEXT,
      tenantId: TENANT_ID,
      destinationProject: DESTINATION_PROJECT,
      inputChecksum: bundle.workbook.checksum,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: bundle.plan.summary.unchanged,
      blocked: bundle.plan.summary.blocked,
      skippedRows: bundle.plan.skipped.length,
      writes: result.writes,
      replayWrites: replay.writes,
      taxonomyAdded: result.taxonomyAdded ? APPROVED_RESOURCE_TYPES : [],
      initialResourceCount: bundle.before.resources.length,
      finalResourceCount: final.snapshot.resources.length,
      initialCategoryCount: bundle.before.categories.length,
      finalCategoryCount: final.snapshot.categories.length,
      allExpectedFieldsVerified: true,
      allRestrictedAccessPreserved: true,
      existingTagsAndClassificationsPreserved: true,
      taxonomyMetadataUnchangedExceptApprovedSubcategories: true,
      completePaginatedVerification: true,
      prewriteSecondReadIdentical: bundle.initial.secondReadIdentical,
      finalSecondReadIdentical: final.secondReadIdentical,
      replaySummary: replayVerification.summary,
      finalCoverage: final.coverage,
    };
    save('verification', verification);
    XLSX.writeFile(
      executionWorkbook(bundle.report, verification, bundle.plan),
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