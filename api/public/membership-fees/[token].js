import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { data: feeToken, error: tokenError } = await supabase
      .from('membership_fee_token')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !feeToken) {
      return res.status(404).json({ error: 'Fee link not found or has expired' });
    }

    if (new Date(feeToken.expires_at) < new Date()) {
      if (feeToken.status === 'pending') {
        await supabase
          .from('membership_fee_token')
          .update({ status: 'expired' })
          .eq('id', feeToken.id);
      }
      return res.status(410).json({ error: 'This fee link has expired' });
    }

    if (feeToken.status === 'cancelled') {
      return res.status(410).json({ error: 'This fee link has been cancelled' });
    }

    if (req.method === 'GET') {
      const { data: org } = await supabase
        .from('organization')
        .select('name')
        .eq('id', feeToken.organization_id)
        .single();

      let tenantBranding = null;
      try {
        const { data: tenant } = await supabase
          .from('tenant')
          .select('name, slug, logo_url, primary_color, secondary_color')
          .eq('id', feeToken.tenant_id)
          .single();
        tenantBranding = tenant;
      } catch {}

      let stripePublishableKey = null;
      try {
        const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
        const creds = await getStripeCredentials(feeToken.tenant_id);
        if (creds?.is_enabled && creds?.publishable_key) {
          stripePublishableKey = creds.publishable_key;
        }
      } catch {}

      return res.json({
        status: feeToken.status,
        organizationName: org?.name || 'Organisation',
        membershipYear: feeToken.membership_year,
        finalCost: parseFloat(feeToken.final_cost),
        currency: feeToken.currency || 'GBP',
        tierLabel: feeToken.tier_label,
        costBreakdown: feeToken.cost_breakdown || {},
        poNumber: feeToken.po_number || null,
        stripeEnabled: !!stripePublishableKey,
        stripePublishableKey,
        tenant: tenantBranding ? {
          name: tenantBranding.name,
          logoUrl: tenantBranding.logo_url,
          primaryColor: tenantBranding.primary_color || '#5C0085',
        } : null,
      });
    }

    if (req.method === 'POST') {
      if (feeToken.status === 'paid') {
        return res.status(400).json({ error: 'This membership fee has already been paid' });
      }

      const { action } = req.body;

      if (action === 'submit_po') {
        const { poNumber } = req.body;
        if (!poNumber || !poNumber.trim()) {
          return res.status(400).json({ error: 'Purchase order number is required' });
        }

        const { error: updateError } = await supabase
          .from('membership_fee_token')
          .update({
            po_number: poNumber.trim(),
            status: 'po_submitted',
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        if (updateError) {
          console.error('[Public Fee] Error updating PO:', updateError);
          return res.status(500).json({ error: 'Failed to save purchase order number' });
        }

        try {
          const { data: existingInvoicing } = await supabase
            .from('organisation_membership_invoicing')
            .select('id')
            .eq('tenant_id', feeToken.tenant_id)
            .eq('organization_id', feeToken.organization_id)
            .eq('membership_year', feeToken.membership_year)
            .maybeSingle();

          if (existingInvoicing) {
            await supabase
              .from('organisation_membership_invoicing')
              .update({ purchase_order_number: poNumber.trim(), updated_at: new Date().toISOString() })
              .eq('id', existingInvoicing.id);
          } else {
            await supabase
              .from('organisation_membership_invoicing')
              .insert({
                tenant_id: feeToken.tenant_id,
                organization_id: feeToken.organization_id,
                membership_year: feeToken.membership_year,
                invoicing_mode: 'manual',
                purchase_order_number: poNumber.trim(),
              });
          }
        } catch {}

        try {
          await supabase.from('organization_note').insert({
            organization_id: feeToken.organization_id,
            member_id: null,
            content: `[Membership Fee - PO Submitted] Purchase order ${poNumber.trim()} submitted via fee link for ${feeToken.membership_year}.`,
            attachments: [],
          });
        } catch {}

        return res.json({
          success: true,
          message: 'Purchase order number submitted successfully',
        });
      }

      if (action === 'create_payment') {
        const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(feeToken.tenant_id);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment processing is not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const amount = Math.round(parseFloat(feeToken.final_cost) * 100);

        const { data: org } = await supabase
          .from('organization')
          .select('name')
          .eq('id', feeToken.organization_id)
          .single();

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: (feeToken.currency || 'GBP').toLowerCase(),
          metadata: {
            token_id: feeToken.id,
            organization_id: feeToken.organization_id,
            membership_year: feeToken.membership_year,
            tenant_id: feeToken.tenant_id,
          },
          description: `Membership fee for ${org?.name || 'Organisation'} - ${feeToken.membership_year}`,
        });

        await supabase
          .from('membership_fee_token')
          .update({
            stripe_payment_intent_id: paymentIntent.id,
            stripe_client_secret: paymentIntent.client_secret,
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        return res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      }

      if (action === 'confirm_payment') {
        const { paymentIntentId } = req.body;
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'paymentIntentId is required' });
        }

        const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(feeToken.tenant_id);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment verification not available' });
        }

        if (feeToken.stripe_payment_intent_id && feeToken.stripe_payment_intent_id !== paymentIntentId) {
          return res.status(400).json({ error: 'Payment intent does not match this fee token' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ error: 'Payment has not been completed', status: paymentIntent.status });
        }

        const expectedAmount = Math.round(parseFloat(feeToken.final_cost) * 100);
        if (paymentIntent.amount !== expectedAmount) {
          console.error(`[Public Fee] Amount mismatch: expected ${expectedAmount}, got ${paymentIntent.amount}`);
          return res.status(400).json({ error: 'Payment amount does not match expected fee' });
        }

        await supabase
          .from('membership_fee_token')
          .update({
            status: 'paid',
            stripe_payment_intent_id: paymentIntentId,
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        const { simulateMembershipForOrg } = await import('../../_lib/membershipSimulation.js');
        const simResult = await simulateMembershipForOrg(feeToken.tenant_id, feeToken.organization_id, {
          source: 'stripe-payment',
          mode: 'manual',
          targetYear: feeToken.membership_year,
        });

        let recordCreated = false;
        if (simResult.success && !simResult.existingRecord) {
          const { error: insertError } = await supabase
            .from('organisation_membership_history')
            .insert({
              tenant_id: feeToken.tenant_id,
              organization_id: feeToken.organization_id,
              membership_year: simResult.membershipYear.label,
              config_id: simResult.config?.id || null,
              band_id: simResult.matchedBand?.id || null,
              tier_label: simResult.tierLabel,
              field_value: simResult.fieldValue,
              annual_cost: simResult.annualCost,
              prorata_cost: simResult.prorataCost,
              free_period_discount: simResult.freeDiscount || 0,
              rollover_discount: simResult.rolloverDiscount || 0,
              custom_discount_total: simResult.customDiscountTotal || 0,
              custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
              final_cost: parseFloat(feeToken.final_cost),
              currency: feeToken.currency || 'GBP',
              billing_period: simResult.billingPeriod || 'annual',
              purchase_order_number: feeToken.po_number || null,
              payment_method: 'stripe',
              stripe_payment_intent_id: paymentIntentId,
              status: 'active',
              notes: `Payment received via Stripe (${paymentIntentId}). Fee link: ${token.substring(0, 8)}...`,
            });

          if (!insertError || insertError.code === '23505') {
            recordCreated = !insertError;
          } else {
            console.error('[Public Fee] Error creating history record:', insertError);
          }
        }

        let xeroInvoice = null;
        if (recordCreated) {
          try {
            const { createXeroMembershipInvoice } = await import('../../_lib/xero.js');
            const { data: org } = await supabase
              .from('organization')
              .select('name')
              .eq('id', feeToken.organization_id)
              .single();

            const reference = feeToken.po_number
              ? `Membership ${feeToken.membership_year} - PO: ${feeToken.po_number} (PAID)`
              : `Membership ${feeToken.membership_year} (PAID)`;

            xeroInvoice = await createXeroMembershipInvoice({
              appTenantId: feeToken.tenant_id,
              organizationName: org?.name || 'Organisation',
              membershipYear: feeToken.membership_year,
              tierLabel: feeToken.tier_label,
              finalCost: parseFloat(feeToken.final_cost),
              currency: feeToken.currency || 'GBP',
              reference,
              vatRate: simResult.matchedBand?.vat_rate || null,
            });
          } catch (xeroErr) {
            console.error('[Public Fee] Xero invoice failed (non-fatal):', xeroErr.message);
          }
        }

        try {
          const invoiceNote = xeroInvoice
            ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
            : recordCreated ? ' Xero invoice could not be created.' : '';
          await supabase.from('organization_note').insert({
            organization_id: feeToken.organization_id,
            member_id: null,
            content: `[Membership Fee - Stripe Payment] Payment received for ${feeToken.membership_year}. Amount: ${feeToken.currency} ${parseFloat(feeToken.final_cost).toFixed(2)}. Stripe PI: ${paymentIntentId}.${invoiceNote}`,
            attachments: [],
          });
        } catch {}

        return res.json({
          success: true,
          recordCreated,
          xeroInvoice: xeroInvoice ? { invoice_number: xeroInvoice.invoice_number } : null,
          message: 'Payment confirmed successfully',
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Public Fee] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
