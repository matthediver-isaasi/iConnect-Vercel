import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function seed() {
  const { data: campaign, error: campErr } = await supabase
    .from('fundraising_campaign')
    .select('*')
    .ilike('name', '%test%')
    .single();

  if (campErr || !campaign) {
    console.error('Could not find test campaign:', campErr?.message);
    process.exit(1);
  }
  const tenantId = campaign.tenant_id;
  console.log(`Found campaign: "${campaign.name}" (tenant: ${tenantId}, goal: ${campaign.currency} ${campaign.goal_amount})`);

  const { data: existingMembers } = await supabase
    .from('fundraising_team_member')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('tenant_id', tenantId);

  console.log(`Existing team members: ${(existingMembers || []).length}`);
  const matMember = (existingMembers || []).find(m =>
    m.email === 'mat.the.diver@googlemail.com'
  );

  if (matMember) {
    console.log(`  - ${matMember.first_name} ${matMember.last_name} (${matMember.email})`);
  }

  const externalMembers = [
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      first_name: 'Sarah',
      last_name: 'Thompson',
      email: 'sarah.thompson.test@example.com',
      token: crypto.randomBytes(24).toString('hex'),
      individual_goal: 500,
      is_active: true
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      first_name: 'James',
      last_name: 'Blackwell',
      email: 'james.blackwell.test@example.com',
      token: crypto.randomBytes(24).toString('hex'),
      individual_goal: 750,
      is_active: true
    }
  ];

  const { data: newMembers, error: memberErr } = await supabase
    .from('fundraising_team_member')
    .insert(externalMembers)
    .select();

  if (memberErr) {
    console.error('Failed to create team members:', memberErr.message);
    process.exit(1);
  }

  console.log(`\nCreated ${newMembers.length} external team members:`);
  newMembers.forEach(m => {
    console.log(`  - ${m.first_name} ${m.last_name} (${m.email})`);
    console.log(`    Donation page token: ${m.token}`);
  });

  const allMembers = [
    ...(matMember ? [matMember] : []),
    ...newMembers
  ];

  if (allMembers.length < 3) {
    console.warn(`Warning: Only ${allMembers.length} team members available, some donations may be skipped`);
  }

  const donations = [
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: allMembers[0]?.id,
      donor_name: 'David Williams',
      donor_email: 'david.w.test@example.com',
      donor_message: 'Great cause, happy to support!',
      is_anonymous: false,
      amount: 50.00,
      currency: campaign.currency || 'GBP',
      gift_aid: true,
      gift_aid_address_line_1: '14 Oak Lane',
      gift_aid_city: 'Manchester',
      gift_aid_postcode: 'M1 4BT',
      stripe_payment_intent_id: 'pi_test_seed_001',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: allMembers[0]?.id,
      donor_name: 'Anonymous Donor',
      donor_email: 'anon.test@example.com',
      is_anonymous: true,
      amount: 25.00,
      currency: campaign.currency || 'GBP',
      gift_aid: false,
      stripe_payment_intent_id: 'pi_test_seed_002',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: newMembers[0]?.id,
      donor_name: 'Emma Richardson',
      donor_email: 'emma.r.test@example.com',
      donor_message: 'Go Sarah! Smashing it!',
      is_anonymous: false,
      amount: 100.00,
      currency: campaign.currency || 'GBP',
      gift_aid: true,
      gift_aid_address_line_1: '7 Willow Close',
      gift_aid_address_line_2: 'Flat 3',
      gift_aid_city: 'Birmingham',
      gift_aid_postcode: 'B2 5HG',
      stripe_payment_intent_id: 'pi_test_seed_003',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: newMembers[0]?.id,
      donor_name: 'Tom Baker',
      donor_email: 'tom.baker.test@example.com',
      is_anonymous: false,
      amount: 30.00,
      currency: campaign.currency || 'GBP',
      gift_aid: false,
      stripe_payment_intent_id: 'pi_test_seed_004',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: newMembers[1]?.id,
      donor_name: 'Rebecca Moore',
      donor_email: 'rebecca.m.test@example.com',
      donor_message: 'Keep up the amazing work James!',
      is_anonymous: false,
      amount: 75.00,
      currency: campaign.currency || 'GBP',
      gift_aid: true,
      gift_aid_address_line_1: '22 Elm Street',
      gift_aid_city: 'London',
      gift_aid_postcode: 'SW1A 1AA',
      stripe_payment_intent_id: 'pi_test_seed_005',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: newMembers[1]?.id,
      donor_name: 'Michael Chen',
      donor_email: 'michael.c.test@example.com',
      donor_message: 'Wonderful initiative',
      is_anonymous: false,
      amount: 150.00,
      currency: campaign.currency || 'GBP',
      gift_aid: false,
      stripe_payment_intent_id: 'pi_test_seed_006',
      payment_status: 'succeeded'
    },
    {
      tenant_id: tenantId,
      campaign_id: campaign.id,
      team_member_id: newMembers[1]?.id,
      donor_name: 'Pending Donor',
      donor_email: 'pending.test@example.com',
      is_anonymous: false,
      amount: 20.00,
      currency: campaign.currency || 'GBP',
      gift_aid: false,
      stripe_payment_intent_id: 'pi_test_seed_007',
      payment_status: 'pending'
    }
  ].filter(d => d.team_member_id);

  const { data: createdDonations, error: donErr } = await supabase
    .from('fundraising_donation')
    .insert(donations)
    .select();

  if (donErr) {
    console.error('Failed to create donations:', donErr.message);
    process.exit(1);
  }

  console.log(`\nCreated ${createdDonations.length} test donations:`);
  createdDonations.forEach(d => {
    const member = allMembers.find(m => m.id === d.team_member_id);
    const memberName = member ? `${member.first_name} ${member.last_name}` : 'Unknown';
    const giftAid = d.gift_aid ? ' [Gift Aid]' : '';
    console.log(`  - ${d.donor_name}: ${d.currency} ${d.amount} -> ${memberName} (${d.payment_status})${giftAid}`);
  });

  const succeeded = createdDonations.filter(d => d.payment_status === 'succeeded');
  const total = succeeded.reduce((sum, d) => sum + parseFloat(d.amount), 0);
  const giftAidTotal = succeeded.filter(d => d.gift_aid).reduce((sum, d) => sum + parseFloat(d.amount) * 0.25, 0);

  console.log(`\nSummary:`);
  console.log(`  Total raised: ${campaign.currency || 'GBP'} ${total.toFixed(2)}`);
  console.log(`  Gift Aid bonus: ${campaign.currency || 'GBP'} ${giftAidTotal.toFixed(2)}`);
  console.log(`  Succeeded: ${succeeded.length}, Pending: ${createdDonations.length - succeeded.length}`);
  console.log('\nDone!');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
