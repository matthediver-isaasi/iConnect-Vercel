import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionMember = await getSessionMember(req);
  if (!sessionMember) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const { data: member } = await supabase
      .from('member')
      .select('id, organization_id, tenant_id')
      .eq('id', sessionMember.id)
      .single();

    if (!member?.organization_id || !member?.tenant_id) {
      return res.status(404).json({ error: 'No organisation linked to your account' });
    }

    const tenantId = member.tenant_id;
    const organizationId = member.organization_id;

    if (req.method === 'GET') {
      const membershipYear = req.query.year || null;

      const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
        source: 'member-portal',
        mode: 'manual',
        targetYear: membershipYear,
      });

      if (!simResult.success) {
        return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
      }

      const { data: org } = await supabase
        .from('organization')
        .select('name')
        .eq('id', organizationId)
        .single();

      let tenantBranding = null;
      try {
        const { data: tenant } = await supabase
          .from('tenant')
          .select('name, slug, logo_url, primary_color')
          .eq('id', tenantId)
          .single();
        tenantBranding = tenant;
      } catch {}

      let stripePublishableKey = null;
      try {
        const { data: integration } = await supabase
          .from('tenant_integrations')
          .select('credentials, is_enabled')
          .eq('tenant_id', tenantId)
          .eq('integration_type', 'stripe')
          .single();

        if (integration?.is_enabled && integration?.credentials?.publishable_key) {
          const pk = integration.credentials.publishable_key;
          if (pk.startsWith('pk_')) {
            stripePublishableKey = pk;
          }
        }
      } catch {}

      const { data: invoicingSetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('purchase_order_number, invoicing_mode')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .eq('membership_year', simResult.membershipYear?.label)
        .maybeSingle();

      const { data: existingRecord } = await supabase
        .from('organisation_membership_history')
        .select('id, status, payment_method, stripe_payment_intent_id')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .eq('membership_year', simResult.membershipYear?.label)
        .maybeSingle();

      return res.json({
        organizationName: org?.name || 'Organisation',
        membershipYear: simResult.membershipYear?.label,
        finalCost: simResult.finalCost,
        currency: simResult.currency || 'GBP',
        tierLabel: simResult.tierLabel,
        costBreakdown: {
          annualCostBeforeDiscounts: simResult.annualCostBeforeDiscounts,
          customDiscountTotal: simResult.customDiscountTotal || 0,
          customDiscountDetails: simResult.customDiscountDetails || [],
          annualCost: simResult.annualCost,
          proRataEnabled: simResult.proRataEnabled,
          prorataDays: simResult.prorataDays,
          prorataCost: simResult.prorataCost,
          freeDiscount: simResult.freeDiscount || 0,
          rolloverDiscount: simResult.rolloverDiscount || 0,
        },
        poNumber: invoicingSetting?.purchase_order_number || null,
        stripeEnabled: !!stripePublishableKey,
        stripePublishableKey,
        existingRecord: existingRecord ? {
          id: existingRecord.id,
          status: existingRecord.status,
          paymentMethod: existingRecord.payment_method,
        } : null,
        tenant: tenantBranding ? {
          name: tenantBranding.name,
          primaryColor: tenantBranding.primary_color || '#5C0085',
        } : null,
      });
    }

    if (req.method === 'POST') {
      const { action, membershipYear } = req.body;

      if (action === 'submit_po') {
        const { poNumber } = req.body;
        if (!poNumber || !poNumber.trim()) {
          return res.status(400).json({ error: 'Purchase order number is required' });
        }

        let targetYear = membershipYear;
        if (!targetYear) {
          const simForYear = await simulateMembershipForOrg(tenantId, organizationId, {
            source: 'member-portal-po',
            mode: 'manual',
          });
          if (!simForYear.success || !simForYear.membershipYear?.label) {
            return res.status(400).json({ error: 'Could not determine membership year for PO submission' });
          }
          targetYear = simForYear.membershipYear.label;
        }

        const { data: existing } = await supabase
          .from('organisation_membership_invoicing')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('organization_id', organizationId)
          .eq('membership_year', targetYear)
          .maybeSingle();

        if (existing) {
          await supabase
            .from('organisation_membership_invoicing')
            .update({ purchase_order_number: poNumber.trim() })
            .eq('id', existing.id);
        } else {
          await supabase
            .from('organisation_membership_invoicing')
            .insert({
              tenant_id: tenantId,
              organization_id: organizationId,
              membership_year: targetYear,
              invoicing_mode: 'automatic',
              purchase_order_number: poNumber.trim(),
            });
        }

        try {
          await supabase.from('organization_note').insert({
            organization_id: organizationId,
            member_id: sessionMember.id,
            content: `[Membership Fee - PO Submitted] Purchase order ${poNumber.trim()} submitted via member portal for ${targetYear}.`,
            attachments: [],
          });
        } catch {}

        return res.json({ success: true, message: 'Purchase order number submitted successfully' });
      }

      if (action === 'create_payment') {
        const targetYear = membershipYear || null;

        const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'member-portal-payment',
          mode: 'manual',
          targetYear,
        });

        if (!simResult.success) {
          return res.status(400).json({ error: simResult.error || 'Could not calculate fees' });
        }

        if (simResult.existingRecord) {
          return res.status(400).json({ error: 'A membership record already exists for this period' });
        }

        const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(tenantId);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment processing is not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const amount = Math.round(simResult.finalCost * 100);
        const currency = (simResult.currency || 'GBP').toLowerCase();

        const { data: org } = await supabase
          .from('organization')
          .select('name')
          .eq('id', organizationId)
          .single();

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency,
          metadata: {
            member_id: sessionMember.id,
            organization_id: organizationId,
            membership_year: simResult.membershipYear?.label,
            tenant_id: tenantId,
            source: 'member-portal',
          },
          description: `Membership fee for ${org?.name || 'Organisation'} - ${simResult.membershipYear?.label}`,
        });

        return res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          amount: simResult.finalCost,
          currency: simResult.currency || 'GBP',
          membershipYear: simResult.membershipYear?.label,
        });
      }

      if (action === 'confirm_payment') {
        const { paymentIntentId, membershipYear: confirmYear } = req.body;
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'paymentIntentId is required' });
        }

        const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(tenantId);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment verification not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ error: 'Payment has not been completed', status: paymentIntent.status });
        }

        if (paymentIntent.metadata?.organization_id !== organizationId) {
          return res.status(400).json({ error: 'Payment does not match your organisation' });
        }

        if (paymentIntent.metadata?.tenant_id !== tenantId) {
          return res.status(400).json({ error: 'Payment does not match your tenant' });
        }

        const targetYear = confirmYear || paymentIntent.metadata?.membership_year;

        const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'member-portal-confirm',
          mode: 'manual',
          targetYear,
        });

        if (!simResult.success) {
          console.error('[Member Fees] Simulation failed during confirm:', simResult.error);
          return res.status(400).json({ error: simResult.error || 'Could not verify membership fees' });
        }

        const expectedAmount = Math.round(simResult.finalCost * 100);
        if (paymentIntent.amount !== expectedAmount) {
          console.error(`[Member Fees] Amount mismatch: expected ${expectedAmount}, got ${paymentIntent.amount}`);
          return res.status(400).json({ error: 'Payment amount does not match expected fee' });
        }

        let recordCreated = false;
        if (simResult.success && !simResult.existingRecord) {
          const { data: invoicingSetting } = await supabase
            .from('organisation_membership_invoicing')
            .select('purchase_order_number')
            .eq('tenant_id', tenantId)
            .eq('organization_id', organizationId)
            .eq('membership_year', targetYear)
            .maybeSingle();

          const { error: insertError } = await supabase
            .from('organisation_membership_history')
            .insert({
              tenant_id: tenantId,
              organization_id: organizationId,
              membership_year: simResult.membershipYear?.label || targetYear,
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
              final_cost: simResult.finalCost,
              currency: simResult.currency || 'GBP',
              billing_period: simResult.billingPeriod || 'annual',
              purchase_order_number: invoicingSetting?.purchase_order_number || null,
              payment_method: 'stripe',
              stripe_payment_intent_id: paymentIntentId,
              status: 'active',
              notes: `Payment received via Stripe (member portal). PI: ${paymentIntentId}. Member: ${sessionMember.id}`,
            });

          if (!insertError || insertError.code === '23505') {
            recordCreated = !insertError;
          } else {
            console.error('[Member Fees] Error creating history record:', insertError);
          }
        }

        let xeroInvoice = null;
        if (recordCreated) {
          try {
            const { createXeroMembershipInvoice } = await import('../_lib/xero.js');
            const { data: org } = await supabase
              .from('organization')
              .select('name')
              .eq('id', organizationId)
              .single();

            const { data: invoicingSetting } = await supabase
              .from('organisation_membership_invoicing')
              .select('purchase_order_number')
              .eq('tenant_id', tenantId)
              .eq('organization_id', organizationId)
              .eq('membership_year', targetYear)
              .maybeSingle();

            const poNum = invoicingSetting?.purchase_order_number;
            const reference = poNum
              ? `Membership ${targetYear} - PO: ${poNum} (PAID)`
              : `Membership ${targetYear} (PAID)`;

            xeroInvoice = await createXeroMembershipInvoice({
              appTenantId: tenantId,
              organizationName: org?.name || 'Organisation',
              membershipYear: targetYear,
              tierLabel: simResult.tierLabel,
              finalCost: simResult.finalCost,
              currency: simResult.currency || 'GBP',
              reference,
              vatRate: simResult.matchedBand?.vat_rate || null,
            });
          } catch (xeroErr) {
            console.error('[Member Fees] Xero invoice failed (non-fatal):', xeroErr.message);
          }
        }

        try {
          const invoiceNote = xeroInvoice
            ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
            : recordCreated ? ' Xero invoice could not be created.' : '';
          await supabase.from('organization_note').insert({
            organization_id: organizationId,
            member_id: sessionMember.id,
            content: `[Membership Fee - Portal Payment] Payment received for ${targetYear}. Amount: ${simResult.currency || 'GBP'} ${simResult.finalCost?.toFixed(2)}. Stripe PI: ${paymentIntentId}.${invoiceNote}`,
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
    console.error('[Member Fees] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
