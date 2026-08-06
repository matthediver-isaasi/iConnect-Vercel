/**
 * Apply migration: add group_admins_can_edit_content to member_group.
 *
 * When true, Group Admins of the group may edit the header image and the
 * description text fields from the group detail page (never the name).
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS, safe to re-run.
 *
 * Usage:
 *   node scripts/apply-member-group-admin-content-edit.mjs
 */
import pg from 'pg';

const { Client } = pg;

const connectionString = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL (or DATABASE_URL) must be set');
  process.exit(1);
}

const client = new Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();

await client.query(`
  ALTER TABLE member_group
    ADD COLUMN IF NOT EXISTS group_admins_can_edit_content BOOLEAN NOT NULL DEFAULT false
`);
console.log('✓ group_admins_can_edit_content column present');

await client.end();
console.log('Migration applied successfully.');
