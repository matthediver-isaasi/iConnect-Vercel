/**
 * Backfill Booking Member and Organization IDs
 * 
 * This script updates bookings that have NULL member_id and/or organization_id
 * by matching the attendee_email to existing member records.
 * 
 * Features:
 * - Dry-run mode (default) - shows what would be updated without making changes
 * - Tenant validation - ensures member belongs to the same tenant as the booking/event
 * - Duplicate handling - skips if multiple members found with same email
 * - NULL checks - only updates if booking is missing member_id or organization_id
 * - Also ensures tenant_id is set on all bookings (for guest booking support)
 * 
 * Usage:
 *   node scripts/backfill-booking-member-org.mjs                    # Dry run
 *   node scripts/backfill-booking-member-org.mjs --dry-run          # Dry run (explicit)
 *   node scripts/backfill-booking-member-org.mjs --apply            # Apply changes
 *   node scripts/backfill-booking-member-org.mjs --apply --event-id=<uuid>  # Single event
 *   node scripts/backfill-booking-member-org.mjs --tenant-id=<uuid> # Specific tenant
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient('https://lvmzliemqnieeoruhkik.supabase.co', process.env.DEST_SUPABASE_KEY);

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const SPECIFIC_EVENT_ID = args.find(a => a.startsWith('--event-id='))?.split('=')[1];
const SPECIFIC_TENANT_ID = args.find(a => a.startsWith('--tenant-id='))?.split('=')[1];

async function main() {
  console.log('='.repeat(60));
  console.log('Booking Member/Organization Backfill Script');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'APPLY (changes will be made)'}`);
  if (SPECIFIC_EVENT_ID) console.log(`Event filter: ${SPECIFIC_EVENT_ID}`);
  if (SPECIFIC_TENANT_ID) console.log(`Tenant filter: ${SPECIFIC_TENANT_ID}`);
  console.log('');

  // Step 1: Find bookings that need backfilling
  let query = supabase
    .from('booking')
    .select('id, event_id, attendee_email, member_id, organization_id, tenant_id');
  
  // Apply filters
  if (SPECIFIC_EVENT_ID) {
    query = query.eq('event_id', SPECIFIC_EVENT_ID);
  }
  if (SPECIFIC_TENANT_ID) {
    query = query.eq('tenant_id', SPECIFIC_TENANT_ID);
  }
  
  // We want bookings that either:
  // 1. Have NULL member_id (might be matchable to a member)
  // 2. Have NULL tenant_id (needs tenant_id for new query logic)
  query = query.or('member_id.is.null,tenant_id.is.null');

  const { data: bookings, error: bookingsError } = await query;

  if (bookingsError) {
    console.error('Error fetching bookings:', bookingsError);
    process.exit(1);
  }

  console.log(`Found ${bookings?.length || 0} bookings that may need updates\n`);

  if (!bookings || bookings.length === 0) {
    console.log('No bookings to process.');
    return;
  }

  // Step 2: Get unique event IDs to fetch tenant info
  const eventIds = [...new Set(bookings.map(b => b.event_id))];
  const { data: events, error: eventsError } = await supabase
    .from('event')
    .select('id, tenant_id, title')
    .in('id', eventIds);

  if (eventsError) {
    console.error('Error fetching events:', eventsError);
    process.exit(1);
  }

  const eventMap = (events || []).reduce((acc, e) => {
    acc[e.id] = e;
    return acc;
  }, {});

  // Step 3: Get unique attendee emails to batch fetch members
  const emails = [...new Set(bookings.map(b => b.attendee_email?.toLowerCase()).filter(Boolean))];
  
  console.log(`Looking up ${emails.length} unique email addresses...\n`);

  // Fetch all matching members in one query
  const { data: members, error: membersError } = await supabase
    .from('member')
    .select('id, email, organization_id, tenant_id')
    .in('email', emails);

  if (membersError) {
    console.error('Error fetching members:', membersError);
    process.exit(1);
  }

  // Build email -> member map, grouped by tenant
  // Format: { email: { tenantId: { member, count } } }
  // Track count to detect duplicates
  const membersByEmail = {};
  for (const member of members || []) {
    const email = member.email?.toLowerCase();
    if (!email) continue;
    if (!membersByEmail[email]) {
      membersByEmail[email] = {};
    }
    // Store member by tenant_id, track duplicates
    if (member.tenant_id) {
      if (!membersByEmail[email][member.tenant_id]) {
        membersByEmail[email][member.tenant_id] = { member, count: 1 };
      } else {
        membersByEmail[email][member.tenant_id].count++;
        // Keep the first member found, but mark as duplicate
      }
    }
  }
  
  // Report duplicates
  let duplicateCount = 0;
  for (const email of Object.keys(membersByEmail)) {
    for (const tenantId of Object.keys(membersByEmail[email])) {
      if (membersByEmail[email][tenantId].count > 1) {
        console.log(`  [WARNING] Duplicate members found: ${email} in tenant ${tenantId.slice(0, 8)}... (${membersByEmail[email][tenantId].count} records)`);
        duplicateCount++;
      }
    }
  }
  if (duplicateCount > 0) {
    console.log(`  Found ${duplicateCount} email/tenant combinations with duplicates - these will be skipped\n`);
  }

  // Step 4: Process each booking
  const stats = {
    memberUpdated: 0,
    tenantIdSet: 0,
    skippedNoMember: 0,
    skippedDuplicateMember: 0,
    skippedAlreadySet: 0,
    skippedNoEmail: 0,
    skippedNoEvent: 0,
    skippedNoTenantId: 0,
    skippedOrgAlreadySet: 0,
    errors: 0
  };

  const updates = [];

  for (const booking of bookings) {
    const event = eventMap[booking.event_id];
    
    if (!event) {
      console.log(`  [SKIP] Booking ${booking.id}: Event not found`);
      stats.skippedNoEvent++;
      continue;
    }

    if (!booking.attendee_email) {
      console.log(`  [SKIP] Booking ${booking.id}: No attendee email`);
      stats.skippedNoEmail++;
      continue;
    }

    const email = booking.attendee_email.toLowerCase();
    const tenantId = event.tenant_id;
    
    // Safety check: skip if event has no tenant_id
    if (!tenantId) {
      console.log(`  [SKIP] Booking ${booking.id.slice(0, 8)}...: Event "${event.title}" has no tenant_id`);
      stats.skippedNoTenantId++;
      continue;
    }
    
    // Find member for this email in the same tenant (using new data structure)
    const memberData = membersByEmail[email]?.[tenantId];
    
    // Safety check: skip if duplicate members found for this email+tenant
    if (memberData && memberData.count > 1) {
      console.log(`  [SKIP] ${booking.attendee_email}: Duplicate members found (${memberData.count} records)`);
      stats.skippedDuplicateMember++;
      continue;
    }
    
    const member = memberData?.member;

    const updateData = {};
    let needsUpdate = false;

    // Check if tenant_id needs to be set
    if (!booking.tenant_id) {
      updateData.tenant_id = tenantId;
      needsUpdate = true;
      stats.tenantIdSet++;
    }

    // Check if member_id can be set (only if not already set)
    if (!booking.member_id && member) {
      // Safety check: don't overwrite organization_id if already set and different
      if (booking.organization_id && booking.organization_id !== member.organization_id) {
        console.log(`  [SKIP] ${booking.attendee_email}: organization_id already set to different value`);
        stats.skippedOrgAlreadySet++;
        // Still allow tenant_id update if needed
        if (!needsUpdate) continue;
      } else {
        updateData.member_id = member.id;
        // Only set organization_id if not already set
        if (!booking.organization_id) {
          updateData.organization_id = member.organization_id;
        }
        needsUpdate = true;
        stats.memberUpdated++;
      }
    } else if (!booking.member_id && !member) {
      // No member found - this is a true guest booking
      // Just ensure tenant_id is set (already handled above)
      stats.skippedNoMember++;
    }

    if (!needsUpdate) {
      stats.skippedAlreadySet++;
      continue;
    }

    updates.push({
      bookingId: booking.id,
      email: booking.attendee_email,
      eventTitle: event.title,
      updateData,
      member
    });

    // Log what we're doing
    const actions = [];
    if (updateData.tenant_id) actions.push('set tenant_id');
    if (updateData.member_id) actions.push(`link to member ${member.id.slice(0, 8)}...`);
    console.log(`  [${DRY_RUN ? 'WOULD UPDATE' : 'UPDATE'}] ${booking.attendee_email} (${event.title}): ${actions.join(', ')}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total bookings processed: ${bookings.length}`);
  console.log(`Member/org linked: ${stats.memberUpdated}`);
  console.log(`Tenant ID set: ${stats.tenantIdSet}`);
  console.log(`Skipped - no matching member (guest booking): ${stats.skippedNoMember}`);
  console.log(`Skipped - duplicate members: ${stats.skippedDuplicateMember}`);
  console.log(`Skipped - org already set differently: ${stats.skippedOrgAlreadySet}`);
  console.log(`Skipped - event has no tenant_id: ${stats.skippedNoTenantId}`);
  console.log(`Skipped - already set: ${stats.skippedAlreadySet}`);
  console.log(`Skipped - no email: ${stats.skippedNoEmail}`);
  console.log(`Skipped - no event found: ${stats.skippedNoEvent}`);
  console.log(`Updates to apply: ${updates.length}`);
  console.log('');

  if (DRY_RUN) {
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run with --apply to apply these changes.');
    return;
  }

  // Apply updates
  console.log('Applying updates...');
  let successCount = 0;
  let errorCount = 0;

  for (const update of updates) {
    const { error } = await supabase
      .from('booking')
      .update(update.updateData)
      .eq('id', update.bookingId);

    if (error) {
      console.error(`  ERROR updating ${update.bookingId}: ${error.message}`);
      errorCount++;
    } else {
      successCount++;
    }
  }

  console.log('');
  console.log(`Applied ${successCount} updates successfully.`);
  if (errorCount > 0) {
    console.log(`${errorCount} updates failed.`);
  }
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
