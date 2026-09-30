/**
 * Task #3211 — member-driven membership fee tokens.
 *
 * Adds member_id to membership_fee_token and relaxes organization_id to
 * nullable, so workflow-created member fee links can be minted. Idempotent.
 *
 * Runs over the IPv4 pooler (DEST_DATABASE_URL — the production data target).
 * Usage: node scripts/apply-member-fee-token-migration.mjs
 */
import pg from 'pg';

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`ALTER TABLE membership_fee_token ADD COLUMN IF NOT EXISTS member_id UUID`);
  await client.query(`ALTER TABLE membership_fee_token ALTER COLUMN organization_id DROP NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_membership_fee_token_tenant_member ON membership_fee_token(tenant_id, member_id, membership_year)`);
  await client.query('COMMIT');
  console.log('membership_fee_token member columns ensured on DEST.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
