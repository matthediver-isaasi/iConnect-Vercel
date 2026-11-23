// Offline release gate only. Never connects to a database or executes SQL.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function inspectManifest(directory = new URL('../supabase/migrations/', import.meta.url)) {
  const names = await readdir(directory);
  const files = names.filter(name => /^\d+_event_funnel_.*\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No event funnel migrations found');
  const entries = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    const version = file.split('_')[0];
    entries.push({
      file, version,
      sha256: createHash('sha256').update(sql).digest('hex'),
      collisions: names.filter(name => name !== file && name.startsWith(`${version}_`) && name.endsWith('.sql')),
    });
  }
  return entries;
}

// Keep source names stable for existing fixtures and references. A deployment
// package uses distinct 14-digit versions; never push the source directory.
export function deploymentManifest(entries) {
  const versions = new Set();
  return entries.map(entry => {
    const match = /^20270123(\d{4})_(event_funnel_.+)\.sql$/.exec(entry.file);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 45) {
      throw new Error(`Unreviewed funnel migration source: ${entry.file}`);
    }
    const deploymentVersion = `2027012312${match[1]}`;
    if (versions.has(deploymentVersion)) throw new Error('Duplicate funnel deployment version');
    versions.add(deploymentVersion);
    return { ...entry, deploymentVersion, deploymentFile: `${deploymentVersion}_${match[2]}.sql` };
  });
}

export function evaluateRecoveryEvidence(entries, evidence = {}) {
  const blockers = [];
  const requireEvidence = (ok, label) => { if (!ok) blockers.push(label); };
  requireEvidence(entries.length > 0, 'Migration manifest is empty');
  requireEvidence(entries.every(entry => !entry.collisions.length), 'Migration version collisions remain');
  requireEvidence(evidence.manifest?.length === entries.length &&
    entries.every((entry, index) => evidence.manifest[index]?.file === entry.file &&
      evidence.manifest[index]?.sha256 === entry.sha256), 'Evidence does not match the exact ordered migration files and hashes');
  const required = [
    'targetIdentity', 'backupRestorePoint', 'restoreWindowVerifiedAt',
    'isolatedRestoreReport', 'preChangeSchemaEvidence', 'partialBackoutReport',
    'fullBaselineMigrationReport', 'standaloneRegressionReport', 'signedReceiptRecoveryReport',
    'paymentReconciliationProcedure', 'operator', 'maintenanceWindow',
    'previousApplicationRevision',
  ];
  for (const key of required) requireEvidence(typeof evidence[key] === 'string' && evidence[key].trim().length > 0, `Missing ${key}`);
  for (const key of ['implementationComplete', 'purchasingDisabled', 'workersControlled', 'recoveryApproved']) {
    requireEvidence(evidence[key] === true, `Not confirmed: ${key}`);
  }
  requireEvidence(Number.isFinite(evidence.measuredRestoreMinutes) && evidence.measuredRestoreMinutes > 0,
    'Missing measured restore duration');
  requireEvidence(Number.isFinite(evidence.acceptedDataLossMinutes) && evidence.acceptedDataLossMinutes >= 0,
    'Missing approved data-loss tolerance');
  return { readyForOperatorReview: blockers.length === 0, blockers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: node scripts/event-funnel-recovery-readiness.mjs [evidence.json] (offline only)');
  }
  const manifest = await inspectManifest();
  const evidence = args[0] ? JSON.parse(await readFile(args[0], 'utf8')) : {};
  const result = evaluateRecoveryEvidence(manifest, evidence);
  console.log(JSON.stringify({ ...result, manifest, notice: 'Evidence completeness check only; not backup verification or permission to migrate.' }, null, 2));
  process.exitCode = result.readyForOperatorReview ? 0 : 1;
}
