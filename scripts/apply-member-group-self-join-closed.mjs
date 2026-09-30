/**
 * Apply migration: add self_join_closed + self_join_closed_label to member_group
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS, safe to re-run.
 *
 * Usage:
 *   node scripts/apply-member-group-self-join-closed.mjs
 */
import pg from 'pg';

const { Client } = pg;

const client = new Client({ connectionString: process.env.DEST_DATABASE_URL });

await client.connect();

await client.query(`
  ALTER TABLE member_group
    ADD COLUMN IF NOT EXISTS self_join_closed BOOLEAN NOT NULL DEFAULT false
`);
console.log('✓ self_join_closed column present');

await client.query(`
  ALTER TABLE member_group
    ADD COLUMN IF NOT EXISTS self_join_closed_label TEXT
`);
console.log('✓ self_join_closed_label column present');

await client.end();
console.log('Migration applied successfully.');
