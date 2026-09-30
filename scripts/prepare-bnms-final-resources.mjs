/**
 * Fresh BNMS Resources comparison.
 *
 * This is intentionally a GET-only approval proposal. It has no --apply/live
 * mode and refuses any REST request whose method is not GET.
 *
 * Usage:
 *   node scripts/prepare-bnms-final-resources.mjs --dry-run
 */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';
import {
  buildReport,
  checksum,
  DESTINATION_PROJECT,
  DESTINATION_URL,
  HEADERS,
  INPUT,
  readAll,
  readWorkbook,
  TENANT_ID,
} from './bnms-final-resources-proposal.mjs';

const SOURCE_ROWS = 530;
const SOURCE_CHECKSUM = '0c408805b7dabb1ae84fb152de29043de8d3ebb045626f74fffb32d3b95e838e';

function readOnlyFetch(input, init) {
  const method = String(
    init?.method
      ?? input?.method
      ?? 'GET',
  ).toUpperCase();
  if (method !== 'GET') throw new Error(`Read-only REST transport refused ${method}`);
  return fetch(input, init);
}

function jsonValue(value) {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return value;
  return JSON.stringify(value);
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
    before: {
      title: row.before?.title ?? null,
      description: row.before?.description ?? null,
      target_url: row.before?.target_url ?? null,
      release_date: row.before?.release_date ?? null,
      is_public: row.before?.is_public ?? null,
      subcategories: row.before?.subcategories ?? null,
    },
    proposed: {
      title: row.proposed.title,
      description: row.proposed.description,
      target_url: row.proposed.target_url,
      release_date: row.proposed.release_date,
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
  addSheet('Core changes', rowView.filter((row) => row.coreChanges.length));
  addSheet('Taxonomy roles', categories);
  addSheet('Provenance', [{
    input: INPUT,
    inputChecksum: report.inputChecksum,
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenantId: TENANT_ID,
    readAt: metadata.readAt,
    completedAt: metadata.completedAt,
    snapshotChecksum: metadata.snapshotChecksum,
    coverage: metadata.coverage,
    generatorChecksums: metadata.generatorChecksums,
    headers: HEADERS,
  }]);
  return book;
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

function makeSummary(report, workbook, snapshot, metadata, issues, fields) {
  const duplicateText = report.duplicateGroups.length
    ? report.duplicateGroups.map((group) => (
      `- Rows ${group.rows.join(', ')} (${group.kind}, ${group.identical ? 'identical' : 'conflicting'}): ${group.key}; differing fields: ${group.differingFields.join(', ') || 'none'}`
    )).join('\n')
    : '- None.';
  const issueText = Object.entries(issues).length
    ? Object.entries(issues).map(([issue, rows]) => `- ${issue}: ${rows.join(', ')}`).join('\n')
    : '- None.';
  const fieldText = Object.entries(fields).length
    ? Object.entries(fields).map(([field, rows]) => `- ${field}: ${rows.length} rows (${rows.join(', ')})`).join('\n')
    : '- None.';
  const yearRows = report.rows
    .filter((row) => row.date.kind === 'year_only_requires_approval')
    .map((row) => row.row);
  const missingTaxonomy = report.missingTaxonomy.length
    ? report.missingTaxonomy.join('; ')
    : 'none';
  return `# BNMS final Resources — read-only approval comparison

**READ ONLY. No database or taxonomy writes occurred. This package is not an
execution instruction and has no live/apply mode.**

Tenant: BNMS (${TENANT_ID})  
DEST project: ${DESTINATION_PROJECT}  
DEST URL: ${DESTINATION_URL}  
Read window: ${metadata.readAt} to ${metadata.completedAt}

## Source and coverage

- Source: ${INPUT}
- Workbook SHA-256: ${report.inputChecksum}
- Resources rows: ${workbook.rows.length} (expected ${SOURCE_ROWS})
- Workbook headers: ${workbook.headers.length}; all ${report.topicMapping ? Object.keys(report.topicMapping).length : 0} topic columns mapped to Focus Area
- Reference sheets **Lists** and **Categories Event Photos & News** were inspected as reference only; no photos/news taxonomy or records are proposed.
- Destination snapshot SHA-256: ${metadata.snapshotChecksum}
- Destination resources: ${metadata.coverage.resourceTotal}; pages: ${metadata.coverage.resourcePages.join(', ') || 'none'}
- Destination taxonomy definitions: ${metadata.coverage.categoryTotal}; pages: ${metadata.coverage.categoryPages.join(', ') || 'none'}
- Two ordered, exact-count-checked tenant reads were made for resources and taxonomy; the second read hash was identical.
- REST client refuses non-GET methods; database writes: 0.
- Generator SHA-256 values are recorded in audit.json and the workbook provenance sheet.

## Totals (source-row level)

${Object.entries(report.summary).map(([metric, value]) => `- ${metric}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n')}

Blocked rows are excluded from executable insert/update/unchanged totals. Every
non-blocked update still requires explicit approval.

## Mapping and safeguards

- Resource URL → target_url for inserts. An identity-matched existing record retains its stored URL variant; URL variants are never silently rewritten.
- Title → title; Brief Description → description. A blank source description preserves an existing description rather than erasing it.
- Date → release_date. Excel serial dates are parsed using the existing BNMS helper. Four-digit year-only cells use January 1 as an approval convention and are flagged, not treated as a known day. Year-only source rows: ${yearRows.join(', ') || 'none'}.
- Member Only Yes → is_public=false; No → is_public=true for inserts. Existing is_public=false records remain restricted even when a source row says No; no access widening is proposed for those records.
- Collection → Collection subcategory; Resource Type → Resource Type subcategory; Yes topic markers → Focus Area subcategories. Management and Workforce maps only to the verified Management & Workforce value; Management and Radiopharmacy are mapped from this workbook's own topic headers.
- Existing subcategories are additive. Existing tags, allowed_role_ids, status, display type, folder/event links, author fields, and every other non-mapped field are preserved. No tags are inferred.
- Unknown or missing taxonomy is held and reported; no category or subcategory is created.
- Matching is conservative: exact trimmed URL first, then Drive-file or YouTube identity. Multiple destination candidates block the row. Repeated source identities block every row in the group. Titles are evidence only; title-only candidates block and never select an update.
- Page URL and Menu Item remain audit context. They do not become resource URLs, menus, folders, tags, or inferred classifications.
- Hyperlinks are captured and checked for blank targets/literals and identity conflicts. Formula-bearing rows are held for review; the reviewed workbook has no formulas.

## Exact changes requiring approval

### Existing mapped field changes

${fieldText}

Core fields are target_url, title, description and release_date. Classification
additions and access changes are counted separately above and shown row by row
in **Core changes** and **Rows**. The exact core-field counts are included in
coreChangeFields; the full before/proposed values remain in audit.json.

### Missing taxonomy

${missingTaxonomy}

### Held-row issues

${issueText}

### Duplicate source identities

${duplicateText}

## Files and reproducibility

- **approval-report.xlsx** — compact user review workbook with totals, every source-row decision, blocked rows, core changes, taxonomy/role snapshot and provenance.
- **audit.json** — complete machine-readable source rows, hyperlinks/formulas, matching candidates, before/proposed values and issues.
- **snapshot.json** — tenant, full ordered resource rows and full taxonomy rows used by this comparison (including role restrictions).
- **summary.md** — this decision summary.

Re-run read-only:
\`node scripts/prepare-bnms-final-resources.mjs --dry-run\`

Focused tests:
\`node --test scripts/bnms-final-resources-proposal.test.mjs\`

Before any separately approved execution, refresh the workbook checksum,
destination identity, taxonomy and all before-values; stop on any drift.
`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--dry-run') {
    throw new Error('Read-only runner requires exactly --dry-run; --apply/live is unsupported');
  }
  const workbook = readWorkbook(readFileSync(INPUT));
  assert.equal(workbook.rows.length, SOURCE_ROWS, 'Source row count changed');
  assert.equal(workbook.checksum, SOURCE_CHECKSUM, 'Workbook differs from reviewed source');
  assert.deepEqual(workbook.headers, HEADERS, 'Workbook headers differ from final Resources mapping');

  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (url !== DESTINATION_URL || !key) {
    throw new Error(`Pinned DEST credentials required for ${DESTINATION_URL}; no fallback is allowed`);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch },
  });
  const tenantResult = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
  if (tenantResult.error || tenantResult.data?.id !== TENANT_ID || tenantResult.data?.name !== 'BNMS') {
    throw new Error('BNMS tenant identity verification failed');
  }

  const readAt = new Date().toISOString();
  const resources = await readAll(client, 'resource', '*');
  const categories = await readAll(client, 'resource_category', '*');
  const snapshot = {
    tenant: tenantResult.data,
    resources: resources.rows,
    categories: categories.rows,
  };
  // Both complete ordered reads must have stable exact counts and bytes. This
  // catches concurrent edits before an approval package is produced.
  const secondResources = await readAll(client, 'resource', '*');
  const secondCategories = await readAll(client, 'resource_category', '*');
  const secondSnapshot = {
    tenant: tenantResult.data,
    resources: secondResources.rows,
    categories: secondCategories.rows,
  };
  const snapshotChecksum = checksum(JSON.stringify(snapshot));
  assert.equal(
    snapshotChecksum,
    checksum(JSON.stringify(secondSnapshot)),
    'Destination changed during comparison; rerun',
  );

  const report = buildReport(workbook, resources.rows, categories.rows);
  assert.deepEqual(
    report,
    buildReport(readWorkbook(readFileSync(INPUT)), snapshot.resources, snapshot.categories),
    'Offline replay differs',
  );
  for (const row of report.rows) {
    if (!row.before) continue;
    for (const [field, value] of Object.entries(row.proposed)) {
      if (JSON.stringify(value) !== JSON.stringify(row.before[field])) {
        assert.ok(Object.hasOwn(row.patch, field), `Undisclosed change at row ${row.row}: ${field}`);
      }
    }
  }

  const completedAt = new Date().toISOString();
  const metadata = {
    readAt,
    completedAt,
    snapshotChecksum,
    generatorChecksums: Object.fromEntries([
      'scripts/bnms-final-resources-proposal.mjs',
      'scripts/prepare-bnms-final-resources.mjs',
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
    destinationProject: DESTINATION_PROJECT,
    destinationUrl: DESTINATION_URL,
    tenant: tenantResult.data,
    readAt,
    completedAt,
    snapshotChecksum,
    coverage: metadata.coverage,
    generatorChecksums: metadata.generatorChecksums,
    databaseWrites: 0,
  });
  const directory = `reports/bnms-final-resources/${completedAt.replaceAll(':', '-')}`;
  mkdirSync(directory, { recursive: true });
  const save = (name, data) => writeFileSync(`${directory}/${name}`, data);
  save('audit.json', JSON.stringify(report, null, 2));
  save('snapshot.json', JSON.stringify(snapshot, null, 2));
  const issues = issueIndex(report);
  const fields = changedFields(report);
  save('summary.md', makeSummary(report, workbook, snapshot, metadata, issues, fields));
  XLSX.writeFile(
    makeWorkbook(report, categories.rows, metadata),
    `${directory}/approval-report.xlsx`,
    { compression: true },
  );
  console.log(JSON.stringify({
    directory,
    ...report.summary,
    missingTaxonomy: report.missingTaxonomy,
    snapshotChecksum,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});