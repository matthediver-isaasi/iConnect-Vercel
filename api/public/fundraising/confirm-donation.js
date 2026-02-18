import { createClient } from '@supabase/supabase-js';
import { getStripeCredentials } from '../../_lib/stripeCredentials.js';
import { sendEmail } from '../../_lib/emailService.js';
import Stripe from 'stripe';
import crypto from 'crypto';

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

    try {
      const { data: teamMember } = await supabase
        .from('fundraising_team_member')
        .select('id, first_name, last_name, email, tenant_id, fundraising_campaign(name)')
        .eq('id', donation.team_member_id)
        .single();

      if (teamMember?.email) {
        const { data: tenant } = await supabase
          .from('tenant')
          .select('id, name, slug, domain')
          .eq('id', donation.tenant_id)
          .single();

        const appDomain = process.env.APP_DOMAIN || 'iconn.app';
        let baseUrl;
        if (tenant?.domain) {
          baseUrl = `https://${tenant.domain}`;
        } else if (tenant?.slug) {
          baseUrl = `https://${tenant.slug}.${appDomain}`;
        } else {
          baseUrl = `https://${appDomain}`;
        }

        const loginToken = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        await supabase
          .from('fundraising_login_token')
          .insert({
            tenant_id: donation.tenant_id,
            email: teamMember.email.trim().toLowerCase(),
            token: loginToken,
            expires_at: expiresAt
          });

        const dashboardUrl = `${baseUrl}/fundraiser/dashboard?token=${loginToken}`;
        const campaignName = escapeHtml(teamMember.fundraising_campaign?.name || 'your campaign');
        const donorDisplay = donation.is_anonymous ? 'An anonymous donor' : escapeHtml(donation.donor_name);
        const currency = (donation.currency || 'GBP').toUpperCase();
        const currencySymbol = currency === 'GBP' ? '\u00A3' : currency === 'USD' ? '$' : currency === 'EUR' ? '\u20AC' : '';
        const formattedAmount = `${currencySymbol}${parseFloat(donation.amount).toFixed(2)}`;
        const safeDonorMessage = donation.donor_message ? escapeHtml(donation.donor_message) : null;

        await sendEmail({
          to: teamMember.email,
          subject: `New Donation Received - ${formattedAmount} for ${campaignName}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #1a1a1a; margin-bottom: 8px;">Congratulations, ${escapeHtml(teamMember.first_name)}!</h2>
              <p style="color: #333; font-size: 16px; line-height: 1.5;">
                Great news! ${donorDisplay} has just made a <strong>${formattedAmount}</strong> donation to <strong>${campaignName}</strong>.
              </p>
              ${safeDonorMessage ? `
                <div style="background-color: #f8f9fa; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 20px 0; border-radius: 0 6px 6px 0;">
                  <p style="color: #555; font-size: 14px; font-style: italic; margin: 0;">&ldquo;${safeDonorMessage}&rdquo;</p>
                  <p style="color: #888; font-size: 13px; margin: 8px 0 0 0;">&mdash; ${donorDisplay}</p>
                </div>
              ` : ''}
              <p style="color: #333; font-size: 16px; line-height: 1.5;">
                Visit your dashboard to view all donations, send thank you messages, and share your donation link.
              </p>
              <div style="margin: 32px 0;">
                <a href="${dashboardUrl}" 
                   style="display: inline-block; padding: 14px 32px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
                  Go to My Dashboard
                </a>
              </div>
              <p style="color: #999; font-size: 13px;">
                This link expires in 24 hours. Keep sharing your fundraising page to reach your goal!
              </p>
            </div>
          `,
          tenantId: donation.tenant_id
        });

        console.log(`[Fundraising Confirm] Congratulations email sent to ${teamMember.email} for donation ${data.id}`);
      }
    } catch (emailErr) {
      console.error('[Fundraising Confirm] Failed to send congratulations email:', emailErr);
    }

    return res.json({ success: true, donation_id: data.id });
  } catch (error) {
    console.error('[Fundraising Confirm] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
