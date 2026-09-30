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
const CATEGORY_ID = '6f6d6abd-6d90-4593-845b-e8b48682818f';
const DRY_RUN = process.argv.includes('--dry-run');

async function fetchAllMembers() {
  const allMembers = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('member')
      .select('id, email')
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
  console.log(DRY_RUN ? '=== DRY RUN MODE ===' : '=== LIVE MODE ===');
  console.log('Category:', CATEGORY_ID);
  console.log('Tenant:', TENANT_ID);
  console.log('');

  const wb = XLSX.readFile('attached_assets/MailChimp_opted_out_12.03.26_-_opt_on_from_GFI_newsletter_iCo_1773315049909.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);
  const emails = rows.map(r => (r.Email || '').trim().toLowerCase()).filter(Boolean);
  console.log('Emails in spreadsheet:', emails.length);

  const allMembers = await fetchAllMembers();
  console.log('Total members in tenant:', allMembers.length);

  const memberByEmail = {};
  for (const m of allMembers) {
    if (m.email) memberByEmail[m.email.toLowerCase().trim()] = m;
  }

  const matched = [];
  const notFound = [];

  for (const email of emails) {
    const member = memberByEmail[email];
    if (member) {
      matched.push({ email, memberId: member.id });
    } else {
      notFound.push(email);
    }
  }

  console.log('Matched to members:', matched.length);
  console.log('Not found as members:', notFound.length);
  if (notFound.length > 0) {
    notFound.forEach(e => console.log('  NOT FOUND:', e));
  }
  console.log('');

  if (matched.length === 0) {
    console.log('No members to opt out.');
    return;
  }

  const memberIds = matched.map(m => m.memberId);

  const { data: existingPrefs, error: prefError } = await supabase
    .from('member_communication_preference')
    .select('id, member_id, is_subscribed')
    .eq('category_id', CATEGORY_ID)
    .in('member_id', memberIds);

  if (prefError) {
    console.error('Error fetching existing preferences:', prefError);
    process.exit(1);
  }

  const existingByMemberId = {};
  for (const p of (existingPrefs || [])) {
    existingByMemberId[p.member_id] = p;
  }

  const toUpdate = [];
  const toInsert = [];
  const alreadyOptedOut = [];

  for (const { email, memberId } of matched) {
    const existing = existingByMemberId[memberId];
    if (existing) {
      if (existing.is_subscribed === false) {
        alreadyOptedOut.push({ email, memberId });
      } else {
        toUpdate.push({ email, memberId, prefId: existing.id });
      }
    } else {
      toInsert.push({ email, memberId });
    }
  }

  console.log('Already opted out:', alreadyOptedOut.length);
  console.log('Need to update (subscribed -> opted out):', toUpdate.length);
  console.log('Need to insert (no preference yet):', toInsert.length);
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN complete. No changes made.');
    if (toUpdate.length > 0) {
      console.log('Would UPDATE:');
      toUpdate.forEach(m => console.log('  ' + m.email));
    }
    if (toInsert.length > 0) {
      console.log('Would INSERT:');
      toInsert.forEach(m => console.log('  ' + m.email));
    }
    return;
  }

  let updatedCount = 0;
  for (const { email, memberId, prefId } of toUpdate) {
    const { error } = await supabase
      .from('member_communication_preference')
      .update({ is_subscribed: false, updated_at: new Date().toISOString() })
      .eq('id', prefId);
    if (error) {
      console.error('Error updating preference for ' + email + ':', error);
    } else {
      updatedCount++;
      console.log('  UPDATED: ' + email);
    }
  }

  let insertedCount = 0;
  for (const { email, memberId } of toInsert) {
    const { error } = await supabase
      .from('member_communication_preference')
      .insert({
        member_id: memberId,
        category_id: CATEGORY_ID,
        is_subscribed: false,
        tenant_id: TENANT_ID,
        updated_at: new Date().toISOString()
      });
    if (error) {
      console.error('Error inserting preference for ' + email + ':', error);
    } else {
      insertedCount++;
      console.log('  INSERTED: ' + email);
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log('Updated:', updatedCount);
  console.log('Inserted:', insertedCount);
  console.log('Already opted out:', alreadyOptedOut.length);
  console.log('Not found:', notFound.length);
  console.log('Total processed:', updatedCount + insertedCount + alreadyOptedOut.length + notFound.length);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
