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
      .select('id, organization_id, tenant_id, email, first_name, last_name')
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
        const { data: stripeSetting } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'membership_stripe_enabled')
          .eq('tenant_id', tenantId)
          .maybeSingle();

        const stripeSettingEnabled = stripeSetting?.setting_value !== 'false';

        if (stripeSettingEnabled) {
          const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
          const creds = await getStripeCredentials(tenantId);
          if (creds?.is_enabled && creds?.publishable_key) {
            stripePublishableKey = creds.publishable_key;
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
        .select('id, status, payment_method, stripe_payment_intent_id, annual_cost, prorata_cost, free_period_discount, rollover_discount, custom_discount_total, custom_discount_details, final_cost, tier_label, field_value, currency, billing_period')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .eq('membership_year', simResult.membershipYear?.label)
        .maybeSingle();

      const approvalInfo = await checkMemberFeesApproval(tenantId, organizationId, simResult.membershipYear?.label);

      let finalCost, currency, tierLabel, costBreakdown, vatRatePercent, vatAmount, totalWithVat;

      if (existingRecord) {
        const recAnnual = parseFloat(existingRecord.annual_cost);
        const recProrata = existingRecord.prorata_cost != null ? parseFloat(existingRecord.prorata_cost) : null;
        const recFreeDiscount = parseFloat(existingRecord.free_period_discount || 0);
        const recRollover = parseFloat(existingRecord.rollover_discount || 0);
        const recCustomTotal = parseFloat(existingRecord.custom_discount_total || 0);
        const hasProRata = recProrata !== null && recProrata !== recAnnual;

        let recProrataDays = null;
        if (hasProRata && simResult.goLiveDate && simResult.membershipYear) {
          const joinMidnight = new Date(simResult.goLiveDate);
          joinMidnight.setHours(0, 0, 0, 0);
          const yearEndMidnight = new Date(simResult.membershipYear.end);
          yearEndMidnight.setHours(0, 0, 0, 0);
          recProrataDays = Math.max(0, Math.floor((yearEndMidnight - joinMidnight) / (1000 * 60 * 60 * 24)) + 1);
        }

        finalCost = parseFloat(existingRecord.final_cost);
        currency = existingRecord.currency || simResult.currency || 'GBP';
        tierLabel = existingRecord.tier_label || simResult.tierLabel;

        vatRatePercent = simResult.vatRatePercent || null;
        vatAmount = vatRatePercent ? parseFloat((finalCost * vatRatePercent / 100).toFixed(2)) : 0;
        totalWithVat = parseFloat((finalCost + vatAmount).toFixed(2));

        costBreakdown = {
          annualCostBeforeDiscounts: recCustomTotal > 0 ? parseFloat((recAnnual + recCustomTotal).toFixed(2)) : recAnnual,
          customDiscountTotal: recCustomTotal,
          customDiscountDetails: existingRecord.custom_discount_details || [],
          annualCost: recAnnual,
          proRataEnabled: hasProRata,
          prorataDays: hasProRata ? recProrataDays : null,
          prorataCost: hasProRata ? recProrata : null,
          freeDiscount: recFreeDiscount,
          rolloverDiscount: recRollover,
          freePeriodAmount: simResult.freePeriodAmount,
          freePeriodUnit: simResult.freePeriodUnit,
          freePeriodDaysApplied: simResult.freePeriodDaysApplied || 0,
          yearNumber: simResult.yearNumber,
          dailyCost: simResult.dailyCost,
        };
      } else {
        finalCost = simResult.finalCost;
        currency = simResult.currency || 'GBP';
        tierLabel = simResult.tierLabel;
        vatRatePercent = simResult.vatRatePercent || null;
        vatAmount = simResult.vatAmount || 0;
        totalWithVat = simResult.totalWithVat || finalCost;
        costBreakdown = {
          annualCostBeforeDiscounts: simResult.annualCostBeforeDiscounts,
          customDiscountTotal: simResult.customDiscountTotal || 0,
          customDiscountDetails: simResult.customDiscountDetails || [],
          annualCost: simResult.annualCost,
          proRataEnabled: simResult.proRataEnabled,
          prorataDays: simResult.prorataDays,
          prorataCost: simResult.prorataCost,
          freeDiscount: simResult.freeDiscount || 0,
          rolloverDiscount: simResult.rolloverDiscount || 0,
          freePeriodAmount: simResult.freePeriodAmount,
          freePeriodUnit: simResult.freePeriodUnit,
          freePeriodDaysApplied: simResult.freePeriodDaysApplied || 0,
          yearNumber: simResult.yearNumber,
          dailyCost: simResult.dailyCost,
        };
      }

      return res.json({
        organizationName: org?.name || 'Organisation',
        membershipYear: simResult.membershipYear?.label,
        finalCost,
        vatRatePercent,
        vatAmount,
        totalWithVat,
        currency,
        tierLabel,
        costBreakdown,
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
        approvalPending: approvalInfo.blocked || false,
        approvalMessage: approvalInfo.blocked ? approvalInfo.message : null,
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
        const poApprovalCheck = await checkMemberFeesApproval(tenantId, organizationId, targetYear);
        if (poApprovalCheck.blocked) {
          return res.status(400).json({ error: poApprovalCheck.message || 'Fees have not yet been approved. Please contact your administrator.' });
        }
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
            .update({ purchase_order_number: poNumber.trim(), po_source: 'member' })
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
              po_source: 'member',
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

        const approvalStatus = await checkMemberFeesApproval(tenantId, organizationId, simResult.membershipYear?.label);
        if (approvalStatus.blocked) {
          return res.status(400).json({ error: approvalStatus.message });
        }

        const { getStripeCredentials, findOrCreateStripeCustomer } = await import('../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(tenantId);
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment processing is not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const chargeAmount = simResult.totalWithVat || simResult.finalCost;
        const amount = Math.round(chargeAmount * 100);
        const currency = (simResult.currency || 'GBP').toLowerCase();
        const STRIPE_MIN_CENTS = { gbp: 30, usd: 50, eur: 50, aud: 50, nzd: 50 };
        const minCents = STRIPE_MIN_CENTS[currency] || 50;
        if (amount < minCents) {
          return res.status(400).json({ error: `Amount is below the minimum charge for ${currency.toUpperCase()}` });
        }

        const { data: org } = await supabase
          .from('organization')
          .select('name')
          .eq('id', organizationId)
          .single();

        const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
        const stripeCustomer = await findOrCreateStripeCustomer(stripe, {
          email: member.email,
          name: memberName,
          metadata: { tenant_id: tenantId, organization_id: organizationId, organization_name: org?.name || '' },
        });

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency,
          customer: stripeCustomer?.id || undefined,
          receipt_email: member.email || undefined,
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
          amount: chargeAmount,
          netAmount: simResult.finalCost,
          vatAmount: simResult.vatAmount || 0,
          vatRatePercent: simResult.vatRatePercent || null,
          currency: simResult.currency || 'GBP',
          membershipYear: simResult.membershipYear?.label,
        });
      }

      if (action === 'confirm_payment') {
        const { paymentIntentId, membershipYear: confirmYear } = req.body;
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'paymentIntentId is required' });
        }

        const confirmApprovalCheck = await checkMemberFeesApproval(tenantId, organizationId, confirmYear);
        if (confirmApprovalCheck.blocked) {
          return res.status(400).json({ error: confirmApprovalCheck.message || 'Fees have not yet been approved for payment. Please contact your administrator.' });
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

        const confirmChargeTotal = simResult.totalWithVat || simResult.finalCost;
        const expectedAmount = Math.round(confirmChargeTotal * 100);
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
              .select('name, invoicing_address')
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
              ? `Membership ${targetYear} - PO: ${poNum}`
              : `Membership ${targetYear}`;

            xeroInvoice = await createXeroMembershipInvoice({
              appTenantId: tenantId,
              organizationName: org?.name || 'Organisation',
              invoicingAddress: org?.invoicing_address,
              membershipYear: targetYear,
              tierLabel: simResult.tierLabel,
              finalCost: simResult.finalCost,
              currency: simResult.currency || 'GBP',
              reference,
              vatRate: simResult.matchedBand?.vat_rate || null,
              markAsPaid: true,
              stripePaymentIntentId: paymentIntentId,
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
            content: `[Membership Fee - Portal Payment] Payment received for ${targetYear}. Amount: ${simResult.currency || 'GBP'} ${confirmChargeTotal.toFixed(2)}${simResult.vatAmount > 0 ? ` (incl. VAT ${simResult.vatAmount.toFixed(2)})` : ''}. Stripe PI: ${paymentIntentId}.${invoiceNote}`,
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

async function checkMemberFeesApproval(tenantId, organizationId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (setting?.setting_value !== 'true') return { blocked: false };

    const { data: invoicing } = await supabase
      .from('organisation_membership_invoicing')
      .select('fees_approved')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYearLabel)
      .maybeSingle();

    if (invoicing?.fees_approved) return { blocked: false };

    const { data: msgSetting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_custom_message')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const message = msgSetting?.setting_value || 'Your membership fees are currently being reviewed. You will be notified when they are ready for payment.';
    return { blocked: true, message };
  } catch {
    return { blocked: false };
  }
}
