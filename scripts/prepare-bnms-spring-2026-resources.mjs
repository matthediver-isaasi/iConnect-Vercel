/**
 * GET-only approval/report generator for BNMS Spring Meeting 2026.
 *
 * It refuses every non-GET REST request, pins the source workbook and DEST
 * project, performs two complete ordered reads, and writes a durable
 * row-level proposal without changing the database.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
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
  SOURCE_CHECKSUM,
  SOURCE_ROWS,
  TENANT_ID,
} from './bnms-spring-2026-resources-proposal.mjs';

function readOnlyFetch(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`Read-only REST transport refused ${method}`);
  return fetch(input, init);
}

function jsonValue(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return value;
  return JSON.stringify(value);
}

function issueIndex(report) {
  const issues = {};
  for (const row of report.rows) {
    for (const issue of row.issues) (issues[issue] ??= []).push(row.row);
  }
  return issues;
}

function changedFields(report) {
  const fields = {};
  for (const row of report.rows) {
    for (const field of Object.keys(row.patch)) {
      if (row.before && JSON.stringify(row.before[field]) !== JSON.stringify(row.proposed[field])) {
        (fields[field] ??= []).push(row.row);
      }
    }
  }
  return fields;
}

function makeWorkbook(report, categories, metadata) {
  const book = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    const safeRows = rows.length ? rows : [{ value: '' }];
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.json_to_sheet(safeRows.map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, jsonValue(value)]),
      ))),
      name,
    );
  };
  const rowView = report.rows.map((row) => ({
    sourceRow: row.row,
    status: row.status,
    title: row.source.Title,
    resourceUrl: row.source['Resource URL'],
    memberOnly: row.source['Member Only'],
    collection: row.source.Collection,
    resourceType: row.source['Resource Type'],
    date: row.source.Date,
    selectedFocusAreas: row.selected['Focus Area'],
    matchMethod: row.matchMethod,
    candidateIds: row.candidateIds,
    titleOnlyCandidates: row.titleCandidates,
    issues: row.issues,
    notes: row.notes,
    coreChanges: row.coreChanges,
    accessChange: row.accessChange,
    displayTypeChange: row.displayTypeChange,
    before: {
      title: row.before?.title ?? null,
      description: row.before?.description ?? null,
      target_url: row.before?.target_url ?? null,
      release_date: row.before?.release_date ?? null,
      resource_type: row.before?.resource_type ?? null,
      is_public: row.before?.is_public ?? null,
      subcategories: row.before?.subcategories ?? null,
    },
    proposed: {
      title: row.proposed.title,
      description: row.proposed.description,
      target_url: row.proposed.target_url,
      release_date: row.proposed.release_date,
      resource_type: row.proposed.resource_type,
      is_public: row.proposed.is_public,
      subcategories: row.proposed.subcategories,
    },
    patch: row.patch,
  }));
  addSheet('Summary', Object.entries(report.summary).flatMap(([metric, value]) => (
    typeof value === 'object' && value !== null
      ? Object.entries(value).map(([key, nestedValue]) => ({
        metric: `${metric}.${key}`,
        value: nestedValue,
      }))
      : [{ metric, value }]
  )));
  addSheet('Rows', rowView);
  addSheet('Blocked', rowView.filter((row) => row.status === 'blocked'));
  addSheet('Changes', rowView.filter((row) => row.coreChanges.length
    || row.accessChange
    || row.displayTypeChange));
  addSheet('Taxonomy', categories);
  addSheet('Provenance', [{
    input: INPUT,
    inputChecksum: report.inputChecksum,
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenantId: TENANT_ID,
    requestedResourceType: DOWNLOAD_RESOURCE_TYPE,
    memberOnlyOverride: true,
    readAt: metadata.readAt,
    completedAt: metadata.completedAt,
    snapshotChecksum: metadata.snapshotChecksum,
    coverage: metadata.coverage,
    generatorChecksums: metadata.generatorChecksums,
    headers: HEADERS,
  }]);
  return book;
}

function makeSummary(report, workbook, snapshot, metadata, issues, fields) {
  const issueText = Object.entries(issues).length
    ? Object.entries(issues).map(([issue, rows]) => `- ${issue}: ${rows.join(', ')}`).join('\n')
    : '- None.';
  const fieldText = Object.entries(fields).length
    ? Object.entries(fields).map(([field, rows]) => `- ${field}: ${rows.length} rows (${rows.join(', ')})`).join('\n')
    : '- None.';
  const duplicateText = report.duplicateGroups.length
    ? report.duplicateGroups.map((group) => (
      `- Rows ${group.rows.join(', ')} (${group.kind}, ${group.identical ? 'identical' : 'conflicting'}): ${group.key}; differing fields: ${group.differingFields.join(', ') || 'none'}`
    )).join('\n')
    : '- None.';
  return `# BNMS Spring Meeting 2026 — read-only reconciliation report

**READ ONLY. No database or taxonomy writes occurred.**

Tenant: BNMS (${TENANT_ID})  
DEST project: ${DESTINATION_PROJECT}  
DEST URL: ${DESTINATION_URL}  
Read window: ${metadata.readAt} to ${metadata.completedAt}

## Source and coverage

- Source: ${INPUT}
- Workbook SHA-256: ${report.inputChecksum}
- Resources rows: ${workbook.rows.length} (expected ${SOURCE_ROWS})
- Workbook headers: ${workbook.headers.length}; Lists is reference-only and not imported
- Destination snapshot SHA-256: ${metadata.snapshotChecksum}
- Destination resources: ${metadata.coverage.resourceTotal}; ordered pages: ${metadata.coverage.resourcePages.join(', ') || 'none'}
- Destination taxonomy definitions: ${metadata.coverage.categoryTotal}; ordered pages: ${metadata.coverage.categoryPages.join(', ') || 'none'}
- Two complete exact-count-checked ordered reads were identical.
- REST transport rejects non-GET methods; database writes: 0.
- Resource display type for these Drive files: ${DOWNLOAD_RESOURCE_TYPE} (verified against DEST).

## Row-level totals

${Object.entries(report.summary).map(([metric, value]) => `- ${metric}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n')}

## Mapping and safeguards

- Resource URL maps to target_url for inserts. Exact URL is preferred; unique Google Drive file identity is the conservative fallback. Identity-matched existing rows retain their stored URL variant.
- Title and Brief Description map to title and description. Blank descriptions preserve existing descriptions.
- Blank source dates preserve existing release dates and become null only for inserts. No date is inferred.
- Member Only Yes is explicitly applied as is_public=false, including existing public matches. Existing allowed_role_ids and member_group_id are preserved.
- These Drive resources use resource_type=download. Existing and new rows are checked against the current DEST value before execution.
- Events maps to the Collection category; Presentation or Posters maps to Resource Type; Yes-marked topics map to Focus Area. Artificial Intelligence maps to Artificial intelligence and Management and Workforce maps to Management & Workforce.
- Existing classifications and tags are additive/preserved. Unknown taxonomy values, including any value absent from the verified Focus Area category, are blocked; no taxonomy additions are proposed.
- Page URL and Menu Item remain audit context only. They never become resource URLs, folders, tags, menus, or inferred classifications.
- Embedded hyperlinks and formulas are retained in the row audit. Conflicting identities and formula-bearing rows are blocked.
- Multiple destination candidates, repeated source identities, and title-only coincidences are blocked. Titles never select a destination row.

## Existing field changes requiring review

${fieldText}

## Held-row issues

${issueText}

## Duplicate source identities

${duplicateText}

## Reproducibility

- audit.json contains every source row, hyperlink/formula metadata, matching candidates, before/proposed values, patches, and issues.
- snapshot.json contains the complete ordered tenant-scoped resources and taxonomy used by this comparison.
- approval-report.xlsx is the compact review copy.
- Generator SHA-256 values are recorded in audit.json and the workbook provenance sheet.
- Re-run read-only: node scripts/prepare-bnms-spring-2026-resources.mjs --dry-run
- Tests: node --test scripts/bnms-spring-2026-resources.test.mjs
- Execution refreshes all reads, rechecks source and destination identity, and writes only after atomic SQL drift checks.
`;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 1 && args[0] === '--dry-run', 'Read-only runner requires exactly --dry-run');
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.rows.length, SOURCE_ROWS, 'Source row count changed');
  assert.equal(workbook.checksum, SOURCE_CHECKSUM, 'Workbook differs from pinned source');
  assert.deepEqual(workbook.headers, HEADERS, 'Workbook headers differ from pinned mapping');
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  assert.equal(url, DESTINATION_URL, `Pinned DEST credentials required for ${DESTINATION_URL}`);
  assert(key, 'Pinned DEST credentials required; no fallback is allowed');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });
  const tenantResult = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
  assert(!tenantResult.error
    && tenantResult.data?.id === TENANT_ID
    && tenantResult.data?.name === 'BNMS', 'BNMS tenant identity verification failed');
  const readAt = new Date().toISOString();
  const resources = await readAll(client, 'resource', '*');
  const categories = await readAll(client, 'resource_category', '*');
  const snapshot = {
    tenant: tenantResult.data,
    resources: resources.rows,
    categories: categories.rows,
  };
  const secondResources = await readAll(client, 'resource', '*');
  const secondCategories = await readAll(client, 'resource_category', '*');
  assert.equal(
    checksum(JSON.stringify(snapshot)),
    checksum(JSON.stringify({
      tenant: tenantResult.data,
      resources: secondResources.rows,
      categories: secondCategories.rows,
    })),
    'Destination changed during comparison; rerun',
  );
  const report = buildReport(workbook, resources.rows, categories.rows);
  assert.deepEqual(
    report,
    buildReport(readWorkbook(readFileSync(INPUT)), snapshot.resources, snapshot.categories),
    'Offline replay differs',
  );
  const completedAt = new Date().toISOString();
  const metadata = {
    readAt,
    completedAt,
    snapshotChecksum: checksum(JSON.stringify(snapshot)),
    generatorChecksums: Object.fromEntries([
      'scripts/bnms-spring-2026-resources-proposal.mjs',
      'scripts/prepare-bnms-spring-2026-resources.mjs',
    ].map((path) => [path, checksum(readFileSync(path))])),
    coverage: {
      resourceTotal: resources.total,
      resourcePages: resources.pages,
      categoryTotal: categories.total,
      categoryPages: categories.pages,
      secondReadIdentical: true,
      allSourceRowsCompared: report.rows.length === workbook.rows.length,
    },
  };
  Object.assign(report, {
    input: INPUT,
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenant: tenantResult.data,
    readAt,
    completedAt,
    snapshotChecksum: metadata.snapshotChecksum,
    coverage: metadata.coverage,
    generatorChecksums: metadata.generatorChecksums,
    requestedResourceType: DOWNLOAD_RESOURCE_TYPE,
    memberOnlyOverride: true,
    databaseWrites: 0,
  });
  const directory = `reports/bnms-spring-2026-resources/${completedAt.replaceAll(':', '-')}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFileSync(`${directory}/${name}`, value, { mode: 0o600 });
  save('audit.json', JSON.stringify(report, null, 2));
  save('snapshot.json', JSON.stringify(snapshot, null, 2));
  save(
    'summary.md',
    makeSummary(report, workbook, snapshot, metadata, issueIndex(report), changedFields(report)),
  );
  XLSX.writeFile(
    makeWorkbook(report, categories.rows, metadata),
    `${directory}/approval-report.xlsx`,
    { compression: true },
  );
  console.log(JSON.stringify({
    directory,
    ...report.summary,
    requestedResourceType: DOWNLOAD_RESOURCE_TYPE,
    memberOnlyOverride: true,
    missingTaxonomy: report.missingTaxonomy,
    snapshotChecksum: metadata.snapshotChecksum,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});