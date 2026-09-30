import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const CSV_PATH = path.join(__dirname, '..', 'attached_assets', 'Members_to_delete_from_iConnect_30.01.26_1770620490851.csv');

const EXECUTE_MODE = process.argv.includes('--execute');
const CONFIRM_ORGS = process.argv.includes('--confirm-orgs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function readEmailsFromCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  return lines
    .map(line => line.trim().toLowerCase())
    .filter(email => email.length > 0 && email.includes('@'));
}

async function findMatchingMembers(emails) {
  const BATCH_SIZE = 50;
  const allMatches = [];

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const { data, error } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, organization_id, organization(id, name)')
      .in('email', batch);

    if (error) {
      console.error(`Error querying batch ${i / BATCH_SIZE + 1}:`, error.message);
      continue;
    }

    if (data) {
      allMatches.push(...data);
    }
  }

  return allMatches;
}

const DEPENDENT_TABLES = [
  { table: 'member_group_assignment', col: 'member_id' },
  { table: 'member_bookmark', col: 'member_id' },
  { table: 'member_bookmark_preferences', col: 'member_id' },
  { table: 'communication_preference', col: 'member_id' },
  { table: 'preference_value', col: 'member_id' },
  { table: 'event_booking', col: 'member_id' },
  { table: 'due_diligence_response', col: 'member_id' },
  { table: 'workflow_instance', col: 'member_id' },
  { table: 'forum_reaction', col: 'member_id' },
  { table: 'forum_report', col: 'reporter_id' },
  { table: 'forum_post', col: 'author_id' },
  { table: 'forum_thread', col: 'author_id' },
  { table: 'fundraising_donation', col: 'member_id' },
  { table: 'member_role', col: 'member_id' },
];

async function countDependentRecords(memberIds) {
  const results = {};
  for (const { table, col } of DEPENDENT_TABLES) {
    let total = 0;
    for (let i = 0; i < memberIds.length; i += 50) {
      const batch = memberIds.slice(i, i + 50);
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .in(col, batch);
      if (error) {
        results[table] = { count: 0, error: error.message };
        break;
      }
      total += (count || 0);
    }
    if (!results[table]) results[table] = { count: total };
  }
  return results;
}

async function deleteDependentRecords(memberIds) {
  console.log('  Cleaning up dependent records...');
  for (const { table, col } of DEPENDENT_TABLES) {
    for (let i = 0; i < memberIds.length; i += 50) {
      const batch = memberIds.slice(i, i + 50);
      const { error } = await supabase.from(table).delete().in(col, batch);
      if (error && !error.message.includes('does not exist')) {
        console.error(`  Warning: Error cleaning ${table}: ${error.message}`);
      }
    }
  }
  console.log('  Dependent records cleaned.');
}

async function deleteMembers(members) {
  const BATCH_SIZE = 20;
  let deletedCount = 0;
  let failedCount = 0;
  const failures = [];

  const allIds = members.map(m => m.id);
  await deleteDependentRecords(allIds);

  console.log();
  console.log('  Deleting member records...');
  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const ids = batch.map(m => m.id);

    const { error } = await supabase
      .from('member')
      .delete()
      .in('id', ids);

    if (error) {
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed, retrying individually...`);
      for (const member of batch) {
        const { error: individualError } = await supabase
          .from('member')
          .delete()
          .eq('id', member.id);
        if (individualError) {
          console.error(`  Failed: ${member.email} — ${individualError.message}`);
          failedCount++;
          failures.push({ ...member, error: individualError.message });
        } else {
          deletedCount++;
        }
      }
    } else {
      deletedCount += batch.length;
      console.log(`  Deleted batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} members`);
    }
  }

  return { deletedCount, failedCount, failures };
}

async function main() {
  console.log('='.repeat(70));
  console.log(EXECUTE_MODE
    ? '  MEMBER DELETION SCRIPT — EXECUTE MODE (CHANGES WILL BE MADE)'
    : '  MEMBER DELETION SCRIPT — DRY RUN (NO CHANGES WILL BE MADE)');
  console.log('='.repeat(70));
  console.log(`Tenant ID (reference): ${TENANT_ID}`);
  console.log(`CSV file: ${CSV_PATH}`);
  console.log();

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV file not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const csvEmails = readEmailsFromCsv(CSV_PATH);
  console.log(`Emails loaded from CSV: ${csvEmails.length}`);
  console.log();

  console.log('Searching for matching members...');
  const matchedMembers = await findMatchingMembers(csvEmails);

  const matchedEmailsLower = new Set(matchedMembers.map(m => m.email?.toLowerCase()));
  const notFound = csvEmails.filter(e => !matchedEmailsLower.has(e));

  const orgCounts = {};
  matchedMembers.forEach(m => {
    const orgName = m.organization?.name || 'Unknown';
    orgCounts[orgName] = (orgCounts[orgName] || 0) + 1;
  });

  console.log();
  console.log('-'.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('-'.repeat(70));
  console.log(`Emails in CSV:          ${csvEmails.length}`);
  console.log(`Members found:          ${matchedMembers.length}`);
  console.log(`Emails not found:       ${notFound.length}`);
  console.log();

  console.log('ORGANISATIONS AFFECTED:');
  console.log('-'.repeat(70));
  Object.entries(orgCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([orgName, count]) => {
      console.log(`  ${String(count).padStart(4)} members  —  ${orgName}`);
    });
  console.log();

  if (matchedMembers.length > 0) {
    console.log('MEMBERS TO BE DELETED:');
    console.log('-'.repeat(70));
    matchedMembers
      .sort((a, b) => (a.email || '').localeCompare(b.email || ''))
      .forEach((m, i) => {
        const orgName = m.organization?.name || 'N/A';
        console.log(`  ${String(i + 1).padStart(3)}. ${(m.email || 'N/A').padEnd(50)} ${(m.first_name || '').padEnd(15)} ${(m.last_name || '').padEnd(15)} Org: ${orgName}`);
      });
    console.log();
  }

  if (notFound.length > 0) {
    console.log('EMAILS NOT FOUND (already deleted or not in database):');
    console.log('-'.repeat(70));
    notFound.forEach((email, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. ${email}`);
    });
    console.log();
  }

  if (matchedMembers.length > 0) {
    const memberIds = matchedMembers.map(m => m.id);
    console.log('DEPENDENT RECORDS (will be cleaned up before deletion):');
    console.log('-'.repeat(70));
    const depCounts = await countDependentRecords(memberIds);
    for (const [table, info] of Object.entries(depCounts)) {
      if (info.error) {
        console.log(`  ${table.padEnd(35)} skipped (${info.error})`);
      } else if (info.count > 0) {
        console.log(`  ${table.padEnd(35)} ${info.count} records`);
      }
    }
    const totalDep = Object.values(depCounts).reduce((sum, i) => sum + (i.count || 0), 0);
    if (totalDep === 0) console.log('  (none found)');
    console.log();
  }

  if (!EXECUTE_MODE) {
    console.log('='.repeat(70));
    console.log('  DRY RUN COMPLETE — No changes were made.');
    console.log('  Review the list above carefully.');
    console.log('  Verify all organisations listed belong to tenant GFI.');
    console.log('  To perform the deletion, run with: --execute --confirm-orgs');
    console.log('='.repeat(70));
    return;
  }

  if (!CONFIRM_ORGS) {
    console.log('='.repeat(70));
    console.log('  SAFETY CHECK: You must also pass --confirm-orgs to confirm');
    console.log('  that all organisations listed above belong to the GFI tenant.');
    console.log('  Run with: --execute --confirm-orgs');
    console.log('='.repeat(70));
    return;
  }

  if (matchedMembers.length === 0) {
    console.log('No members to delete. Exiting.');
    return;
  }

  console.log('='.repeat(70));
  console.log(`  EXECUTING DELETION OF ${matchedMembers.length} MEMBERS...`);
  console.log('='.repeat(70));

  const { deletedCount, failedCount, failures } = await deleteMembers(matchedMembers);

  console.log();
  console.log('='.repeat(70));
  console.log('  DELETION COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Successfully deleted: ${deletedCount}`);
  console.log(`  Failed:               ${failedCount}`);

  if (failures.length > 0) {
    console.log();
    console.log('FAILED DELETIONS:');
    failures.forEach(f => {
      console.log(`  ${f.email} — ${f.error}`);
    });
  }

  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
