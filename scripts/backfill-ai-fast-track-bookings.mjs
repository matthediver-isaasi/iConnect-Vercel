import { createClient } from '@supabase/supabase-js';

const supabase = createClient('https://lvmzliemqnieeoruhkik.supabase.co', process.env.DEST_SUPABASE_KEY);

const bookingsToUpdate = [
  {
    email: 'rcawston001@dundee.ac.uk',
    expectedName: 'Ruth Cawston'
  },
  {
    email: 'a.nichols@londonmet.ac.uk',
    expectedName: 'Alison Nichols'
  },
  {
    email: 'i.hosking@lancaster.ac.uk',
    expectedName: 'Isla Hosking'
  },
  {
    email: 'lsharland@aup.ac.uk',
    expectedName: 'Louise Sharland'
  },
  {
    email: 'e.poole@hud.ac.uk',
    expectedName: 'Edd Poole'
  }
];

const AI_FAST_TRACK_EVENT_ID = 'f563a1d6-1a1b-4c1a-afe0-3ce5d3f3e9ed';

async function backfillBookings() {
  console.log('Starting backfill for AI Fast Track bookings...\n');
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const booking of bookingsToUpdate) {
    console.log(`Processing: ${booking.email}`);
    
    // Find the member by email
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, organization_id, first_name, last_name')
      .eq('email', booking.email)
      .single();
    
    if (memberError || !member) {
      console.log(`  ERROR: Member not found for ${booking.email}`);
      errorCount++;
      continue;
    }
    
    if (!member.organization_id) {
      console.log(`  ERROR: Member ${booking.email} has no organization_id`);
      errorCount++;
      continue;
    }
    
    // Find the booking by email and event_id
    const { data: existingBooking, error: bookingError } = await supabase
      .from('booking')
      .select('id, member_id, organization_id')
      .eq('event_id', AI_FAST_TRACK_EVENT_ID)
      .eq('attendee_email', booking.email)
      .single();
    
    if (bookingError || !existingBooking) {
      console.log(`  ERROR: Booking not found for ${booking.email}`);
      errorCount++;
      continue;
    }
    
    // Update the booking with member_id and organization_id
    const { error: updateError } = await supabase
      .from('booking')
      .update({
        member_id: member.id,
        organization_id: member.organization_id
      })
      .eq('id', existingBooking.id);
    
    if (updateError) {
      console.log(`  ERROR: Failed to update booking: ${updateError.message}`);
      errorCount++;
      continue;
    }
    
    // Get organization name for logging
    const { data: org } = await supabase
      .from('organization')
      .select('name')
      .eq('id', member.organization_id)
      .single();
    
    console.log(`  SUCCESS: Updated booking ${existingBooking.id}`);
    console.log(`    -> member_id: ${member.id} (${member.first_name} ${member.last_name})`);
    console.log(`    -> organization_id: ${member.organization_id} (${org?.name})`);
    successCount++;
  }
  
  console.log('\n--- Summary ---');
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total processed: ${bookingsToUpdate.length}`);
  
  // Verify the update
  console.log('\n--- Verification ---');
  const { data: updatedBookings } = await supabase
    .from('booking')
    .select('attendee_email, member_id, organization_id')
    .eq('event_id', AI_FAST_TRACK_EVENT_ID);
  
  console.log('AI Fast Track bookings after update:');
  for (const b of updatedBookings || []) {
    const hasOrg = b.organization_id ? 'YES' : 'NO';
    const hasMember = b.member_id ? 'YES' : 'NO';
    console.log(`  ${b.attendee_email}: org=${hasOrg}, member=${hasMember}`);
  }
}

backfillBookings().catch(console.error);
