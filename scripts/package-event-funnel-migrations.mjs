// Offline packaging only: no connection, SQL execution, or activation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectManifest, deploymentManifest } from './event-funnel-recovery-readiness.mjs';

export async function packageFunnelMigrations(output) {
  if (!output) throw new Error('An explicit new output directory is required');
  const source = new URL('../supabase/migrations/', import.meta.url);
  const manifest = deploymentManifest(await inspectManifest(source));
  if (manifest.length !== 45) throw new Error('The reviewed batch must contain exactly 45 migrations');
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
    notice: 'Offline package only. Requires live history checks, baseline rehearsal, recovery evidence and explicit activation. Never push the source migration directory.',
    migrations: manifest.map(({ file, deploymentFile, deploymentVersion, sha256 }) =>
      ({ sourceFile: file, file: deploymentFile, version: deploymentVersion, sha256 })),
  };
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2].startsWith('--')) {
    throw new Error('Usage: node scripts/package-event-funnel-migrations.mjs <new-output-directory>');
  }
  const receipt = await packageFunnelMigrations(process.argv[2]);
  console.log(JSON.stringify({ count: receipt.migrations.length, notice: receipt.notice }));
}
