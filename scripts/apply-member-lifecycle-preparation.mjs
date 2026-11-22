// External Supabase only. Offline by default; never invoke from deployment/startup.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const migrations = ['20261122_member_lifecycle_preparation.sql', '20261122_member_lifecycle_login_evidence.sql',
  '20261122_member_lifecycle_review.sql', '20261122_member_lifecycle_access.sql',
  '20261122_member_lifecycle_provenance.sql',
  '20261122_member_lifecycle_source_fence.sql','20261122_member_lifecycle_runtime.sql',
  '20261122_member_lifecycle_operations.sql','20261122_member_lifecycle_visibility.sql',
  '20261122_member_lifecycle_privacy.sql','20261122_member_lifecycle_expiry_coordination.sql',
  '20261122_member_lifecycle_notifications.sql','20261122_member_lifecycle_release.sql'];
const parts = await Promise.all(migrations.map(name =>
  readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')));
// One explicit approval covers one atomic installation, not a partially
// committed subset if a later migration fails a prerequisite check.
const sql = 'BEGIN;\n' + parts.map(part => {
  if (!/^BEGIN;\s*$/m.test(part) || !/^COMMIT;\s*$/m.test(part)) throw new Error('Expected transactional lifecycle migration');
  return part.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
}).join('\n') + '\nCOMMIT;\n';
const hash = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ sha256: hash, migrations, dryRun: true, executionEnabled: false }));
} else if (args.length !== 2 || !args.includes('--apply') || !args.includes(`--review-sha256=${hash}`)) {
  console.error('Explicit approval and the exact reviewed migration SHA are required.');
  process.exitCode = 1;
} else {
  let client;
  try {
    const target = destinationTarget(process.env);
    const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
    if (!response.ok) throw new Error('TLS certificate unavailable');
    client = new pg.Client({ connectionString: target.toString(),
      ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
    await client.connect();
    await client.query("SET lock_timeout='10s'; SET statement_timeout='60s'");
    await client.query(sql);
    console.log('Lifecycle storage and access guards applied. Execution remains disabled; no lifecycle transition was requested.');
  } catch {
    await client?.query('ROLLBACK').catch(() => {});
    console.error('Lifecycle preparation migration failed. No credentials logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}
