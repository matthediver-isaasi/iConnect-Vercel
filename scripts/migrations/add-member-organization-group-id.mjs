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
 * Then apply any printed SQL in the Supabase SQL Editor.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
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

  console.log('Needs adding: member.organization_group_id');
  console.log('');
  console.log('='.repeat(60));
  console.log('Run the following SQL in Supabase SQL Editor (DEST):');
  console.log('='.repeat(60));
  console.log(`
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
`.trim());
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
