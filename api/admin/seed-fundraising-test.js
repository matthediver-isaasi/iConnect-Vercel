import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    const { data: campaign } = await supabase
      .from('fundraising_campaign')
      .select('*')
      .eq('tenant_id', tenantId)
      .ilike('name', '%test%')
      .single();

    if (!campaign) {
      return res.status(404).json({ error: 'No test campaign found for this tenant' });
    }

    const { data: existingMembers } = await supabase
      .from('fundraising_team_member')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('tenant_id', tenantId);

    const matMember = (existingMembers || []).find(m => m.email === 'mat.the.diver@googlemail.com');

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

    const { data: newMembers, error: memberError } = await supabase
      .from('fundraising_team_member')
      .insert(externalMembers)
      .select();

    if (memberError) {
      return res.status(500).json({ error: 'Failed to create team members', details: memberError.message });
    }

    const allMembers = [
      ...(matMember ? [matMember] : []),
      ...newMembers
    ];

    const donationData = [
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

    const { data: donations, error: donationError } = await supabase
      .from('fundraising_donation')
      .insert(donationData)
      .select();

    if (donationError) {
      return res.status(500).json({ error: 'Failed to create donations', details: donationError.message });
    }

    return res.json({
      success: true,
      summary: {
        campaign: campaign.name,
        new_team_members: newMembers.length,
        new_donations: donations.length,
        team_members: newMembers.map(m => ({
          name: `${m.first_name} ${m.last_name}`,
          email: m.email,
          token: m.token
        }))
      }
    });
  } catch (error) {
    console.error('[Seed Fundraising] Error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}
