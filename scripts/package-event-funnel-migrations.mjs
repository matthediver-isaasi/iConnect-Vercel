// Offline packaging only: no connection, SQL execution, or activation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectManifest, deploymentManifest, followUpDeploymentManifest } from './event-funnel-recovery-readiness.mjs';

export async function packageFunnelMigrations(output, { release = 'base' } = {}) {
  if (!output) throw new Error('An explicit new output directory is required');
  const source = new URL('../supabase/migrations/', import.meta.url);
  const entries = await inspectManifest(source, release);
  const manifest = release === 'base' ? deploymentManifest(entries) : followUpDeploymentManifest(entries, release);
  if (release === 'base' && manifest.length !== 45) throw new Error('The reviewed batch must contain exactly 45 migrations');
  // Read and validate everything before writing. Never overwrite an older package.
  const files = await Promise.all(manifest.map(async entry => {
    const sql = await readFile(new URL(entry.file, source));
    if (createHash('sha256').update(sql).digest('hex') !== entry.sha256) {
      throw new Error(`Source changed during packaging: ${entry.file}`);
    }
    return { entry, sql };
  }));
  const destination = path.resolve(output);
  await mkdir(destination);
  for (const { entry, sql } of files) {
    await writeFile(path.join(destination, entry.deploymentFile), sql, { flag: 'wx' });
  }
  const receipt = {
    formatVersion: 1,
    release,
    notice: 'Offline package only. Requires live history checks, baseline rehearsal, recovery evidence and explicit activation. Never push the source migration directory.',
    migrations: manifest.map(({ file, deploymentFile, deploymentVersion, sha256 }) =>
      ({ sourceFile: file, file: deploymentFile, version: deploymentVersion, sha256 })),
  };
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (![3, 4].includes(process.argv.length) || process.argv[2].startsWith('--')
    || (process.argv[3] && !/^--release=[a-z]+$/.test(process.argv[3]))) {
    throw new Error('Usage: node scripts/package-event-funnel-migrations.mjs <new-output-directory> [--release=membership|activation]');
  }
  const receipt = await packageFunnelMigrations(process.argv[2], { release: process.argv[3]?.split('=')[1] || 'base' });
  console.log(JSON.stringify({ count: receipt.migrations.length, notice: receipt.notice }));
}
