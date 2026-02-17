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
        const { data: stripeSetting } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'membership_stripe_enabled')
          .eq('tenant_id', feeToken.tenant_id)
          .maybeSingle();

        const stripeSettingEnabled = stripeSetting?.setting_value !== 'false';

        if (stripeSettingEnabled) {
          const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
          const creds = await getStripeCredentials(feeToken.tenant_id);
          if (creds?.is_enabled && creds?.publishable_key) {
            stripePublishableKey = creds.publishable_key;
          }
        }
      } catch {}

      const breakdown = feeToken.cost_breakdown || {};

      if (breakdown.freeDiscount > 0 && !breakdown.freePeriodUnit) {
        try {
          const { simulateMembershipForOrg } = await import('../../_lib/membershipSimulation.js');
          const simResult = await simulateMembershipForOrg(feeToken.tenant_id, feeToken.organization_id, {
            source: 'token-enrich',
            targetYear: feeToken.membership_year,
          });
          if (simResult.success) {
            breakdown.freePeriodUnit = simResult.freePeriodUnit;
            breakdown.freePeriodAmount = simResult.freePeriodAmount;
            breakdown.yearNumber = simResult.yearNumber;
            if (!breakdown.freePeriodDaysApplied) {
              breakdown.freePeriodDaysApplied = simResult.freePeriodDaysApplied || 0;
            }
          }
        } catch {}
      }

      const tokenVatRate = breakdown.vatRatePercent || null;
      const tokenVatAmount = breakdown.vatAmount || 0;
      const tokenTotalWithVat = breakdown.totalWithVat || parseFloat(feeToken.final_cost);

      return res.json({
        status: feeToken.status,
        organizationName: org?.name || 'Organisation',
        membershipYear: feeToken.membership_year,
        finalCost: parseFloat(feeToken.final_cost),
        vatRatePercent: tokenVatRate,
        vatAmount: tokenVatAmount,
        totalWithVat: tokenTotalWithVat,
        currency: feeToken.currency || 'GBP',
        tierLabel: feeToken.tier_label,
        costBreakdown: breakdown,
        poNumber: feeToken.po_number || null,
        stripeEnabled: !!stripePublishableKey,
        stripePublishableKey,
        tenant: tenantBranding ? {
          name: tenantBranding.name,
          logoUrl: tenantBranding.logo_url,
          primaryColor: tenantBranding.primary_color || '#5C0085',
        } : null,
        ...(await (async () => {
          try {
            const { data: s } = await supabase.from('system_settings').select('setting_value').eq('setting_key', 'membership_require_approval').eq('tenant_id', feeToken.tenant_id).maybeSingle();
            if (s?.setting_value !== 'true') return { approvalPending: false, approvalMessage: null };
            const { data: inv } = await supabase.from('organisation_membership_invoicing').select('fees_approved').eq('tenant_id', feeToken.tenant_id).eq('organization_id', feeToken.organization_id).eq('membership_year', feeToken.membership_year).maybeSingle();
            if (inv?.fees_approved) return { approvalPending: false, approvalMessage: null };
            const { data: msgSetting } = await supabase.from('system_settings').select('setting_value').eq('setting_key', 'membership_custom_message').eq('tenant_id', feeToken.tenant_id).maybeSingle();
            return { approvalPending: true, approvalMessage: msgSetting?.setting_value || null };
          } catch { return { approvalPending: false, approvalMessage: null }; }
        })()),
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

        try {
          const { data: approvalSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'membership_require_approval')
            .eq('tenant_id', feeToken.tenant_id)
            .maybeSingle();

          if (approvalSetting?.setting_value === 'true') {
            const { data: invoicing } = await supabase
              .from('organisation_membership_invoicing')
              .select('fees_approved')
              .eq('tenant_id', feeToken.tenant_id)
              .eq('organization_id', feeToken.organization_id)
              .eq('membership_year', feeToken.membership_year)
              .maybeSingle();

            if (!invoicing?.fees_approved) {
              return res.status(400).json({ error: 'Fees have not yet been approved. Please contact your administrator.' });
            }
          }
        } catch {}

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

        let poSyncWarning = null;
        try {
          try {
            await supabase.rpc('exec_sql', {
              sql_text: `
                ALTER TABLE organisation_membership_invoicing ADD COLUMN IF NOT EXISTS purchase_order_number TEXT;
                ALTER TABLE organisation_membership_invoicing ADD COLUMN IF NOT EXISTS membership_year TEXT;
                ALTER TABLE organisation_membership_invoicing ADD COLUMN IF NOT EXISTS po_source TEXT;
              `
            });
          } catch (colErr) {
            console.warn('[Public Fee] exec_sql unavailable for column ensure:', colErr?.message || colErr);
          }

          const { data: existingInvoicing, error: lookupErr } = await supabase
            .from('organisation_membership_invoicing')
            .select('id')
            .eq('tenant_id', feeToken.tenant_id)
            .eq('organization_id', feeToken.organization_id)
            .eq('membership_year', feeToken.membership_year)
            .maybeSingle();

          if (lookupErr) {
            console.error('[Public Fee] Error looking up invoicing row:', lookupErr);
            poSyncWarning = 'PO number saved on token but could not sync to admin invoicing tab. The admin may need to add the purchase_order_number column manually.';
          } else if (existingInvoicing) {
            const { error: updErr } = await supabase
              .from('organisation_membership_invoicing')
              .update({ purchase_order_number: poNumber.trim(), po_source: 'member', updated_at: new Date().toISOString() })
              .eq('id', existingInvoicing.id);
            if (updErr) {
              console.error('[Public Fee] Error updating PO on invoicing row:', updErr);
              poSyncWarning = 'PO number saved on token but failed to sync to admin invoicing tab.';
            }
          } else {
            const { error: insErr } = await supabase
              .from('organisation_membership_invoicing')
              .insert({
                tenant_id: feeToken.tenant_id,
                organization_id: feeToken.organization_id,
                membership_year: feeToken.membership_year,
                invoicing_mode: 'manual',
                purchase_order_number: poNumber.trim(),
                po_source: 'member',
              });
            if (insErr) {
              console.error('[Public Fee] Error inserting invoicing row with PO:', insErr);
              poSyncWarning = 'PO number saved on token but failed to sync to admin invoicing tab.';
            }
          }
        } catch (syncErr) {
          console.error('[Public Fee] Error syncing PO to invoicing:', syncErr);
          poSyncWarning = 'PO number saved on token but could not sync to admin invoicing tab.';
        }

        try {
          await supabase.from('organization_note').insert({
            organization_id: feeToken.organization_id,
            member_id: null,
            content: `[Membership Fee - PO Submitted] Purchase order ${poNumber.trim()} submitted via fee link for ${feeToken.membership_year}.`,
            attachments: [],
          });
        } catch {}

        const response = {
          success: true,
          message: 'Purchase order number submitted successfully',
        };
        if (poSyncWarning) response.warning = poSyncWarning;
        return res.json(response);
      }

      if (action === 'create_payment') {
        try {
          const { data: approvalSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'membership_require_approval')
            .eq('tenant_id', feeToken.tenant_id)
            .maybeSingle();

          if (approvalSetting?.setting_value === 'true') {
            const { data: invoicing } = await supabase
              .from('organisation_membership_invoicing')
              .select('fees_approved')
              .eq('tenant_id', feeToken.tenant_id)
              .eq('organization_id', feeToken.organization_id)
              .eq('membership_year', feeToken.membership_year)
              .maybeSingle();

            if (!invoicing?.fees_approved) {
              return res.status(400).json({ error: 'Fees have not yet been approved for payment. Please contact your administrator.' });
            }
          }
        } catch {}

        const { getStripeCredentials, findOrCreateStripeCustomer } = await import('../../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(feeToken.tenant_id);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment processing is not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const tokenBreakdown = feeToken.cost_breakdown || {};
        const chargeTotal = tokenBreakdown.totalWithVat || parseFloat(feeToken.final_cost);
        const amount = Math.round(chargeTotal * 100);
        const STRIPE_MIN_CENTS = { gbp: 30, usd: 50, eur: 50, aud: 50, nzd: 50 };
        const cur = (feeToken.currency || 'GBP').toLowerCase();
        const minCents = STRIPE_MIN_CENTS[cur] || 50;
        if (amount < minCents) {
          return res.status(400).json({ error: `Amount is below the minimum charge for ${cur.toUpperCase()}` });
        }

        const { data: org } = await supabase
          .from('organization')
          .select('name')
          .eq('id', feeToken.organization_id)
          .single();

        const stripeCustomer = feeToken.recipient_email
          ? await findOrCreateStripeCustomer(stripe, {
              email: feeToken.recipient_email,
              name: org?.name || undefined,
              metadata: { tenant_id: feeToken.tenant_id, organization_id: feeToken.organization_id, organization_name: org?.name || '' },
            })
          : null;

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: (feeToken.currency || 'GBP').toLowerCase(),
          customer: stripeCustomer?.id || undefined,
          receipt_email: feeToken.recipient_email || undefined,
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

        // Idempotency: check if a membership record already exists for this PaymentIntent
        const { data: existingByPI } = await supabase
          .from('organisation_membership_history')
          .select('id')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle();

        if (existingByPI) {
          console.log(`[Public Fee] Idempotent return: record already exists for PI ${paymentIntentId}`);
          if (feeToken.status !== 'paid') {
            await supabase.from('membership_fee_token').update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', feeToken.id);
          }
          return res.json({ success: true, already_processed: true, recordCreated: true, message: 'Payment already confirmed' });
        }

        try {
          const { data: approvalSetting } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'membership_require_approval')
            .eq('tenant_id', feeToken.tenant_id)
            .maybeSingle();

          if (approvalSetting?.setting_value === 'true') {
            const { data: invoicing } = await supabase
              .from('organisation_membership_invoicing')
              .select('fees_approved')
              .eq('tenant_id', feeToken.tenant_id)
              .eq('organization_id', feeToken.organization_id)
              .eq('membership_year', feeToken.membership_year)
              .maybeSingle();

            if (!invoicing?.fees_approved) {
              return res.status(400).json({ error: 'Fees have not yet been approved for payment. Please contact your administrator.' });
            }
          }
        } catch {}

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

        const confirmBreakdown = feeToken.cost_breakdown || {};
        const confirmTotal = confirmBreakdown.totalWithVat || parseFloat(feeToken.final_cost);
        const expectedAmount = Math.round(confirmTotal * 100);
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
        let historyRecord = null;
        if (simResult.success && !simResult.existingRecord) {
          const { data: insertedRecord, error: insertError } = await supabase
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
            })
            .select()
            .single();

          if (!insertError) {
            recordCreated = true;
            historyRecord = insertedRecord;
          } else if (insertError.code === '23505') {
            console.log(`[Public Fee] Duplicate constraint hit for PI ${paymentIntentId} - already processed`);
            recordCreated = true;
          } else {
            console.error('[Public Fee] Error creating history record:', insertError);
            // Auto-refund: record creation failed after payment succeeded
            try {
              await stripe.refunds.create({
                payment_intent: paymentIntentId,
                reason: 'requested_by_customer',
                metadata: { reason: 'membership_record_creation_failed', token_id: feeToken.id }
              });
              console.log(`[Public Fee] Auto-refund issued for PI ${paymentIntentId} after record creation failure`);
              await supabase.from('membership_fee_token').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('id', feeToken.id);
            } catch (refundErr) {
              console.error(`[Public Fee] Auto-refund FAILED for PI ${paymentIntentId}:`, refundErr.message);
            }
            return res.status(500).json({ error: 'Failed to create membership record. A refund has been initiated. Please contact support if you do not see it within 5-10 business days.' });
          }
        }

        let xeroInvoice = null;
        if (recordCreated) {
          try {
            const { createXeroMembershipInvoice } = await import('../../_lib/xero.js');
            const { data: org } = await supabase
              .from('organization')
              .select('name, invoicing_address')
              .eq('id', feeToken.organization_id)
              .single();

            const reference = feeToken.po_number
              ? `Membership ${feeToken.membership_year} - PO: ${feeToken.po_number}`
              : `Membership ${feeToken.membership_year}`;

            xeroInvoice = await createXeroMembershipInvoice({
              appTenantId: feeToken.tenant_id,
              organizationName: org?.name || 'Organisation',
              invoicingAddress: org?.invoicing_address,
              membershipYear: feeToken.membership_year,
              tierLabel: feeToken.tier_label,
              finalCost: parseFloat(feeToken.final_cost),
              currency: feeToken.currency || 'GBP',
              reference,
              vatRate: simResult.matchedBand?.vat_rate || null,
              markAsPaid: true,
              stripePaymentIntentId: paymentIntentId,
            });
          } catch (xeroErr) {
            console.error('[Public Fee] Xero invoice failed (non-fatal):', xeroErr.message);
          }

          if (xeroInvoice && historyRecord) {
            try {
              const { sendMembershipInvoiceEmail } = await import('../../_lib/membershipInvoiceEmail.js');
              const { data: emailOrg } = await supabase
                .from('organization')
                .select('name')
                .eq('id', feeToken.organization_id)
                .single();

              const tokenBreakdownForEmail = feeToken.cost_breakdown || {};
              await sendMembershipInvoiceEmail({
                tenantId: feeToken.tenant_id,
                organizationId: feeToken.organization_id,
                organizationName: emailOrg?.name || 'Organisation',
                membershipYear: feeToken.membership_year,
                finalCost: parseFloat(feeToken.final_cost),
                currency: feeToken.currency || 'GBP',
                tierLabel: feeToken.tier_label,
                xeroInvoiceNumber: xeroInvoice.invoice_number,
                xeroInvoiceId: xeroInvoice.invoice_id,
                historyRecordId: historyRecord.id,
                vatAmount: tokenBreakdownForEmail.vatAmount || 0,
                totalWithVat: tokenBreakdownForEmail.totalWithVat || parseFloat(feeToken.final_cost),
              });
            } catch (emailErr) {
              console.error('[Public Fee] Invoice email failed (non-fatal):', emailErr.message);
            }
          }
        }

        try {
          const invoiceNote = xeroInvoice
            ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
            : recordCreated ? ' Xero invoice could not be created.' : '';
          await supabase.from('organization_note').insert({
            organization_id: feeToken.organization_id,
            member_id: null,
            content: `[Membership Fee - Stripe Payment] Payment received for ${feeToken.membership_year}. Amount: ${feeToken.currency} ${parseFloat(confirmTotal).toFixed(2)}${confirmBreakdown.vatAmount > 0 ? ` (incl. VAT ${parseFloat(confirmBreakdown.vatAmount).toFixed(2)})` : ''}. Stripe PI: ${paymentIntentId}.${invoiceNote}`,
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
