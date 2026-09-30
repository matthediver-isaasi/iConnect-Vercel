/**
 * Comprehensive BNMS resource-import audit. GET-only; there is deliberately no
 * apply mode, mutation code, or credential fallback.
 */
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DESTINATION_PROJECT, DESTINATION_URL, SOURCES, TENANT_ID, deduplicate,
  readSource, reconcileRows, sha256,
} from './audit-bnms-resource-imports-lib.mjs';
import { writeAuditWorkbook } from './audit-bnms-resource-imports-writer.mjs';
import { readAll } from './bnms-youtube-categorisation.mjs';

export function readOnlyFetch(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`Read-only REST transport refused ${method}`);
  return fetch(input, init);
}

function walk(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function historicalEvidence(source) {
  const byRow = new Map();
  const evidence = [];
  if (!source.evidenceRoot) return { byRow, evidence };
  const files = walk(source.evidenceRoot).filter((path) => /(?:audit\.json|journal\.jsonl|verification\.json)$/.test(path));
  for (const path of files) {
    const raw = readFileSync(path, 'utf8');
    evidence.push({ sourceFile: source.path, evidenceFile: path, checksum: sha256(raw), byteLength: raw.length });
    if (path.endsWith('audit.json')) {
      try {
        const parsed = JSON.parse(raw);
        for (const row of parsed.rows || []) {
          if (row.status === 'blocked') byRow.set(Number(row.row), {
            ...(byRow.get(Number(row.row)) || {}), held: true, issues: row.issues || [], evidenceFile: path,
          });
        }
      } catch { /* checksum still inventories malformed/unrelated evidence */ }
    }
    if (path.endsWith('journal.jsonl')) {
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          for (const row of entry.skipped || []) {
            if (!Number.isInteger(Number(row.row))) continue;
            byRow.set(Number(row.row), {
              ...(byRow.get(Number(row.row)) || {}),
              held: true,
              issues: row.issues || [],
              evidenceFile: path,
            });
          }
        } catch { /* retain checksum evidence; malformed lines cannot prove outcomes */ }
      }
    }
    for (const match of raw.matchAll(/"row"\s*:\s*(\d+)\s*,\s*"id"\s*:\s*"([^"]+)"/g)) {
      const row = Number(match[1]);
      byRow.set(row, { ...(byRow.get(row) || {}), executedId: match[2], executionEvidenceFile: path });
    }
  }
  return { byRow, evidence };
}

function countBy(rows, field) {
  return Object.fromEntries([...new Set(rows.map((row) => row[field]))].sort().map(
    (value) => [value, rows.filter((row) => row[field] === value).length],
  ));
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 1 && ['--dry-run', '--from-snapshot'].includes(args[0]),
    'Exactly --dry-run or --from-snapshot is required; apply/live modes do not exist');
  const offline = args[0] === '--from-snapshot';
  if (!offline) {
    assert.equal(process.env.DEST_SUPABASE_URL, DESTINATION_URL, `Pinned DEST ${DESTINATION_PROJECT} is required`);
    assert(process.env.DEST_SUPABASE_KEY, 'Pinned DEST service credential is required');
  }

  const inventory = [];
  const sourceRows = [];
  const history = new Map();
  const historicalFiles = [];
  const scopeEvidence = JSON.parse(readFileSync('reports/bnms-resource-audit/scope-evidence.json', 'utf8'));
  const scopeByPath = new Map(scopeEvidence.uploads.map((upload) => [upload.path, upload]));
  for (const source of SOURCES) {
    assert(existsSync(source.path), `Surviving source disappeared: ${source.path}`);
    const extracted = readSource(source);
    const scoped = scopeByPath.get(source.path);
    assert(scoped, `Source is missing from supplemental scope evidence: ${source.path}`);
    assert.equal(extracted.inventory.checksum, scoped.sha256, `Scope checksum mismatch: ${source.path}`);
    inventory.push({ ...extracted.inventory, scopeEvidence: scoped });
    sourceRows.push(...extracted.rows.map((row) => ({ ...row, intent: source.intent })));
    const found = historicalEvidence(source);
    history.set(source.path, found.byRow);
    historicalFiles.push(...found.evidence);
  }

  let tenantData;
  let firstResources;
  let firstTaxonomy;
  let firstHash;
  let secondHash;
  let snapshotProvenance;
  if (offline) {
    const saved = JSON.parse(readFileSync('reports/bnms-resource-audit/replay-snapshot.json', 'utf8'));
    assert(saved.tenant?.id === TENANT_ID && saved.tenant?.name === 'BNMS', 'Offline snapshot tenant pin failed');
    assert(saved.snapshotProvenance?.destinationProject === DESTINATION_PROJECT, 'Offline snapshot project pin failed');
    tenantData = saved.tenant;
    firstResources = {
      rows: saved.resources,
      total: saved.resources.length,
      pages: saved.snapshotProvenance.resourcePagesFirst,
    };
    firstTaxonomy = {
      rows: saved.taxonomy,
      total: saved.taxonomy.length,
      pages: saved.snapshotProvenance.taxonomyPagesFirst,
    };
    firstHash = sha256(JSON.stringify({ resources: saved.resources, taxonomy: saved.taxonomy }));
    secondHash = saved.snapshotProvenance.secondHash;
    assert.equal(firstHash, saved.snapshotProvenance.firstHash, 'Offline replay snapshot bytes changed');
    assert.equal(firstHash, secondHash, 'Offline snapshot did not originate from stable reads');
    snapshotProvenance = {
      ...saved.snapshotProvenance,
      regeneratedOfflineAt: new Date().toISOString(),
      outputGenerationMode: 'offline replay; no production request',
    };
  } else {
    const client = createClient(DESTINATION_URL, process.env.DEST_SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: readOnlyFetch },
    });
    const tenant = await client.from('tenant').select('id,name').eq('id', TENANT_ID).single();
    assert(!tenant.error && tenant.data?.id === TENANT_ID && tenant.data?.name === 'BNMS', 'Pinned BNMS tenant check failed');
    tenantData = tenant.data;
    const startedAt = new Date().toISOString();
    firstResources = await readAll(client, 'resource', '*');
    firstTaxonomy = await readAll(client, 'resource_category', '*');
    assert(firstResources.total > 1000, 'Expected a full BNMS resource snapshot above 1,000 rows');
    const secondResources = await readAll(client, 'resource', '*');
    const secondTaxonomy = await readAll(client, 'resource_category', '*');
    firstHash = sha256(JSON.stringify({ resources: firstResources.rows, taxonomy: firstTaxonomy.rows }));
    secondHash = sha256(JSON.stringify({ resources: secondResources.rows, taxonomy: secondTaxonomy.rows }));
    assert.equal(firstHash, secondHash, 'Production changed between complete ordered reads');
    snapshotProvenance = {
      tenant: tenantData,
      destinationProject: DESTINATION_PROJECT,
      destinationUrl: DESTINATION_URL,
      startedAt,
      completedAt: new Date().toISOString(),
      resourceTotal: firstResources.total,
      resourcePagesFirst: firstResources.pages,
      resourcePagesSecond: secondResources.pages,
      taxonomyTotal: firstTaxonomy.total,
      taxonomyPagesFirst: firstTaxonomy.pages,
      taxonomyPagesSecond: secondTaxonomy.pages,
      firstHash,
      secondHash,
      stable: firstHash === secondHash,
      exactCountsChecked: true,
      orderedBy: 'id asc',
      transport: 'GET-only',
      databaseWrites: 0,
    };
  }

  const rows = reconcileRows(sourceRows, firstResources.rows, history);
  const distinctIdentities = deduplicate(rows);
  const fileSummaries = inventory.map((file) => {
    const fileRows = rows.filter((row) => row.sourceFile === file.path);
    return {
      path: file.path,
      checksum: file.checksum,
      populatedResourceRows: fileRows.length,
      classifications: countBy(fileRows, 'classification'),
      absentFromDestinationRows: fileRows.filter((row) => row.absentFromDestination).length,
      distinctIdentities: new Set(fileRows.map((row) => row.identity).filter(Boolean)).size,
    };
  });
  const audit = {
    mode: 'READ_ONLY_AUDIT',
    inventory,
    fileSummaries,
    rows,
    distinctIdentities,
    taxonomy: firstTaxonomy.rows,
    historicalEvidence: historicalFiles,
    supplementalScopeEvidence: {
      path: 'reports/bnms-resource-audit/scope-evidence.json',
      checksum: sha256(readFileSync('reports/bnms-resource-audit/scope-evidence.json')),
      auditedDateRange: ['2026-05-27', '2026-09-15'],
      executionJournals: scopeEvidence.executionJournals,
      caveats: scopeEvidence.caveats,
      excludedSurvivingCandidates: scopeEvidence.excludedSurvivingCandidates,
    },
    snapshotProvenance,
    summary: {
      survivingUploads: inventory.length,
      auditedDateRange: '2026-05-27 through 2026-09-15',
      sourceRows: rows.length,
      sourceRowAccounting: inventory.reduce((sum, file) => sum + file.populatedResourceRows, 0),
      sourceClassifications: countBy(rows, 'classification'),
      distinctIdentities: distinctIdentities.length,
      distinctClassifications: countBy(distinctIdentities, 'classification'),
      confirmedAbsentIdentities: distinctIdentities.filter((row) => row.classification === 'confirmed_absent_identity').length,
      intentionalHoldIdentities: distinctIdentities.filter((row) => row.classification === 'intentional_hold').length,
      historicallyHeldSourceRows: rows.filter((row) => row.historicalEvidence?.held).length,
      heldThenExecutedSourceRows: rows.filter(
        (row) => row.historicalEvidence?.held && row.historicalEvidence?.executedId,
      ).length,
      executedIdResolvedFormerlyAmbiguousRows: rows.filter(
        (row) => row.matchMethod === 'historical_executed_id'
          && row.urlIdentityCandidateIds.length !== 1,
      ).length,
      absentFromDestinationSourceRows: rows.filter((row) => row.absentFromDestination).length,
      absentFromDestinationUniqueIdentities: distinctIdentities.filter((row) => row.absentFromDestination).length,
      absentFromDestinationDistinctClassifications: countBy(
        distinctIdentities.filter((row) => row.absentFromDestination),
        'classification',
      ),
      databaseWrites: 0,
    },
  };
  audit.missingCandidateReview = {
    confirmedAbsent: distinctIdentities.filter((row) => row.classification === 'confirmed_absent_identity'),
    unresolvedWithoutExecutionEvidence: distinctIdentities.filter(
      (row) => row.classification === 'no_execution_evidence',
    ),
    policy: [
      'Only a unique exact URL or conservative provider identity establishes presence.',
      'Titles are review candidates only.',
      'Historical holds are not missing.',
      'No surviving row execution evidence is not proof of a failed import.',
      'Confirmed absent requires row-level execution identity followed by absence from the stable current snapshot.',
    ],
  };
  assert.equal(audit.summary.sourceRows, audit.summary.sourceRowAccounting, 'Source row accounting failed');

  const directory = 'reports/bnms-resource-audit';
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/audit.json`, JSON.stringify(audit, null, 2));
  writeFileSync(`${directory}/candidate-review.json`, JSON.stringify(audit.missingCandidateReview, null, 2));
  writeFileSync(`${directory}/replay-snapshot.json`, JSON.stringify({
    snapshotProvenance, tenant: tenantData, resources: firstResources.rows, taxonomy: firstTaxonomy.rows,
  }, null, 2));
  const summary = `# BNMS resource import audit — ${new Date().toISOString().slice(0, 10)}

**Read-only audit. No imports, updates, taxonomy changes, storage changes, or migrations occurred.**

- Surviving relevant uploads: ${audit.summary.survivingUploads}
- Audited upload window: ${audit.summary.auditedDateRange}
- Verified production project/tenant: ${DESTINATION_PROJECT} / ${TENANT_ID} (BNMS)
- Production read timestamp: ${snapshotProvenance.startedAt}; report generated: ${new Date().toISOString()}
- Populated source rows: ${audit.summary.sourceRows}
- Distinct resource identities: ${audit.summary.distinctIdentities}
- Source-row classifications: ${JSON.stringify(audit.summary.sourceClassifications)}
- Deduplicated classifications: ${JSON.stringify(audit.summary.distinctClassifications)}
- Confirmed absent identities (execution evidenced, now absent): ${audit.summary.confirmedAbsentIdentities}
- Intentional historical holds (not counted missing): ${audit.summary.intentionalHoldIdentities}
- Source rows with historical hold evidence (including rows now present): ${audit.summary.historicallyHeldSourceRows}
- Held-then-executed source rows: ${audit.summary.heldThenExecutedSourceRows}; terminal execution supersedes the earlier proposal/skip hold while both remain in the timeline.
- Executed IDs resolved ${audit.summary.executedIdResolvedFormerlyAmbiguousRows} rows that URL identity alone left ambiguous (six changed URLs and two duplicate URL identity groups).
- Identity absent from destination: ${audit.summary.absentFromDestinationUniqueIdentities} unique identities / ${audit.summary.absentFromDestinationSourceRows} source rows; ${JSON.stringify(audit.summary.absentFromDestinationDistinctClassifications)}. This includes held and unresolved identities and does not assert a failed import. Zero executed-now-absent identities does not mean zero identities are absent.
- Production resources: ${firstResources.total}; two full ordered exact-count reads, stable SHA-256 ${firstHash}

## Per-file totals

${fileSummaries.map((file) => `- ${file.path}: ${file.populatedResourceRows} rows; ${JSON.stringify(file.classifications)}; absentFromDestination rows ${file.absentFromDestinationRows}`).join('\n')}

“No execution evidence” is not a failed import finding. “Intentional hold” is not missing.
Ambiguous and metadata/access mismatch rows require review; title-only matches never establish identity.
The initial CSV has 29 parsed data records, not the task's claimed 61. The two
June poster CSVs are byte-identical, and the July/September Spring sets overlap.
Earlier CSV imports and YouTube classification have no surviving row execution journals.
`;
  writeFileSync(`${directory}/summary.md`, summary);
  writeAuditWorkbook(`${directory}/bnms-resource-import-audit.xlsx`, audit);
  console.log(JSON.stringify({ directory, ...audit.summary, snapshotHash: firstHash }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}