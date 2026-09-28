#!/usr/bin/env node
// One-time operator repair. No runtime integration, schedule, migration or email sending.
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { TENANT_ID, buildResetPlan } from './lib/bnms-communication-reset-plan.mjs';
import {
  digest, loadSnapshot, inspectContract, acquireIdentityLocks, executePlan,
  verifyChanges, changeCount, reportEvidence, independentPairCheck, protectedFingerprints,
} from './lib/bnms-communication-reset-db.mjs';

const PRIVATE_ROOT = '/home/runner/.private-data-repairs/bnms-communication-reset';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const PROJECT = 'lvmzliemqnieeoruhkik';

async function privateFile(name, data) {
  await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const root = await realpath(PRIVATE_ROOT);
  const workspace = await realpath(path.resolve(fileURLToPath(new URL('..', import.meta.url))));
  if (root === workspace || root.startsWith(`${workspace}/`) || (await stat(root)).mode & 0o077) {
    throw new Error('Before-images must be private and outside the tracked workspace');
  }
  const filename = path.join(root, name);
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return filename;
}

async function implementationHash() {
  const files = [
    'reset-bnms-communication-subscriptions.mjs',
    'lib/bnms-communication-reset-db.mjs',
    'lib/bnms-communication-reset-plan.mjs',
    '../shared/communicationCategoryMembership.js',
    '../shared/memberCommunicationStatusReport.js',
  ];
  return digest(await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), 'utf8'))));
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0] || '--dry-run';
  if (!['--dry-run', '--apply'].includes(mode)
      || (mode === '--dry-run' && args.length > 1)
      || (mode === '--apply' && (args.length !== 2 || !/^[a-f0-9]{64}$/.test(args[1])))) {
    throw new Error('Use --dry-run or --apply <reviewed-sha256>');
  }
  const target = destinationTarget(process.env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error('Could not load trusted destination CA');
  const ca = await response.text();
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  let committed = false;
  try {
    await client.connect();
    await client.query(mode === '--apply'
      ? 'BEGIN ISOLATION LEVEL SERIALIZABLE'
      : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    const snapshot = await loadSnapshot(client);
    const plan = buildResetPlan(snapshot);
    const contract = await inspectContract(client);
    const implementation = await implementationHash();
    const manifest = { project: PROJECT, tenantId: TENANT_ID, implementation, snapshot, plan, contract };
    const reviewHash = digest(manifest);
    const summary = {
      database: `Production DEST (${PROJECT})`, tenant: 'BNMS', tenantId: TENANT_ID,
      reviewHash, ...plan.summary, changes: changeCount(plan),
      report: reportEvidence(snapshot, plan), independent: await independentPairCheck(client),
      migrationsNeeded: false, migrationsApplied: 0, emailsSentByRepair: 0,
    };
    if (mode === '--dry-run') {
      await client.query('COMMIT');
      const filename = await privateFile(`review-${reviewHash}-${Date.now()}.json`, manifest);
      console.log(JSON.stringify({ dryRun: true, ...summary, privateReviewFile: filename }, null, 2));
      return;
    }
    if (reviewHash !== args[1]) throw new Error('Reviewed target or implementation changed; run a new dry-run');
    if (!changeCount(plan)) {
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ dryRun: false, zeroChangeReplay: true, ...summary }, null, 2));
      return;
    }
    await acquireIdentityLocks(client, snapshot);
    if (digest(await loadSnapshot(client)) !== digest(snapshot)
        || digest(await inspectContract(client)) !== digest(contract)) {
      throw new Error('Target changed while acquiring locks');
    }
    const protectedBefore = await protectedFingerprints(client);
    const recordId = `${reviewHash}-${Date.now()}`;
    const beforeFile = await privateFile(`before-${recordId}.json`, {
      ...manifest, protectedBefore, summary,
      recovery: 'Restore only these consent fields and preference/ledger rows after comparing to the after-image. Never overwrite later member preference changes. Use the same identity locks and an explicit transaction.',
    });
    await executePlan(client, snapshot, plan);
    const after = await loadSnapshot(client);
    const replay = verifyChanges(snapshot, after, plan);
    const independent = await independentPairCheck(client);
    if (independent.global_mismatches || independent.pair_mismatches
        || independent.global_suppressions || independent.category_suppression_pairs
        || independent.expected_pairs !== plan.summary.eligiblePairs
        || independent.members !== plan.members.length) {
      throw new Error('Independent persisted consent verification failed');
    }
    const protectedAfter = await protectedFingerprints(client);
    if (digest(protectedBefore) !== digest(protectedAfter)) throw new Error('Unrelated data changed; rolled back');
    const afterReport = reportEvidence(after, plan);
    const afterFile = await privateFile(`after-${recordId}.json`, { after, replay, independent, protectedAfter, afterReport });
    await client.query('COMMIT');
    committed = true;
    // Separate transaction/connection snapshot proves committed outcomes, not just uncommitted writes.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const persisted = await loadSnapshot(client);
    const persistedPlan = buildResetPlan(persisted);
    const persistedCheck = await independentPairCheck(client);
    await client.query('COMMIT');
    const evidence = {
      ...summary, applied: true, privateBeforeFile: beforeFile, privateAfterFile: afterFile,
      afterReport, independentAfter: independent, protectedDataUnchanged: true,
      persistedReplayChanges: changeCount(persistedPlan), persistedCheck,
      unresolvedExceptions: 0,
    };
    await privateFile(`receipt-${recordId}.json`, evidence);
    console.log(JSON.stringify(evidence, null, 2));
    if (changeCount(persistedPlan) !== 0) throw new Error('Committed repair followed by concurrent changes; inspect receipt, do not reapply automatically');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Never echo connection configuration, row data or driver error details.
    console.error(JSON.stringify({ completed: false, committed, reason: error.code || error.message }));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();