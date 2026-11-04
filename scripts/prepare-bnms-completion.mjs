/** GET-only completion workbook comparison. No application mode exists. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import { INPUT, SOURCE_SHA, readCompletion, completionReport } from './bnms-completion-proposal.mjs';
import { checksum, readAll, TENANT_ID, DESTINATION_URL, DESTINATION_PROJECT } from './bnms-final-resources-proposal.mjs';

export function readOnlyFetch(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  assert.equal(method, 'GET', `Read-only transport refused ${method}`);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, DESTINATION_URL, 'Foreign destination refused');
  assert(['/rest/v1/tenant', '/rest/v1/resource', '/rest/v1/resource_category'].includes(url.pathname), 'Unexpected endpoint refused');
  const tenantKey = url.pathname === '/rest/v1/tenant' ? 'id' : 'tenant_id';
  assert.equal(url.searchParams.get(tenantKey), `eq.${TENANT_ID}`, 'Tenant filter required');
  return fetch(input, { ...init, redirect: 'error' });
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--dry-run'], 'Only --dry-run is supported');
  const workbook = readCompletion(readFileSync(INPUT));
  assert.equal(workbook.checksum, SOURCE_SHA);
  assert.equal(workbook.rows.length, 257);
  assert(process.env.DEST_SUPABASE_URL === DESTINATION_URL && process.env.DEST_SUPABASE_KEY, 'Pinned DEST credentials required; no fallback');
  const client = createClient(DESTINATION_URL, process.env.DEST_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: readOnlyFetch },
  });
  const startedAt = new Date().toISOString();
  const tenant = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
  assert(!tenant.error && tenant.data?.id === TENANT_ID && tenant.data.name === 'BNMS', 'BNMS identity check failed');
  const read = async () => {
    const resources = await readAll(client, 'resource', '*');
    const categories = await readAll(client, 'resource_category', '*');
    return { resources: resources.rows, categories: categories.rows, coverage: { resourceTotal: resources.total,
      resourcePages: resources.pages, categoryTotal: categories.total, categoryPages: categories.pages } };
  };
  const first = await read(), second = await read();
  assert.deepEqual(second, first, 'Production changed between complete ordered reads; stop');
  assert(first.resources.length > 1000, 'Unexpected resource coverage');
  const historicalPath = 'reports/bnms-resource-audit/audit.json';
  const historicalBytes = readFileSync(historicalPath);
  const history = JSON.parse(historicalBytes).rows;
  const report = completionReport(workbook, first.resources, first.categories, history);
  assert.deepEqual(report, completionReport(workbook, second.resources, second.categories, history), 'Replay mismatch');
  report.provenance = { input: INPUT, sourceChecksum: SOURCE_SHA, destinationProject: DESTINATION_PROJECT,
    tenant: tenant.data, startedAt, completedAt: new Date().toISOString(), coverage: first.coverage,
    snapshotChecksum: checksum(JSON.stringify(first)), stableSecondRead: true, transport: 'GET-only pinned endpoints and tenant',
    historicalPath, historicalChecksum: checksum(historicalBytes),
    generatorChecksums: Object.fromEntries(['scripts/prepare-bnms-completion.mjs', 'scripts/bnms-completion-proposal.mjs',
      'scripts/bnms-final-resources-proposal.mjs', 'scripts/bnms-youtube-categorisation.mjs',
      'scripts/audit-bnms-resource-imports-lib.mjs'].map(p => [p, checksum(readFileSync(p))])) };
  const directory = `generated-artifacts/bnms-completion/${report.provenance.completedAt.replaceAll(':', '-')}`;
  mkdirSync(directory, { recursive: true });
  const save = (file, value) => writeFileSync(`${directory}/${file}`, JSON.stringify(value, null, 2));
  save('audit.json', report);
  save('snapshot.json', { tenant: tenant.data, ...first });
  save('safe-subset.json', { sourceChecksum: SOURCE_SHA, subsetChecksum: report.safeSubsetChecksum,
    snapshotChecksum: report.provenance.snapshotChecksum, approvalRequired: true, rows: report.safeSubset });
  const book = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet((rows.length ? rows : [{ result: 'None' }])
    .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])))), name);
  const view = report.rows.map(r => ({ Reference: r.reference, 'Source reference': r.sourceReference, worksheetRow: r.row,
    status: r.status, title: r.source.Title, URL: r.url, date: r.source.Date, 'Member Only': r.source['Member Only'],
    Collection: r.source.Collection, 'Resource Type': r.source['Resource Type'], review: r.review,
    selected: r.selected, issues: r.issues, corrections: r.corrections, candidateIds: r.candidateIds,
    titleCandidates: r.titleCandidates, matchMethod: r.matchMethod, fieldChanges: r.patch, before: r.before,
    proposed: r.proposed, accessDecision: r.accessDecision, taxonomyAccess: r.taxonomyAccess, history: r.history,
    historicalCategoryResolution: r.historicalCategoryResolution, historicalHoldReview: r.historicalHoldReview }));
  add('Summary', Object.entries(report.summary).map(([metric, value]) => ({ metric, value })));
  add('All rows', view);
  add('Approval subset', view.filter(r => ['insert', 'update'].includes(r.status)));
  add('Blocked', view.filter(r => r.status === 'blocked'));
  add('Access decisions', view.filter(r => r.accessDecision));
  add('Unique identities', report.uniqueResources);
  add('Taxonomy', first.categories);
  add('Provenance', [report.provenance, { safeSubsetChecksum: report.safeSubsetChecksum }]);
  XLSX.writeFile(book, `${directory}/completion-review.xlsx`, { compression: true });
  const issueIndex = {};
  for (const r of report.rows) for (const i of r.issues) (issueIndex[i] ??= []).push(r.reference);
  save('issue-index.json', issueIndex);
  writeFileSync(`${directory}/summary.md`, `# BNMS completion workbook dry run

No production writes, imports, access changes, taxonomy changes, document downloads or notifications.
All readiness cells are unapproved. Statuses are analytical proposals, not permission to apply.

${JSON.stringify(report.summary, null, 2)}

Workbook SHA-256: ${SOURCE_SHA}
Safe subset SHA-256: ${report.safeSubsetChecksum}
Production read: ${startedAt} to ${report.provenance.completedAt}
Project: ${DESTINATION_PROJECT}; tenant: ${TENANT_ID} (BNMS).
Two complete ordered exact-count reads matched: ${JSON.stringify(first.coverage)}.

## Approval boundary
Approve only the exact references and field values in safe-subset.json after reviewing completion-review.xlsx.
Blocked rows are excluded. Blank readiness never means approved. No live runner is provided.
Existing access, role restrictions, unrelated classifications and blank dates/descriptions are preserved.
Access requests differing from existing access are held separately, including narrowing.
Dates stored as numeric text, month-year or year-only need an explicit complete date or a separately approved convention.
Historical source references and prior holds are retained; taxonomy availability does not resolve other issues.
Unresolved URLs are separate unresolved rows, not asserted unique resources.
Before any separately authorized live application: repeat current reads, stop on source/taxonomy/before-value drift,
pin the approved subset checksum, and require a zero-write replay.

## Issues
${Object.entries(issueIndex).map(([i, refs]) => `- ${i}: ${refs.length} rows — ${refs.join(', ')}`).join('\n')}
`);
  console.log(JSON.stringify({ directory, ...report.summary, issues: Object.fromEntries(Object.entries(issueIndex).map(([k,v]) => [k,v.length])), safeSubsetChecksum: report.safeSubsetChecksum }));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exitCode = 1; });
