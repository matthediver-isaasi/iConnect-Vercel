import { createClient } from '@supabase/supabase-js';
import { getStripeCredentials } from '../../_lib/stripeCredentials.js';
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
    const { donation_id, payment_intent_id } = req.body;

    if (!donation_id || !payment_intent_id) {
      return res.status(400).json({ error: 'donation_id and payment_intent_id are required' });
    }

    const { data: donation, error: fetchError } = await supabase
      .from('fundraising_donation')
      .select('*')
      .eq('id', donation_id)
      .eq('stripe_payment_intent_id', payment_intent_id)
      .eq('payment_status', 'pending')
      .single();

    if (fetchError || !donation) {
      return res.status(404).json({ error: 'Donation not found or already confirmed' });
    }

    const stripeCredentials = await getStripeCredentials(donation.tenant_id);
    if (!stripeCredentials?.secret_key) {
      console.error('[Fundraising Confirm] No Stripe credentials for tenant:', donation.tenant_id);
      return res.status(503).json({ error: 'Payment verification not available' });
    }

    const stripe = new Stripe(stripeCredentials.secret_key);
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      console.warn('[Fundraising Confirm] Payment not succeeded. Status:', paymentIntent.status);
      return res.status(400).json({
        error: 'Payment has not been completed',
        status: paymentIntent.status
      });
    }

    const { data, error } = await supabase
      .from('fundraising_donation')
      .update({ payment_status: 'succeeded' })
      .eq('id', donation_id)
      .eq('payment_status', 'pending')
      .select()
      .single();

    if (error) {
      console.error('[Fundraising Confirm] Error updating donation:', error);
      return res.status(500).json({ error: 'Failed to confirm donation' });
    }

    return res.json({ success: true, donation_id: data.id });
  } catch (error) {
    console.error('[Fundraising Confirm] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
