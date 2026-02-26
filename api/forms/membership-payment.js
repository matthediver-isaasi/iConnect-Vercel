import { supabase } from '../_lib/database.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    let resolvedTenantId = null;
    try {
      const tenantData = await resolveTenantFromRequest(req);
      resolvedTenantId = tenantData?.id || null;
    } catch (e) {
      console.log('[FormMembershipPayment] Tenant resolution failed (will use member tenant_id):', e.message);
    }

    if (req.method === 'GET') {
      return handleGet(req, res, resolvedTenantId);
    }
    if (req.method === 'POST') {
      return handlePost(req, res, resolvedTenantId);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[FormMembershipPayment] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function getMemberById(memberId) {
  const { data: member } = await supabase
    .from('member')
    .select('id, organization_id, tenant_id, email, first_name, last_name')
    .eq('id', memberId)
    .single();
  return member;
}

async function getStripePublishableKey(tenantId, skipGlobalCheck = false) {
  try {
    if (!skipGlobalCheck) {
      const { data: stripeSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'membership_stripe_enabled')
        .eq('tenant_id', tenantId)
        .maybeSingle();

      if (stripeSetting?.setting_value === 'false') {
        return null;
      }
    }

    const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
    const creds = await getStripeCredentials(tenantId, 'membership');
    if (creds?.is_enabled && creds?.publishable_key) {
      return creds.publishable_key;
    }
  } catch (err) {
    console.error('[FormMembershipPayment] Error fetching Stripe publishable key:', err.message);
  }
  return null;
}

async function checkApproval(tenantId, memberId, organizationId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (setting?.setting_value !== 'true') return { blocked: false };

    const table = organizationId ? 'organisation_membership_invoicing' : 'member_membership_invoicing';
    const idCol = organizationId ? 'organization_id' : 'member_id';
    const idVal = organizationId || memberId;

    const { data: invoicing } = await supabase
      .from(table)
      .select('fees_approved')
      .eq('tenant_id', tenantId)
      .eq(idCol, idVal)
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

function buildCostResponse(existingRecord, simResult) {
  let finalCost, currency, tierLabel, costBreakdown, vatRatePercent, vatAmount, totalWithVat;

  if (existingRecord) {
    const recAnnual = parseFloat(existingRecord.annual_cost);
    const recProrata = existingRecord.prorata_cost != null ? parseFloat(existingRecord.prorata_cost) : null;
    const recFreeDiscount = parseFloat(existingRecord.free_period_discount || 0);
    const recRollover = parseFloat(existingRecord.rollover_discount || 0);
    const recCustomTotal = parseFloat(existingRecord.custom_discount_total || 0);
    const hasProRata = recProrata !== null && recProrata !== recAnnual;

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
      prorataDays: null,
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

  return { finalCost, currency, tierLabel, costBreakdown, vatRatePercent, vatAmount, totalWithVat };
}

async function handleGet(req, res, resolvedTenantId) {
  const { memberId } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const member = await getMemberById(memberId);
  if (!member?.tenant_id) {
    return res.status(404).json({ error: 'Member not found' });
  }

  if (resolvedTenantId && member.tenant_id !== resolvedTenantId) {
    return res.status(403).json({ error: 'Member does not belong to this tenant' });
  }

  const tenantId = member.tenant_id;
  const organizationId = member.organization_id;
  const isMemberScoped = !organizationId;

  const simResult = isMemberScoped
    ? await simulateMembershipForMember(tenantId, member.id, { source: 'form-payment', mode: 'manual' })
    : await simulateMembershipForOrg(tenantId, organizationId, { source: 'form-payment', mode: 'manual' });

  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
  }

  const historyTable = isMemberScoped ? 'member_membership_history' : 'organisation_membership_history';
  const historyIdCol = isMemberScoped ? 'member_id' : 'organization_id';
  const historyIdVal = isMemberScoped ? member.id : organizationId;

  const { data: existingRecord } = await supabase
    .from(historyTable)
    .select('id, status, payment_method, stripe_payment_intent_id, annual_cost, prorata_cost, free_period_discount, rollover_discount, custom_discount_total, custom_discount_details, final_cost, tier_label, field_value, currency, billing_period')
    .eq('tenant_id', tenantId)
    .eq(historyIdCol, historyIdVal)
    .eq('membership_year', simResult.membershipYear?.label)
    .maybeSingle();

  const tierHasOnlineCardPayment = !!simResult.config?.online_card_payment;
  const stripePublishableKey = await getStripePublishableKey(tenantId, tierHasOnlineCardPayment);
  const approvalInfo = await checkApproval(tenantId, member.id, organizationId, simResult.membershipYear?.label);
  const { finalCost, currency, tierLabel, costBreakdown, vatRatePercent, vatAmount, totalWithVat } = buildCostResponse(existingRecord, simResult);

  let entityName;
  if (isMemberScoped) {
    entityName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Member';
  } else {
    const { data: org } = await supabase
      .from('organization')
      .select('name')
      .eq('id', organizationId)
      .single();
    entityName = org?.name || 'Organisation';
  }

  return res.json({
    entityName,
    memberScoped: isMemberScoped,
    membershipYear: simResult.membershipYear?.label,
    finalCost,
    vatRatePercent,
    vatAmount,
    totalWithVat,
    currency,
    tierLabel,
    costBreakdown,
    stripeEnabled: !!stripePublishableKey,
    stripePublishableKey,
    existingRecord: existingRecord ? {
      id: existingRecord.id,
      status: existingRecord.status,
      paymentMethod: existingRecord.payment_method,
    } : null,
    approvalPending: approvalInfo.blocked || false,
    approvalMessage: approvalInfo.blocked ? approvalInfo.message : null,
  });
}

const STRIPE_MIN_CENTS = { gbp: 30, usd: 50, eur: 50, aud: 50, nzd: 50 };

async function handlePost(req, res, resolvedTenantId) {
  const { action, memberId } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const member = await getMemberById(memberId);
  if (!member?.tenant_id) {
    return res.status(404).json({ error: 'Member not found' });
  }

  if (resolvedTenantId && member.tenant_id !== resolvedTenantId) {
    return res.status(403).json({ error: 'Member does not belong to this tenant' });
  }

  const tenantId = member.tenant_id;
  const organizationId = member.organization_id;
  const isMemberScoped = !organizationId;

  if (action === 'create_payment') {
    const simResult = isMemberScoped
      ? await simulateMembershipForMember(tenantId, member.id, { source: 'form-payment-create', mode: 'manual' })
      : await simulateMembershipForOrg(tenantId, organizationId, { source: 'form-payment-create', mode: 'manual' });

    if (!simResult.success) {
      return res.status(400).json({ error: simResult.error || 'Could not calculate fees' });
    }

    if (simResult.existingRecord) {
      return res.status(400).json({ error: 'A membership record already exists for this period' });
    }

    const approvalStatus = await checkApproval(tenantId, member.id, organizationId, simResult.membershipYear?.label);
    if (approvalStatus.blocked) {
      return res.status(400).json({ error: approvalStatus.message });
    }

    const { getStripeCredentials, findOrCreateStripeCustomer } = await import('../_lib/stripeCredentials.js');
    const Stripe = (await import('stripe')).default;

    const stripeCredentials = await getStripeCredentials(tenantId, 'membership');
    if (!stripeCredentials?.secret_key) {
      return res.status(503).json({ error: 'Payment processing is not available' });
    }

    const stripe = new Stripe(stripeCredentials.secret_key);
    const chargeAmount = simResult.totalWithVat || simResult.finalCost;
    const amount = Math.round(chargeAmount * 100);
    const currency = (simResult.currency || 'GBP').toLowerCase();
    const minCents = STRIPE_MIN_CENTS[currency] || 50;
    if (amount < minCents) {
      return res.status(400).json({ error: `Amount is below the minimum charge for ${currency.toUpperCase()}` });
    }

    const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined;
    const stripeCustomer = await findOrCreateStripeCustomer(stripe, {
      email: member.email,
      name: memberName,
      metadata: {
        tenant_id: tenantId,
        member_id: member.id,
        ...(organizationId ? { organization_id: organizationId } : {}),
      },
    });

    const description = isMemberScoped
      ? `Membership fee for ${memberName || 'Member'} - ${simResult.membershipYear?.label}`
      : `Membership fee - ${simResult.membershipYear?.label}`;

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: stripeCustomer?.id || undefined,
      receipt_email: member.email || undefined,
      metadata: {
        member_id: member.id,
        ...(organizationId ? { organization_id: organizationId } : {}),
        membership_year: simResult.membershipYear?.label,
        tenant_id: tenantId,
        source: 'form-membership-payment',
      },
      description,
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

    const historyTable = isMemberScoped ? 'member_membership_history' : 'organisation_membership_history';
    const historyIdCol = isMemberScoped ? 'member_id' : 'organization_id';
    const historyIdVal = isMemberScoped ? member.id : organizationId;

    const { data: existingByPI } = await supabase
      .from(historyTable)
      .select('id')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (existingByPI) {
      console.log(`[FormPayment] Idempotent return: record already exists for PI ${paymentIntentId}`);
      return res.json({ success: true, already_processed: true, recordCreated: true, message: 'Payment already confirmed' });
    }

    const approvalCheck = await checkApproval(tenantId, member.id, organizationId, confirmYear);
    if (approvalCheck.blocked) {
      return res.status(400).json({ error: approvalCheck.message || 'Fees have not yet been approved for payment.' });
    }

    const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
    const Stripe = (await import('stripe')).default;

    const stripeCredentials = await getStripeCredentials(tenantId, 'membership');
    if (!stripeCredentials?.secret_key) {
      return res.status(503).json({ error: 'Payment verification not available' });
    }

    const stripe = new Stripe(stripeCredentials.secret_key);
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not been completed', status: paymentIntent.status });
    }

    if (paymentIntent.metadata?.member_id !== member.id) {
      return res.status(400).json({ error: 'Payment does not match the specified member' });
    }

    if (paymentIntent.metadata?.tenant_id !== tenantId) {
      return res.status(400).json({ error: 'Payment does not match the tenant' });
    }

    const targetYear = confirmYear || paymentIntent.metadata?.membership_year;

    const simResult = isMemberScoped
      ? await simulateMembershipForMember(tenantId, member.id, { source: 'form-payment-confirm', mode: 'manual', targetYear })
      : await simulateMembershipForOrg(tenantId, organizationId, { source: 'form-payment-confirm', mode: 'manual', targetYear });

    if (!simResult.success) {
      console.error('[FormPayment] Simulation failed during confirm:', simResult.error);
      return res.status(400).json({ error: simResult.error || 'Could not verify membership fees' });
    }

    const confirmChargeTotal = simResult.totalWithVat || simResult.finalCost;
    const expectedAmount = Math.round(confirmChargeTotal * 100);
    if (paymentIntent.amount !== expectedAmount) {
      console.error(`[FormPayment] Amount mismatch: expected ${expectedAmount}, got ${paymentIntent.amount}`);
      return res.status(400).json({ error: 'Payment amount does not match expected fee' });
    }

    let recordCreated = false;
    if (simResult.success && !simResult.existingRecord) {
      const invoiceTable = isMemberScoped ? 'member_membership_invoicing' : 'organisation_membership_invoicing';

      const { data: invoicingSetting } = await supabase
        .from(invoiceTable)
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq(historyIdCol, historyIdVal)
        .eq('membership_year', targetYear)
        .maybeSingle();

      const insertData = {
        tenant_id: tenantId,
        [historyIdCol]: historyIdVal,
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
        notes: `Payment received via Stripe (form). PI: ${paymentIntentId}. Member: ${member.id}`,
      };

      const { error: insertError } = await supabase
        .from(historyTable)
        .insert(insertData);

      if (!insertError) {
        recordCreated = true;
      } else if (insertError.code === '23505') {
        console.log(`[FormPayment] Duplicate constraint hit for PI ${paymentIntentId} - already processed`);
        recordCreated = true;
      } else {
        console.error('[FormPayment] Error creating history record:', insertError);
        try {
          await stripe.refunds.create({
            payment_intent: paymentIntentId,
            reason: 'requested_by_customer',
            metadata: { reason: 'form_membership_record_creation_failed', member_id: member.id }
          });
          console.log(`[FormPayment] Auto-refund issued for PI ${paymentIntentId} after record creation failure`);
        } catch (refundErr) {
          console.error(`[FormPayment] Auto-refund FAILED for PI ${paymentIntentId}:`, refundErr.message);
        }
        return res.status(500).json({ error: 'Failed to create membership record. A refund has been initiated. Please contact support if you do not see it within 5-10 business days.' });
      }
    }

    let xeroInvoice = null;
    if (recordCreated) {
      try {
        const { createXeroMembershipInvoice } = await import('../_lib/xero.js');
        const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Member';

        let invoiceOrgName, invoicingAddress;
        if (isMemberScoped) {
          invoiceOrgName = memberName;
        } else {
          const { data: org } = await supabase
            .from('organization')
            .select('name, invoicing_address')
            .eq('id', organizationId)
            .single();
          invoiceOrgName = org?.name || 'Organisation';
          invoicingAddress = org?.invoicing_address;
        }

        const reference = `Membership ${targetYear}`;

        xeroInvoice = await createXeroMembershipInvoice({
          appTenantId: tenantId,
          organizationName: invoiceOrgName,
          invoicingAddress: invoicingAddress || undefined,
          membershipYear: targetYear,
          tierLabel: simResult.tierLabel,
          finalCost: simResult.finalCost,
          currency: simResult.currency || 'GBP',
          reference,
          vatRate: simResult.matchedBand?.vat_rate || null,
          markAsPaid: true,
          stripePaymentIntentId: paymentIntentId,
          invoiceDescription: simResult.config?.invoice_description || null,
        });
      } catch (xeroErr) {
        console.error('[FormPayment] Xero invoice failed (non-fatal):', xeroErr.message);
      }
    }

    const noteTable = isMemberScoped ? 'member_note' : 'organization_note';
    const noteIdCol = isMemberScoped ? 'member_id' : 'organization_id';
    try {
      const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Member';
      const invoiceNote = xeroInvoice
        ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
        : recordCreated ? ' Xero invoice could not be created.' : '';
      const noteData = {
        [noteIdCol]: isMemberScoped ? member.id : organizationId,
        content: `[Membership Fee - Form Payment] Payment received for ${targetYear}. Amount: ${simResult.currency || 'GBP'} ${confirmChargeTotal.toFixed(2)}${simResult.vatAmount > 0 ? ` (incl. VAT ${simResult.vatAmount.toFixed(2)})` : ''}. Stripe PI: ${paymentIntentId}.${invoiceNote}`,
        attachments: [],
      };
      if (isMemberScoped) {
        noteData.author_member_id = member.id;
      } else {
        noteData.member_id = member.id;
      }
      await supabase.from(noteTable).insert(noteData);
    } catch {}

    return res.json({
      success: true,
      recordCreated,
      historyRecordId: existingByPI?.id || null,
      xeroInvoice: xeroInvoice ? { invoice_number: xeroInvoice.invoice_number } : null,
      message: 'Payment confirmed successfully',
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
