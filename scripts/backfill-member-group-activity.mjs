/**
 * Backfill member_group_activity 'joined' events for all current
 * member_group_assignment rows that do not yet have an activity record.
 *
 * Idempotent: skips any (member_id, group_id) pair that already has at least
 * one 'joined' row so it is safe to re-run.
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Usage:
 *   node scripts/backfill-member-group-activity.mjs           # dry-run
 *   node scripts/backfill-member-group-activity.mjs --apply   # write
 *
 * Requires DEST_SUPABASE_URL + DEST_SUPABASE_KEY (or falls back to
 * SUPABASE_URL + SUPABASE_SERVICE_KEY for local dev).
 */
import { createClient } from '@supabase/supabase-js';

const isDryRun = !process.argv.includes('--apply');

const supabaseUrl  = process.env.DEST_SUPABASE_URL  || process.env.SUPABASE_URL;
const supabaseKey  = process.env.DEST_SUPABASE_KEY  || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('DEST_SUPABASE_URL / DEST_SUPABASE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const PAGE_SIZE = 500;

async function run() {
  console.log(`Mode: ${isDryRun ? 'DRY RUN (pass --apply to write)' : 'APPLY'}`);

  let offset = 0;
  let totalAssignments = 0;
  let totalSkipped = 0;
  let totalInserted = 0;
  let totalErrors = 0;

  while (true) {
    const { data: assignments, error: assignErr } = await supabase
      .from('member_group_assignment')
      .select('id, tenant_id, member_id, group_id, created_at')
      .not('member_id', 'is', null)
      .not('group_id', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (assignErr) {
      console.error('Error fetching assignments:', assignErr.message);
      process.exit(1);
    }

    if (!assignments || assignments.length === 0) break;

    totalAssignments += assignments.length;

    const groupIds = [...new Set(assignments.map((a) => a.group_id).filter(Boolean))];

    const { data: groups, error: groupErr } = await supabase
      .from('member_group')
      .select('id, name')
      .in('id', groupIds);

    if (groupErr) {
      console.error('Error fetching groups:', groupErr.message);
      process.exit(1);
    }

    const groupNameMap = new Map((groups || []).map((g) => [g.id, g.name || '(deleted group)']));

    for (const a of assignments) {
      if (!a.member_id || !a.group_id || !a.tenant_id) {
        totalSkipped++;
        continue;
      }

      const { data: existing, error: existErr } = await supabase
        .from('member_group_activity')
        .select('id')
        .eq('tenant_id', a.tenant_id)
        .eq('member_id', a.member_id)
        .eq('group_id', a.group_id)
        .eq('action', 'joined')
        .limit(1)
        .maybeSingle();

      if (existErr) {
        console.error(`Error checking existing for assignment ${a.id}:`, existErr.message);
        totalErrors++;
        continue;
      }

      if (existing) {
        totalSkipped++;
        continue;
      }

      const groupName = groupNameMap.get(a.group_id) || '(unknown group)';
      const createdAt = a.created_at || new Date().toISOString();

      if (isDryRun) {
        console.log(`[DRY RUN] Would insert: member=${a.member_id} group=${a.group_id} (${groupName}) action=joined at=${createdAt}`);
        totalInserted++;
        continue;
      }

      const { error: insErr } = await supabase
        .from('member_group_activity')
        .insert({
          tenant_id: a.tenant_id,
          member_id: a.member_id,
          group_id: a.group_id,
          group_name: groupName,
          action: 'joined',
          actor_email: null,
          created_at: createdAt,
        });

      if (insErr) {
        console.error(`Error inserting for assignment ${a.id}:`, insErr.message);
        totalErrors++;
      } else {
        console.log(`Inserted: member=${a.member_id} group=${groupName} at=${createdAt}`);
        totalInserted++;
      }
    }

    if (assignments.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log('\n--- Summary ---');
  console.log(`Assignments scanned : ${totalAssignments}`);
  console.log(`Already had record  : ${totalSkipped}`);
  console.log(`${isDryRun ? 'Would insert' : 'Inserted'}      : ${totalInserted}`);
  console.log(`Errors              : ${totalErrors}`);
  if (isDryRun) console.log('\nRe-run with --apply to write.');
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
