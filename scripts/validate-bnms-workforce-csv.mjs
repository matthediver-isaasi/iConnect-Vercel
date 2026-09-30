#!/usr/bin/env node
/**
 * Strictly read-only destination audit. Usage: node scripts/validate-bnms-workforce-csv.mjs
 * All arguments (including --apply) are rejected before any source/DB access.
 * Local report files only; no importer, RPC, migration or workflow invocation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE, parseSource, sourceSummary, EXPECTED_SHA256 } from './workforce-csv-source.mjs';
import { destinationClient, loadState, stateFingerprint } from './workforce-readonly-state.mjs';
import { auditSourceAgainstState } from './workforce-csv-audit.mjs';
import { writeReport } from './workforce-validation-report.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length) throw new Error('Validation only: no arguments or apply behavior supported.');
  const startedAt = new Date().toISOString();
  const source = parseSource(fs.readFileSync(FILE));
  const summary = sourceSummary(source);
  if (summary.totalRows !== 1242 || summary.totalDepartments !== 136 || summary.totalOccupiedHundredths !== 170814
    || summary.originalVacancyCounts[''] !== 53 || summary.normalizedVacancyCounts.No !== 1141
    || summary.normalizedVacancyCounts.Yes !== 101) throw new Error('Pinned source totals differ.');
  const ids = [...new Set(source.rows.map(r => r.departmentId))];
  const db = destinationClient();
  const first = await loadState(db, ids);
  const second = await loadState(db, ids);
  const fingerprint = stateFingerprint(first);
  if (stateFingerprint(second) !== fingerprint) throw new Error('Live data changed between complete reads; no readiness claim is possible.');
  const audit = auditSourceAgainstState(source, second);
  if (parseSource(fs.readFileSync(FILE)).fingerprint !== EXPECTED_SHA256) throw new Error('Source changed during validation.');
  const observation = { startedAt, finishedAt: new Date().toISOString(), fingerprint,
    completePasses: 2, stableAcrossPasses: true, databaseWrites: 0, firstPassPagination: first.ledger };
  // Local evidence cache for offline report review; never published as a full
  // tenant dump. The report writer projects only workforce-relevant evidence.
  fs.writeFileSync('/tmp/bnms-workforce-final-state.json', JSON.stringify(second));
  const outDir = path.resolve('reports/bnms-workforce-validation');
  const report = writeReport({ source, summary, state: second, audit, observation, outDir });
  console.log(JSON.stringify({ status: report.status, source: { rows: summary.totalRows, departments: summary.totalDepartments,
    occupiedWte: summary.totalWte, normalizedVacancy: summary.normalizedVacancyCounts, duplicates: summary.exactDuplicates },
  counts: audit.counts, blockers: audit.blockers.map(({ lines, ...b }) => ({ ...b, lines: lines?.slice(0, 5) })),
  report: path.relative(process.cwd(), outDir), safety: report.safety }, null, 2));
  // Blocked validation is a successful audit result, not a ready-to-import result.
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`READ-ONLY AUDIT STOPPED: ${error.message}`);
    process.exitCode = 1;
  });
}