#!/usr/bin/env node
/** Offline-only package generation; accepts no apply mode and makes no network calls. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE } from '../workforce-csv-source.mjs';
import { PROJECT, stateFingerprint } from '../workforce-readonly-state.mjs';
import { APPROVED, buildManifest, digest, renderInstallSql, renderInvokeSql, serialize } from './plan.mjs';
import { renderReview } from './review-report.mjs';

export function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args.some(arg => arg.startsWith('-'))) {
    throw new Error('Offline preparation only: state.json observation.json output-directory; --apply is forbidden');
  }
  const [statePath, observationPath, outDir] = args;
  const state = JSON.parse(fs.readFileSync(statePath));
  const observation = JSON.parse(fs.readFileSync(observationPath));
  const pagesValid = pages => Array.isArray(pages) && pages.length > 0
    && pages.every(page => page.complete === true && page.count === page.rowsRead);
  if (observation.project !== PROJECT || observation.completePasses !== 2 || observation.stableAcrossPasses !== true
    || observation.databaseWrites !== 0 || observation.fingerprint !== stateFingerprint(state)
    || !pagesValid(observation.firstPassPagination) || !pagesValid(observation.secondPassPagination)) {
    throw new Error('Complete matching destination GET evidence is required');
  }
  if (fs.existsSync(outDir)) throw new Error('Output directory already exists; preserve reviewed artifacts');
  const manifest = buildManifest(fs.readFileSync(FILE), state);
  const manifestText = JSON.stringify(manifest);
  const installSql = renderInstallSql(fs.readFileSync(new URL('./import.sql.template', import.meta.url), 'utf8'), manifest);
  const invokeSql = renderInvokeSql();
  const review = {
    status: 'PREPARED_FOR_REVIEW_NOT_AUTHORIZED', approvals: APPROVED, observation,
    manifestSha256: digest(manifestText), installSqlSha256: digest(installSql), invokeSqlSha256: digest(invokeSql),
    summary: { occurrences: 1242, edges: 1242, occupiedWte: 1708.14, No: 1141, Yes: 101,
      duplicateGroups: 84, occurrencesInDuplicateGroups: 216, repeats: 132, priorRowsPreserved: 8 },
    verification: { offlineOnly: true, sqlExecuted: false, databaseWrites: 0 },
  };
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, contents] of Object.entries({
    'manifest.json': manifestText, 'review.json': serialize(review), 'install.review-only.sql': installSql,
    'invoke.review-only.sql': invokeSql, 'report.html': renderReview(manifest, review),
  })) fs.writeFileSync(path.join(outDir, name), contents, { flag: 'wx' });
  console.log(JSON.stringify({ status: review.status, manifestSha256: review.manifestSha256, output: outDir }));
  return review;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}