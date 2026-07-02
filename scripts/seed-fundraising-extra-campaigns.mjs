import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function seed() {
  console.log('Looking up existing test campaign to find tenant...\n');

  const { data: existingCampaigns } = await supabase
    .from('fundraising_campaign')
    .select('tenant_id')
    .limit(1);

  if (!existingCampaigns?.length) {
    console.error('No existing campaigns found. Run the first seed script first.');
    process.exit(1);
  }

  const tenantId = existingCampaigns[0].tenant_id;
  console.log(`Using tenant: ${tenantId}\n`);

  const campaigns = [
    {
      tenant_id: tenantId,
      name: 'Annual Charity Gala 2026',
      slug: 'annual-charity-gala-2026',
      description: 'Join us for our flagship fundraising event! A spectacular evening of dining, entertainment, and giving back to the community. All proceeds support local education initiatives.',
      goal_amount: 10000,
      currency: 'GBP',
      start_date: '2026-01-15T00:00:00Z',
      end_date: '2026-06-30T00:00:00Z',
      status: 'active',
      allow_anonymous_donations: true
    },
    {
      tenant_id: tenantId,
      name: 'Community Sports Day',
      slug: 'community-sports-day',
      description: 'Raising funds for new sports equipment and facilities for our community centre. Help us create opportunities for young people through sport.',
      goal_amount: 3000,
      currency: 'GBP',
      start_date: '2026-02-01T00:00:00Z',
      end_date: '2026-04-15T00:00:00Z',
      status: 'active',
      allow_anonymous_donations: true
    },
    {
      tenant_id: tenantId,
      name: 'Winter Warmth Appeal 2025',
      slug: 'winter-warmth-appeal-2025',
      description: 'Our annual winter appeal to provide warm clothing and shelter for those in need. Last year we helped over 200 families.',
      goal_amount: 5000,
      currency: 'GBP',
      start_date: '2025-10-01T00:00:00Z',
      end_date: '2025-12-31T00:00:00Z',
      status: 'completed',
      allow_anonymous_donations: true
    }
  ];

  const { data: createdCampaigns, error: campErr } = await supabase
    .from('fundraising_campaign')
    .insert(campaigns)
    .select();

  if (campErr) {
    console.error('Failed to create campaigns:', campErr.message);
    process.exit(1);
  }

  console.log(`Created ${createdCampaigns.length} campaigns:`);
  createdCampaigns.forEach(c => console.log(`  - "${c.name}" (${c.status})`));

  const [gala, sports, winter] = createdCampaigns;

  const teamMembers = [
    { tenant_id: tenantId, campaign_id: gala.id, first_name: 'Eleanor', last_name: 'Wright', email: 'eleanor.wright.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 2500, is_active: true },
    { tenant_id: tenantId, campaign_id: gala.id, first_name: 'Marcus', last_name: 'Campbell', email: 'marcus.campbell.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 2000, is_active: true },
    { tenant_id: tenantId, campaign_id: gala.id, first_name: 'Priya', last_name: 'Sharma', email: 'priya.sharma.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 3000, is_active: true },
    { tenant_id: tenantId, campaign_id: gala.id, first_name: 'Oliver', last_name: 'Davies', email: 'oliver.davies.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 2500, is_active: true },
    { tenant_id: tenantId, campaign_id: sports.id, first_name: 'Jasmine', last_name: 'Taylor', email: 'jasmine.taylor.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 1000, is_active: true },
    { tenant_id: tenantId, campaign_id: sports.id, first_name: 'Ryan', last_name: 'O\'Brien', email: 'ryan.obrien.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 1000, is_active: true },
    { tenant_id: tenantId, campaign_id: sports.id, first_name: 'Amira', last_name: 'Hassan', email: 'amira.hassan.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 1000, is_active: true },
    { tenant_id: tenantId, campaign_id: winter.id, first_name: 'Catherine', last_name: 'Mitchell', email: 'catherine.mitchell.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 1500, is_active: true },
    { tenant_id: tenantId, campaign_id: winter.id, first_name: 'Daniel', last_name: 'Foster', email: 'daniel.foster.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 1500, is_active: true },
    { tenant_id: tenantId, campaign_id: winter.id, first_name: 'Sophie', last_name: 'Clarke', email: 'sophie.clarke.test@example.com', token: crypto.randomBytes(24).toString('hex'), individual_goal: 2000, is_active: true },
  ];

  const { data: createdMembers, error: memErr } = await supabase
    .from('fundraising_team_member')
    .insert(teamMembers)
    .select();

  if (memErr) {
    console.error('Failed to create team members:', memErr.message);
    process.exit(1);
  }

  console.log(`\nCreated ${createdMembers.length} team members across campaigns`);

  const galaMembers = createdMembers.filter(m => m.campaign_id === gala.id);
  const sportsMembers = createdMembers.filter(m => m.campaign_id === sports.id);
  const winterMembers = createdMembers.filter(m => m.campaign_id === winter.id);

  const galaDonations = [
    { team_member_id: galaMembers[0].id, donor_name: 'Sir Reginald Fortescue', donor_email: 'reginald.test@example.com', donor_message: 'Delighted to support such a wonderful cause', amount: 500, gift_aid: true, gift_aid_address_line_1: '1 Park Lane', gift_aid_city: 'London', gift_aid_postcode: 'W1K 1AA', payment_status: 'succeeded' },
    { team_member_id: galaMembers[0].id, donor_name: 'Victoria Ashworth', donor_email: 'victoria.test@example.com', donor_message: 'Wishing you all the best with the gala', amount: 250, gift_aid: true, gift_aid_address_line_1: '45 Queen Street', gift_aid_city: 'Edinburgh', gift_aid_postcode: 'EH2 3NH', payment_status: 'succeeded' },
    { team_member_id: galaMembers[0].id, donor_name: 'George & Mary Patterson', donor_email: 'patterson.test@example.com', amount: 100, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[1].id, donor_name: 'Harpreet Singh', donor_email: 'harpreet.test@example.com', donor_message: 'Education changes lives!', amount: 200, gift_aid: true, gift_aid_address_line_1: '88 High Road', gift_aid_city: 'Leicester', gift_aid_postcode: 'LE1 5YP', payment_status: 'succeeded' },
    { team_member_id: galaMembers[1].id, donor_name: 'Anonymous Supporter', donor_email: 'anon1.test@example.com', is_anonymous: true, amount: 150, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[1].id, donor_name: 'Claire Beaumont', donor_email: 'claire.b.test@example.com', donor_message: 'Marcus recommended I donate - glad I did!', amount: 75, gift_aid: true, gift_aid_address_line_1: '12 Mill Road', gift_aid_city: 'Cambridge', gift_aid_postcode: 'CB1 2AD', payment_status: 'succeeded' },
    { team_member_id: galaMembers[2].id, donor_name: 'Raj Patel', donor_email: 'raj.patel.test@example.com', donor_message: 'In memory of my father who valued education above all', amount: 1000, gift_aid: true, gift_aid_address_line_1: '33 Temple Way', gift_aid_city: 'Bristol', gift_aid_postcode: 'BS1 6DZ', payment_status: 'succeeded' },
    { team_member_id: galaMembers[2].id, donor_name: 'Helen Mackenzie', donor_email: 'helen.m.test@example.com', amount: 300, gift_aid: true, gift_aid_address_line_1: '6 Castle Terrace', gift_aid_city: 'Inverness', gift_aid_postcode: 'IV2 3AA', payment_status: 'succeeded' },
    { team_member_id: galaMembers[2].id, donor_name: 'Thomas & Anne Green', donor_email: 'greens.test@example.com', donor_message: 'Happy to help the next generation', amount: 200, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[2].id, donor_name: 'Yuki Tanaka', donor_email: 'yuki.test@example.com', amount: 50, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[3].id, donor_name: 'Robert Blackstone', donor_email: 'robert.b.test@example.com', donor_message: 'Oliver, you are doing amazing work', amount: 400, gift_aid: true, gift_aid_address_line_1: '2 The Crescent', gift_aid_city: 'Bath', gift_aid_postcode: 'BA1 2NA', payment_status: 'succeeded' },
    { team_member_id: galaMembers[3].id, donor_name: 'Fiona Stewart', donor_email: 'fiona.s.test@example.com', amount: 120, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[3].id, donor_name: 'Anonymous Giver', donor_email: 'anon2.test@example.com', is_anonymous: true, amount: 75, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: galaMembers[3].id, donor_name: 'New Supporter', donor_email: 'new.test@example.com', amount: 50, gift_aid: false, payment_status: 'pending' },
  ];

  const sportsDonations = [
    { team_member_id: sportsMembers[0].id, donor_name: 'Mark Johnson', donor_email: 'mark.j.test@example.com', donor_message: 'For the kids!', amount: 100, gift_aid: true, gift_aid_address_line_1: '15 Sports Lane', gift_aid_city: 'Manchester', gift_aid_postcode: 'M2 3DP', payment_status: 'succeeded' },
    { team_member_id: sportsMembers[0].id, donor_name: 'Lisa Chen', donor_email: 'lisa.c.test@example.com', amount: 50, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: sportsMembers[0].id, donor_name: 'Pete Wilson', donor_email: 'pete.w.test@example.com', donor_message: 'Sport builds character', amount: 75, gift_aid: true, gift_aid_address_line_1: '8 Oval Way', gift_aid_city: 'London', gift_aid_postcode: 'SE11 5SS', payment_status: 'succeeded' },
    { team_member_id: sportsMembers[1].id, donor_name: 'Ciara Murphy', donor_email: 'ciara.m.test@example.com', amount: 200, gift_aid: true, gift_aid_address_line_1: '4 Grafton Street', gift_aid_city: 'Dublin', gift_aid_postcode: 'D02 Y024', payment_status: 'succeeded' },
    { team_member_id: sportsMembers[1].id, donor_name: 'Anonymous Fan', donor_email: 'anon3.test@example.com', is_anonymous: true, amount: 30, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: sportsMembers[2].id, donor_name: 'Karen White', donor_email: 'karen.w.test@example.com', donor_message: 'Amira inspired me to give', amount: 150, gift_aid: true, gift_aid_address_line_1: '21 Rose Avenue', gift_aid_city: 'Birmingham', gift_aid_postcode: 'B3 1SB', payment_status: 'succeeded' },
    { team_member_id: sportsMembers[2].id, donor_name: 'Steve Brown', donor_email: 'steve.b.test@example.com', amount: 25, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: sportsMembers[2].id, donor_name: 'Upcoming Donor', donor_email: 'upcoming.test@example.com', amount: 40, gift_aid: false, payment_status: 'pending' },
  ];

  const winterDonations = [
    { team_member_id: winterMembers[0].id, donor_name: 'William Hartley', donor_email: 'william.h.test@example.com', donor_message: 'Nobody should be cold this winter', amount: 300, gift_aid: true, gift_aid_address_line_1: '10 Frost Lane', gift_aid_city: 'York', gift_aid_postcode: 'YO1 7HH', payment_status: 'succeeded' },
    { team_member_id: winterMembers[0].id, donor_name: 'Nina Kowalski', donor_email: 'nina.k.test@example.com', amount: 100, gift_aid: true, gift_aid_address_line_1: '3 Snow Hill', gift_aid_city: 'Birmingham', gift_aid_postcode: 'B4 6WH', payment_status: 'succeeded' },
    { team_member_id: winterMembers[0].id, donor_name: 'The Reynolds Family', donor_email: 'reynolds.test@example.com', donor_message: 'Warmth for all', amount: 150, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: winterMembers[0].id, donor_name: 'Anonymous Angel', donor_email: 'anon4.test@example.com', is_anonymous: true, amount: 500, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: winterMembers[1].id, donor_name: 'Grace Liu', donor_email: 'grace.l.test@example.com', donor_message: 'Thank you Daniel for bringing this to my attention', amount: 250, gift_aid: true, gift_aid_address_line_1: '55 Amber Close', gift_aid_city: 'Liverpool', gift_aid_postcode: 'L1 8JQ', payment_status: 'succeeded' },
    { team_member_id: winterMembers[1].id, donor_name: 'Paul Matthews', donor_email: 'paul.m.test@example.com', amount: 75, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: winterMembers[1].id, donor_name: 'Emma & Jack Taylor', donor_email: 'taylors.test@example.com', amount: 200, gift_aid: true, gift_aid_address_line_1: '77 Ivy Road', gift_aid_city: 'Oxford', gift_aid_postcode: 'OX1 2EP', payment_status: 'succeeded' },
    { team_member_id: winterMembers[2].id, donor_name: 'Dr. Sarah Okonkwo', donor_email: 'sarah.o.test@example.com', donor_message: 'In support of Sophie and this vital appeal', amount: 750, gift_aid: true, gift_aid_address_line_1: '18 Regent Street', gift_aid_city: 'London', gift_aid_postcode: 'W1B 5SF', payment_status: 'succeeded' },
    { team_member_id: winterMembers[2].id, donor_name: 'Ian & Margaret Douglas', donor_email: 'douglas.test@example.com', amount: 400, gift_aid: true, gift_aid_address_line_1: '9 Braemar Drive', gift_aid_city: 'Glasgow', gift_aid_postcode: 'G12 0UU', payment_status: 'succeeded' },
    { team_member_id: winterMembers[2].id, donor_name: 'Company Match Fund', donor_email: 'matchfund.test@example.com', donor_message: 'Corporate matching from Davidson & Co.', amount: 500, gift_aid: false, payment_status: 'succeeded' },
    { team_member_id: winterMembers[2].id, donor_name: 'Lucy Brennan', donor_email: 'lucy.b.test@example.com', amount: 60, gift_aid: false, payment_status: 'succeeded' },
  ];

  const allDonations = [
    ...galaDonations.map(d => ({ ...d, tenant_id: tenantId, campaign_id: gala.id, currency: 'GBP', stripe_payment_intent_id: `pi_test_gala_${crypto.randomBytes(6).toString('hex')}` })),
    ...sportsDonations.map(d => ({ ...d, tenant_id: tenantId, campaign_id: sports.id, currency: 'GBP', stripe_payment_intent_id: `pi_test_sports_${crypto.randomBytes(6).toString('hex')}` })),
    ...winterDonations.map(d => ({ ...d, tenant_id: tenantId, campaign_id: winter.id, currency: 'GBP', stripe_payment_intent_id: `pi_test_winter_${crypto.randomBytes(6).toString('hex')}` })),
  ];

  const { data: createdDonations, error: donErr } = await supabase
    .from('fundraising_donation')
    .insert(allDonations)
    .select();

  if (donErr) {
    console.error('Failed to create donations:', donErr.message);
    process.exit(1);
  }

  console.log(`Created ${createdDonations.length} donations across all campaigns\n`);

  const campaignSummaries = [
    { name: gala.name, donations: galaDonations },
    { name: sports.name, donations: sportsDonations },
    { name: winter.name, donations: winterDonations },
  ];

  campaignSummaries.forEach(({ name, donations }) => {
    const succeeded = donations.filter(d => d.payment_status === 'succeeded');
    const total = succeeded.reduce((sum, d) => sum + d.amount, 0);
    const giftAid = succeeded.filter(d => d.gift_aid).reduce((sum, d) => sum + d.amount * 0.25, 0);
    console.log(`${name}:`);
    console.log(`  Donations: ${donations.length} (${succeeded.length} succeeded)`);
    console.log(`  Total: GBP ${total.toFixed(2)}`);
    console.log(`  Gift Aid bonus: GBP ${giftAid.toFixed(2)}`);
    console.log('');
  });

  console.log('Done!');
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
