// Offline release gate only. Never connects to a database or executes SQL.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const FUNNEL_FOLLOW_UP_RELEASES = Object.freeze({
  membership: ['202701270001_event_funnel_membership_entitlements.sql'],
  activation: ['202702040001_event_funnel_controlled_activation.sql'],
});

export async function inspectManifest(directory = new URL('../supabase/migrations/', import.meta.url), release = 'base') {
  const names = await readdir(directory);
  const all = names.filter(name => /^\d+_event_funnel_.*\.sql$/.test(name)).sort();
  const followUps = new Set(Object.values(FUNNEL_FOLLOW_UP_RELEASES).flat());
  if (all.some(name => !/^20270123\d{4}_/.test(name) && !followUps.has(name))) {
    throw new Error('Unreviewed funnel migration source');
  }
  if (release !== 'base' && !Object.hasOwn(FUNNEL_FOLLOW_UP_RELEASES, release)) {
    throw new Error('Unknown funnel release');
  }
  // The installed base release is immutable. New features must never be
  // appended to the batch whose installer intentionally refuses a replay.
  const files = release === 'base' ? all.filter(name => /^20270123\d{4}_/.test(name))
    : FUNNEL_FOLLOW_UP_RELEASES[release];
  if (files.some(name => !names.includes(name))) throw new Error('A reviewed funnel migration is missing');
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

export function followUpDeploymentManifest(entries, release) {
  const expected = FUNNEL_FOLLOW_UP_RELEASES[release];
  if (!expected || entries.length !== expected.length ||
    entries.some((entry, index) => entry.file !== expected[index])) {
    throw new Error('Unreviewed follow-up release');
  }
  return entries.map(entry => {
    const [version, ...rest] = entry.file.split('_');
    const deploymentVersion = `${version.slice(0, 8)}12${version.slice(8)}`;
    return { ...entry, deploymentVersion, deploymentFile: `${deploymentVersion}_${rest.join('_')}` };
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
    'preChangeSchemaEvidence', 'partialBackoutReport',
    'fullBaselineMigrationReport', 'standaloneRegressionReport', 'signedReceiptRecoveryReport',
    'paymentReconciliationProcedure', 'operator', 'maintenanceWindow',
    'previousApplicationRevision',
  ];
  for (const key of required) requireEvidence(typeof evidence[key] === 'string' && evidence[key].trim().length > 0, `Missing ${key}`);
  for (const key of ['implementationComplete', 'purchasingDisabled', 'workersControlled', 'recoveryApproved']) {
    requireEvidence(evidence[key] === true, `Not confirmed: ${key}`);
  }
  const waiver = evidence.restoreRehearsalWaiver;
  const restoreWaived = waiver?.approvedByOwner === true && typeof waiver.reason === 'string'
    && waiver.reason.trim().length > 0 && typeof waiver.approvedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(waiver.approvedAt) && Number.isFinite(Date.parse(waiver.approvedAt));
  if (!restoreWaived) {
    requireEvidence(typeof evidence.isolatedRestoreReport === 'string' && evidence.isolatedRestoreReport.trim().length > 0,
      'Missing isolatedRestoreReport');
    requireEvidence(Number.isFinite(evidence.measuredRestoreMinutes) && evidence.measuredRestoreMinutes > 0,
      'Missing measured restore duration');
  }
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
