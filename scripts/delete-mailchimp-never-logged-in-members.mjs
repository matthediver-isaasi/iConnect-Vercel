import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const DRY_RUN = process.argv.includes('--dry-run');

async function fetchAllMembers() {
  const allMembers = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('member')
      .select('id, email, first_name, last_name, login_enabled, last_activity, identity_id, tenant_id')
      .eq('tenant_id', TENANT_ID)
      .range(offset, offset + pageSize - 1);
    if (error) { console.error('Error fetching members:', error); process.exit(1); }
    allMembers.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return allMembers;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN MODE ===' : '=== LIVE DELETION MODE ===');
  console.log('');

  const wb = XLSX.readFile('attached_assets/mailchimp_member_lookup_results.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[1]];
  const spreadsheetData = XLSX.utils.sheet_to_json(sheet);
  const toDeleteEmails = spreadsheetData
    .filter(r => r['Ever Logged In'] === 'NO')
    .map(r => r.Email.toLowerCase().trim());

  const toKeepEmails = spreadsheetData
    .filter(r => r['Ever Logged In'] === 'YES')
    .map(r => r.Email.toLowerCase().trim());

  console.log('Emails marked for deletion from spreadsheet:', toDeleteEmails.length);
  console.log('Emails to KEEP (logged in):', toKeepEmails.length);
  toKeepEmails.forEach(e => console.log('  KEEP:', e));
  console.log('');

  const allMembers = await fetchAllMembers();
  console.log('Total members in GFI tenant:', allMembers.length);

  const memberByEmail = {};
  for (const m of allMembers) {
    if (m.email) memberByEmail[m.email.toLowerCase().trim()] = m;
  }

  const membersToDelete = [];
  const skipped = [];

  for (const email of toDeleteEmails) {
    const member = memberByEmail[email];
    if (!member) {
      skipped.push({ email, reason: 'not found in DB' });
      continue;
    }

    if (member.tenant_id !== TENANT_ID) {
      skipped.push({ email, reason: 'wrong tenant: ' + member.tenant_id });
      continue;
    }

    if (member.last_activity) {
      skipped.push({ email, reason: 'has last_activity: ' + member.last_activity });
      continue;
    }

    if (member.identity_id) {
      skipped.push({ email, reason: 'has identity_id: ' + member.identity_id });
      continue;
    }

    if (toKeepEmails.includes(email)) {
      skipped.push({ email, reason: 'in keep list (logged in)' });
      continue;
    }

    membersToDelete.push(member);
  }

  console.log('Members passing all safety checks for deletion:', membersToDelete.length);
  console.log('Skipped:', skipped.length);
  if (skipped.length > 0) {
    skipped.forEach(s => console.log('  SKIPPED:', s.email, '-', s.reason));
  }
  console.log('');

  if (membersToDelete.length > 594 || membersToDelete.length === 0) {
    console.error('SAFETY CHECK FAILED: Expected at most 594 members to delete, got ' + membersToDelete.length);
    console.error('Aborting.');
    process.exit(1);
  }

  if (membersToDelete.length < 594) {
    console.log('NOTE: ' + (594 - membersToDelete.length) + ' members already deleted in prior runs.');
  }

  const memberIds = membersToDelete.map(m => m.id);

  if (DRY_RUN) {
    console.log('DRY RUN: Would delete ' + memberIds.length + ' members and their communication preferences');
    console.log('');
    console.log('=== MEMBERS THAT WOULD BE DELETED ===');
    membersToDelete.forEach(m => console.log(m.email + ' | ' + m.id + ' | ' + (m.first_name || '') + ' ' + (m.last_name || '')));
    return;
  }

  const dependentTables = [
    { name: 'member_communication_preference', col: 'member_id' },
    { name: 'member_group_assignment', col: 'member_id' },
    { name: 'offline_award_assignment', col: 'member_id' },
    { name: 'member_preference', col: 'member_id' },
    { name: 'member_field_value', col: 'member_id' },
    { name: 'due_diligence_submission', col: 'member_id' },
    { name: 'member_membership', col: 'member_id' },
    { name: 'member_document', col: 'member_id' },
    { name: 'donation', col: 'member_id' },
    { name: 'audience_list_member', col: 'member_id' },
    { name: 'member_page_element', col: 'member_id' },
    { name: 'booking_cancellation_request', col: 'member_id' },
    { name: 'booking_transfer_request', col: 'member_id' },
    { name: 'member_invitation', col: 'member_id' },
    { name: 'member_email', col: 'member_id' },
    { name: 'member_note', col: 'target_member_id' },
    { name: 'booking', col: 'member_id' },
    { name: 'team_member', col: 'member_id' },
    { name: 'forum_post', col: 'member_id' },
    { name: 'article_comment', col: 'member_id' },
  ];

  for (const table of dependentTables) {
    let totalDeleted = 0;
    let tableError = false;
    for (let i = 0; i < memberIds.length; i += 50) {
      const batch = memberIds.slice(i, i + 50);
      const { error, count } = await supabase
        .from(table.name)
        .delete({ count: 'exact' })
        .in(table.col, batch);
      if (error) {
        if (error.message && (error.message.includes('not find the table') || error.message.includes('not find the') || error.code === '42703' || error.code === 'PGRST204')) {
          console.log('  ' + table.name + ': table/column not found, skipping');
          tableError = true;
          break;
        }
        console.error('Error deleting ' + table.name + ' at batch ' + i + ':', JSON.stringify(error));
        process.exit(1);
      }
      totalDeleted += (count || 0);
    }
    if (!tableError) {
      console.log('  ' + table.name + ': deleted ' + totalDeleted + ' records');
    }
  }

  console.log('Step 2: Deleting member records in batches of 20...');
  let totalMembersDeleted = 0;
  const deletedAudit = [];
  for (let i = 0; i < memberIds.length; i += 20) {
    const batch = memberIds.slice(i, i + 20);
    const { data: deleted, error } = await supabase
      .from('member')
      .delete()
      .in('id', batch)
      .eq('tenant_id', TENANT_ID)
      .select('id, email, first_name, last_name');
    if (error) {
      console.error('Error deleting members at batch ' + i + ':', JSON.stringify(error));
      console.error('Deleted so far:', totalMembersDeleted);
      process.exit(1);
    }
    totalMembersDeleted += deleted.length;
    deleted.forEach(d => deletedAudit.push(d));
    if ((i % 100) === 0) console.log('  Progress: ' + totalMembersDeleted + ' / ' + memberIds.length);
  }

  console.log('  Deleted ' + totalMembersDeleted + ' member records');
  console.log('');

  if (totalMembersDeleted !== 594) {
    console.error('WARNING: Expected 594 deletions but got ' + totalMembersDeleted);
  } else {
    console.log('SUCCESS: All 594 members deleted as expected.');
  }

  console.log('');
  console.log('=== AUDIT LOG OF DELETED MEMBERS ===');
  deletedAudit.forEach(d => console.log(d.email + ' | ' + d.id + ' | ' + (d.first_name || '') + ' ' + (d.last_name || '')));

  const postCount = await supabase
    .from('member')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID);
  console.log('');
  console.log('Members remaining in GFI tenant:', postCount.count);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
