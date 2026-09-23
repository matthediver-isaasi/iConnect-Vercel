#!/usr/bin/env node
// Pinned DEST bootstrap for the task-4628 read-only reconciler.
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
destinationTarget(process.env);
const { reconcile } = await import('./bnms-dd-trainee-reconcile.mjs');
try {
  const result = await reconcile();
  console.log(JSON.stringify({
    mode: 'private_read_only_reconciliation',
    totals: result.report.totals,
    reportSha256: result.reportSha256,
    reportCanonicalSha256: result.reportCanonicalSha256,
    evidenceSha256: result.evidenceSha256,
    evidenceFileSha256: result.evidenceFileSha256,
    envelopeSha256: result.envelopeSha256,
    outDir: result.outDir,
    writes: 0,
    providerWrites: 0,
    oauthRefreshes: 0,
  }));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, writes: 0, providerWrites: 0, oauthRefreshes: 0 }));
  process.exitCode = 1;
}