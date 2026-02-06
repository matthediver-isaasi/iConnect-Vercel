import pg from 'pg';
import crypto from 'crypto';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

async function seed() {
  await client.connect();
  console.log('Connected to database\n');

  const { rows: campaigns } = await client.query(
    `SELECT * FROM fundraising_campaign WHERE LOWER(name) LIKE '%test%' LIMIT 1`
  );

  if (!campaigns.length) {
    console.error('No test campaign found. Create one in the admin UI first.');
    process.exit(1);
  }

  const campaign = campaigns[0];
  const tenantId = campaign.tenant_id;
  const currency = campaign.currency || 'GBP';
  console.log(`Found campaign: "${campaign.name}" (tenant: ${tenantId}, goal: ${currency} ${campaign.goal_amount})`);

  const { rows: existingMembers } = await client.query(
    `SELECT * FROM fundraising_team_member WHERE campaign_id = $1 AND tenant_id = $2`,
    [campaign.id, tenantId]
  );

  console.log(`Existing team members: ${existingMembers.length}`);
  const matMember = existingMembers.find(m => m.email === 'mat.the.diver@googlemail.com');
  if (matMember) {
    console.log(`  - ${matMember.first_name} ${matMember.last_name} (${matMember.email})`);
  }

  const { rows: [sarah] } = await client.query(
    `INSERT INTO fundraising_team_member (tenant_id, campaign_id, first_name, last_name, email, token, individual_goal, is_active)
     VALUES ($1, $2, 'Sarah', 'Thompson', 'sarah.thompson.test@example.com', $3, 500, true)
     RETURNING *`,
    [tenantId, campaign.id, crypto.randomBytes(24).toString('hex')]
  );

  const { rows: [james] } = await client.query(
    `INSERT INTO fundraising_team_member (tenant_id, campaign_id, first_name, last_name, email, token, individual_goal, is_active)
     VALUES ($1, $2, 'James', 'Blackwell', 'james.blackwell.test@example.com', $3, 750, true)
     RETURNING *`,
    [tenantId, campaign.id, crypto.randomBytes(24).toString('hex')]
  );

  console.log(`\nCreated 2 external team members:`);
  [sarah, james].forEach(m => {
    console.log(`  - ${m.first_name} ${m.last_name} (${m.email})`);
    console.log(`    Donation page token: ${m.token}`);
  });

  const firstMemberId = matMember?.id || sarah.id;

  const donationRows = [
    { team_member_id: firstMemberId, donor_name: 'David Williams', donor_email: 'david.w.test@example.com', donor_message: 'Great cause, happy to support!', is_anonymous: false, amount: 50.00, gift_aid: true, gift_aid_address_line_1: '14 Oak Lane', gift_aid_address_line_2: null, gift_aid_city: 'Manchester', gift_aid_postcode: 'M1 4BT', stripe_payment_intent_id: 'pi_test_seed_001', payment_status: 'succeeded' },
    { team_member_id: firstMemberId, donor_name: 'Anonymous Donor', donor_email: 'anon.test@example.com', donor_message: null, is_anonymous: true, amount: 25.00, gift_aid: false, gift_aid_address_line_1: null, gift_aid_address_line_2: null, gift_aid_city: null, gift_aid_postcode: null, stripe_payment_intent_id: 'pi_test_seed_002', payment_status: 'succeeded' },
    { team_member_id: sarah.id, donor_name: 'Emma Richardson', donor_email: 'emma.r.test@example.com', donor_message: 'Go Sarah! Smashing it!', is_anonymous: false, amount: 100.00, gift_aid: true, gift_aid_address_line_1: '7 Willow Close', gift_aid_address_line_2: 'Flat 3', gift_aid_city: 'Birmingham', gift_aid_postcode: 'B2 5HG', stripe_payment_intent_id: 'pi_test_seed_003', payment_status: 'succeeded' },
    { team_member_id: sarah.id, donor_name: 'Tom Baker', donor_email: 'tom.baker.test@example.com', donor_message: null, is_anonymous: false, amount: 30.00, gift_aid: false, gift_aid_address_line_1: null, gift_aid_address_line_2: null, gift_aid_city: null, gift_aid_postcode: null, stripe_payment_intent_id: 'pi_test_seed_004', payment_status: 'succeeded' },
    { team_member_id: james.id, donor_name: 'Rebecca Moore', donor_email: 'rebecca.m.test@example.com', donor_message: 'Keep up the amazing work James!', is_anonymous: false, amount: 75.00, gift_aid: true, gift_aid_address_line_1: '22 Elm Street', gift_aid_address_line_2: null, gift_aid_city: 'London', gift_aid_postcode: 'SW1A 1AA', stripe_payment_intent_id: 'pi_test_seed_005', payment_status: 'succeeded' },
    { team_member_id: james.id, donor_name: 'Michael Chen', donor_email: 'michael.c.test@example.com', donor_message: 'Wonderful initiative', is_anonymous: false, amount: 150.00, gift_aid: false, gift_aid_address_line_1: null, gift_aid_address_line_2: null, gift_aid_city: null, gift_aid_postcode: null, stripe_payment_intent_id: 'pi_test_seed_006', payment_status: 'succeeded' },
    { team_member_id: james.id, donor_name: 'Pending Donor', donor_email: 'pending.test@example.com', donor_message: null, is_anonymous: false, amount: 20.00, gift_aid: false, gift_aid_address_line_1: null, gift_aid_address_line_2: null, gift_aid_city: null, gift_aid_postcode: null, stripe_payment_intent_id: 'pi_test_seed_007', payment_status: 'pending' },
  ];

  console.log(`\nCreating ${donationRows.length} test donations...`);
  const createdDonations = [];

  for (const d of donationRows) {
    const { rows: [donation] } = await client.query(
      `INSERT INTO fundraising_donation 
         (tenant_id, campaign_id, team_member_id, donor_name, donor_email, donor_message, is_anonymous, amount, currency, gift_aid, gift_aid_address_line_1, gift_aid_address_line_2, gift_aid_city, gift_aid_postcode, stripe_payment_intent_id, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [tenantId, campaign.id, d.team_member_id, d.donor_name, d.donor_email, d.donor_message, d.is_anonymous, d.amount, currency, d.gift_aid, d.gift_aid_address_line_1, d.gift_aid_address_line_2, d.gift_aid_city, d.gift_aid_postcode, d.stripe_payment_intent_id, d.payment_status]
    );
    createdDonations.push(donation);
  }

  const allMembers = [matMember, sarah, james].filter(Boolean);

  console.log(`\nCreated ${createdDonations.length} test donations:`);
  createdDonations.forEach(d => {
    const member = allMembers.find(m => m.id === d.team_member_id);
    const memberName = member ? `${member.first_name} ${member.last_name}` : 'Unknown';
    const giftAid = d.gift_aid ? ' [Gift Aid]' : '';
    console.log(`  - ${d.donor_name}: ${d.currency} ${Number(d.amount).toFixed(2)} -> ${memberName} (${d.payment_status})${giftAid}`);
  });

  const succeeded = createdDonations.filter(d => d.payment_status === 'succeeded');
  const total = succeeded.reduce((sum, d) => sum + parseFloat(d.amount), 0);
  const giftAidBonus = succeeded.filter(d => d.gift_aid).reduce((sum, d) => sum + parseFloat(d.amount) * 0.25, 0);

  console.log(`\nSummary:`);
  console.log(`  Total raised: ${currency} ${total.toFixed(2)}`);
  console.log(`  Gift Aid bonus: ${currency} ${giftAidBonus.toFixed(2)}`);
  console.log(`  Succeeded: ${succeeded.length}, Pending: ${createdDonations.length - succeeded.length}`);
  console.log('\nDone!');
}

seed()
  .catch(err => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => client.end());
