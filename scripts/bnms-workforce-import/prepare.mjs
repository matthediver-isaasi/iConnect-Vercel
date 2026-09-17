#!/usr/bin/env node
/**
 * OFFLINE ONLY. Usage:
 * node scripts/bnms-workforce-import/prepare.mjs <state.json> <observation.json> <output-directory>
 * These inputs must come from the separately authorized two-pass GET audit.
 * Never connects to a DB; rejects --apply and all other flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE } from '../workforce-csv-source.mjs';
import { stateFingerprint, PROJECT } from '../workforce-readonly-state.mjs';
import { APPROVED, buildManifest, digest, serialize, renderInstallSql, renderInvokeSql } from './plan.mjs';
import { renderReview } from './review-report.mjs';

export function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args.some(a => a.startsWith('-'))) {
    throw new Error('Offline preparation only: state.json observation.json output-directory; --apply is forbidden');
  }
  const [statePath, observationPath, outDir] = args;
  const state = JSON.parse(fs.readFileSync(statePath));
  const observation = JSON.parse(fs.readFileSync(observationPath));
  if (observation.project !== PROJECT || observation.completePasses !== 2
    || observation.stableAcrossPasses !== true || observation.databaseWrites !== 0
    || observation.fingerprint !== stateFingerprint(state)
    || !Array.isArray(observation.firstPassPagination) || !Array.isArray(observation.secondPassPagination)
    || [observation.firstPassPagination, observation.secondPassPagination].some(pages =>
      pages.length === 0 || pages.some(p => p.complete !== true || p.count !== p.rowsRead))) {
    throw new Error('Complete matching destination GET evidence is required');
  }
  // No overwrite: a new audit/plan needs a new review directory.
  if (fs.existsSync(outDir)) throw new Error('Output directory already exists; preserve reviewed artifacts');
  const manifest = buildManifest(fs.readFileSync(FILE), state);
  // These exact file bytes are also the SQL literal's approval commitment.
  const manifestText = JSON.stringify(manifest);
  const template = fs.readFileSync(new URL('./import.sql.template', import.meta.url), 'utf8');
  const installSql = renderInstallSql(template, manifest);
  const invokeSql = renderInvokeSql();
  const review = {
    status: 'PREPARED_FOR_REVIEW_NOT_AUTHORIZED',
    approvals: APPROVED, observation,
    manifestSha256: digest(manifestText), installSqlSha256: digest(installSql),
    invokeSqlSha256: digest(invokeSql),
    summary: { surveys: 136, occurrences: 1242, edges: 1378, occupiedWte: 1708.14,
      No: 1141, Yes: 101, duplicateGroups: 84, occurrencesInDuplicateGroups: 216, repeats: 132,
      priorSurveysPreserved: 3, priorRowsPreserved: 8, priorEdgesPreserved: 11 },
    verification: { offlineOnly: true, sqlExecuted: false, databaseWrites: 0 },
  };
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, contents] of Object.entries({
    'manifest.json': manifestText,
    'review.json': serialize(review),
    'install.review-only.sql': installSql,
    'invoke.review-only.sql': invokeSql,
    'report.html': renderReview(manifest, review),
  })) fs.writeFileSync(path.join(outDir, name), contents, { flag: 'wx' });
  console.log(JSON.stringify({ status: review.status, manifestSha256: review.manifestSha256, output: outDir }));
  return review;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}