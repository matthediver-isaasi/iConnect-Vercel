import { readFile } from 'node:fs/promises';
import pg from 'pg';

const attentionOnly = process.argv.includes('--attention-only');
const workflowOutboxOnly = process.argv.includes('--workflow-outbox-only');
const oneOffReadyOnly = process.argv.includes('--one-off-ready-only');
const oneOffReadyRecoveryOnly = process.argv.includes('--one-off-ready-recovery-only');
const oneOffReadyRecoverySafetyOnly = process.argv.includes('--one-off-ready-recovery-safety-only');
if ([attentionOnly, workflowOutboxOnly, oneOffReadyOnly, oneOffReadyRecoveryOnly, oneOffReadyRecoverySafetyOnly].filter(Boolean).length > 1) {
  throw new Error('Use only one additive migration selector at a time.');
}
const files = attentionOnly
  ? ['20261019_form_due_diligence_expired_processing_attention.sql']
  : workflowOutboxOnly
    ? ['20261020_form_due_diligence_field_mapping_workflow_outbox.sql']
    : oneOffReadyOnly
      ? ['20261021_form_due_diligence_one_off_ready.sql']
      : oneOffReadyRecoveryOnly
        ? ['20261022_form_due_diligence_one_off_ready_recovery.sql']
        : oneOffReadyRecoverySafetyOnly
          ? ['20261023_form_due_diligence_one_off_ready_recovery_safety.sql']
          : ['20261018_form_due_diligence_initialization.sql'];

if (!process.argv.includes('--apply')) {
  console.log(`Dry run: would apply ${files.join(', ')} to DEST_DATABASE_URL only.`);
} else {
  if (!process.env.DEST_DATABASE_URL) {
    throw new Error('DEST_DATABASE_URL is required. No database was changed.');
  }
  const client = new pg.Client({ connectionString: process.env.DEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    for (const file of files) {
      await client.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
      console.log(`Applied ${file}`);
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}