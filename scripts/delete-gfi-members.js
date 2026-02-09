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

async function deleteMembers(members) {
  const BATCH_SIZE = 20;
  let deletedCount = 0;
  let failedCount = 0;
  const failures = [];

  for (let i = 0; i < members.length; i += BATCH_SIZE) {
    const batch = members.slice(i, i + BATCH_SIZE);
    const ids = batch.map(m => m.id);

    const { error } = await supabase
      .from('member')
      .delete()
      .in('id', ids);

    if (error) {
      console.error(`Error deleting batch starting at index ${i}:`, error.message);
      failedCount += batch.length;
      failures.push(...batch.map(m => ({ ...m, error: error.message })));
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
    console.log('EMAILS NOT FOUND:');
    console.log('-'.repeat(70));
    notFound.forEach((email, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. ${email}`);
    });
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
