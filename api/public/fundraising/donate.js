import { createClient } from '@supabase/supabase-js';
import { getStripeCredentials, findOrCreateStripeCustomer } from '../../_lib/stripeCredentials.js';
import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const {
      token,
      donor_name,
      donor_email,
      donor_message,
      is_anonymous,
      amount,
      gift_aid,
      gift_aid_address_line_1,
      gift_aid_address_line_2,
      gift_aid_city,
      gift_aid_postcode,
      marketing_consent
    } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    if (!donor_name) {
      return res.status(400).json({ error: 'Donor name is required' });
    }
    if (!amount || parseFloat(amount) < 1) {
      return res.status(400).json({ error: 'Minimum donation amount is 1.00' });
    }

    if (gift_aid) {
      if (!gift_aid_address_line_1) {
        return res.status(400).json({ error: 'Address line 1 is required for Gift Aid' });
      }
      if (!gift_aid_city) {
        return res.status(400).json({ error: 'City is required for Gift Aid' });
      }
      if (!gift_aid_postcode) {
        return res.status(400).json({ error: 'Postcode is required for Gift Aid' });
      }
    }

    const { data: teamMember, error: tmError } = await supabase
      .from('fundraising_team_member')
      .select('*, fundraising_campaign(*)')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (tmError || !teamMember) {
      return res.status(404).json({ error: 'Donation page not found' });
    }

    const campaign = teamMember.fundraising_campaign;

    if (!campaign || campaign.status !== 'active') {
      return res.status(400).json({ error: 'This campaign is not currently accepting donations' });
    }

    const stripeCredentials = await getStripeCredentials(teamMember.tenant_id);
    if (!stripeCredentials?.secret_key) {
      return res.status(503).json({ error: 'Payment processing is not configured for this campaign' });
    }

    const stripe = new Stripe(stripeCredentials.secret_key);

    const amountInPence = Math.round(parseFloat(amount) * 100);

    const stripeCustomer = donor_email
      ? await findOrCreateStripeCustomer(stripe, {
          email: donor_email,
          name: is_anonymous ? undefined : donor_name,
          metadata: { type: 'fundraising_donor', tenant_id: teamMember.tenant_id },
        })
      : null;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPence,
      currency: (campaign.currency || 'GBP').toLowerCase(),
      customer: stripeCustomer?.id || undefined,
      receipt_email: donor_email || undefined,
      metadata: {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        team_member_id: teamMember.id,
        team_member_name: `${teamMember.first_name} ${teamMember.last_name}`,
        donor_name: is_anonymous ? 'Anonymous' : donor_name,
        gift_aid: gift_aid ? 'yes' : 'no',
        type: 'fundraising_donation'
      },
      description: `Donation to ${campaign.name} - ${teamMember.first_name} ${teamMember.last_name}`
    });

    const { data: donation, error: dError } = await supabase
      .from('fundraising_donation')
      .insert({
        tenant_id: teamMember.tenant_id,
        campaign_id: campaign.id,
        team_member_id: teamMember.id,
        donor_name,
        donor_email: donor_email || null,
        donor_message: donor_message || null,
        is_anonymous: is_anonymous || false,
        amount: parseFloat(amount),
        currency: campaign.currency || 'GBP',
        gift_aid: gift_aid || false,
        gift_aid_address_line_1: gift_aid ? gift_aid_address_line_1 : null,
        gift_aid_address_line_2: gift_aid ? (gift_aid_address_line_2 || null) : null,
        gift_aid_city: gift_aid ? gift_aid_city : null,
        gift_aid_postcode: gift_aid ? gift_aid_postcode : null,
        marketing_consent: !!marketing_consent,
        marketing_consent_at: marketing_consent ? new Date().toISOString() : null,
        stripe_payment_intent_id: paymentIntent.id,
        payment_status: 'pending'
      })
      .select()
      .single();

    if (dError) {
      console.error('[Fundraising Donate] Error creating donation record:', dError);
      return res.status(500).json({ error: 'Failed to create donation record' });
    }

    return res.json({
      donation_id: donation.id,
      client_secret: paymentIntent.client_secret,
      publishable_key: stripeCredentials.publishable_key,
      amount: parseFloat(amount),
      currency: campaign.currency || 'GBP'
    });
  } catch (error) {
    console.error('[Fundraising Donate] Error:', error);
    return res.status(500).json({ error: 'Failed to process donation' });
  }
}
