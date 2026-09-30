/**
 * Migration: add organization_group_id to the member table.
 *
 * Members normally inherit their group from their linked organisation
 * (organization.organization_group_id). This column lets admins manually
 * assign a group to members who have no organisation.
 *
 * Run:
 *   DEST_SUPABASE_KEY=<service-role-key> node scripts/migrations/add-member-organization-group-id.mjs
 *
 * Applies the idempotent migration through the destination exec_sql RPC.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function columnExists(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return true;
  if (error.message?.includes('does not exist')) return false;
  throw new Error(`Unexpected error checking ${table}.${column}: ${error.message}`);
}

async function main() {
  console.log('Checking member.organization_group_id column...');

  const exists = await columnExists('member', 'organization_group_id');

  if (exists) {
    console.log('Already exists: member.organization_group_id — no migration needed.');
    return;
  }

  const sql = `
ALTER TABLE member
  ADD COLUMN IF NOT EXISTS organization_group_id uuid
    REFERENCES organization_group(id) ON DELETE SET NULL;

COMMENT ON COLUMN member.organization_group_id IS
  'Manual group override for members with no linked organisation. '
  'When the member has an organisation, the effective group is derived '
  'from organization.organization_group_id instead.';

CREATE INDEX IF NOT EXISTS member_organization_group_id_idx
  ON member (organization_group_id)
  WHERE organization_group_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
`.trim();
  const { error } = await supabase.rpc('exec_sql', { sql });
  if (error) throw new Error(`Could not apply migration through exec_sql: ${error.message}`);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await columnExists('member', 'organization_group_id')) {
      console.log('Applied and verified: member.organization_group_id');
      return;
    }
  }
  throw new Error('Migration ran, but member.organization_group_id was not visible through the destination API.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
