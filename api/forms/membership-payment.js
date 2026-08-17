import { supabase } from '../_lib/database.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { resolveInvoiceAddress } from '../_lib/invoiceAddressResolver.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import { buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { resolveDdOffer } from '../_lib/gocardlessDirectDebit.js';
import { getGocardlessCredentials } from '../_lib/gocardlessCredentials.js';

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

async function getStripePublishableKey(tenantId) {
  try {
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

  let fieldOverrides = {};
  let explicitConfigId = null;
  try {
    if (req.query.fieldOverrides) fieldOverrides = JSON.parse(req.query.fieldOverrides);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid fieldOverrides parameter' });
  }
  if (req.query.configId) explicitConfigId = req.query.configId;

  const simOptions = { source: 'form-payment', mode: 'manual', fieldOverrides, configId: explicitConfigId };
  const simResult = isMemberScoped
    ? await simulateMembershipForMember(tenantId, member.id, simOptions)
    : await simulateMembershipForOrg(tenantId, organizationId, simOptions);

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
  const stripePublishableKey = tierHasOnlineCardPayment ? await getStripePublishableKey(tenantId) : null;
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
    directDebit: await resolveDirectDebitOption(isMemberScoped, tenantId, simResult),
    cardMonthly: await resolveCardMonthlyOption(isMemberScoped, tenantId, simResult),
    existingRecord: existingRecord ? {
      id: existingRecord.id,
      status: existingRecord.status,
      paymentMethod: existingRecord.payment_method,
    } : null,
    approvalPending: approvalInfo.blocked || false,
    approvalMessage: approvalInfo.blocked ? approvalInfo.message : null,
  });
}

// Phase 2 offered monthly Direct Debit to individual memberships; Phase 3
// extends it to organisational memberships (with a payer choice on the
// frontend). Offered when the tier config enables it AND the tenant has
// usable GoCardless credentials. Returns the offer object (tagged with
// scope) or null.
async function resolveDirectDebitOption(isMemberScoped, tenantId, simResult) {
  const offer = resolveDdOffer(simResult);
  if (!offer) return null;
  try {
    const creds = await getGocardlessCredentials(tenantId);
    if (!creds?.accessToken) return null;
  } catch {
    return null;
  }
  return { ...offer, scope: isMemberScoped ? 'member' : 'organization' };
}

// Task #3620 — monthly card (Stripe subscription) option. Member-scoped
// only, offered when the tier config enables it AND the tenant has usable
// Stripe membership credentials.
async function resolveCardMonthlyOption(isMemberScoped, tenantId, simResult) {
  if (!isMemberScoped) return null;
  const { resolveCardMonthlyOffer } = await import('../_lib/stripeMonthlyCard.js');
  const offer = resolveCardMonthlyOffer(simResult);
  if (!offer) return null;
  try {
    const { getStripeCredentials } = await import('../_lib/stripeCredentials.js');
    const creds = await getStripeCredentials(tenantId, 'membership');
    if (!creds?.secret_key) return null;
  } catch {
    return null;
  }
  return { ...offer, scope: 'member' };
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

  let fieldOverrides = {};
  let explicitConfigId = null;
  try {
    if (req.body.fieldOverrides) {
      fieldOverrides = typeof req.body.fieldOverrides === 'string' ? JSON.parse(req.body.fieldOverrides) : req.body.fieldOverrides;
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid fieldOverrides parameter' });
  }
  if (req.body.configId) explicitConfigId = req.body.configId;

  if (action === 'create_payment') {
    const simOptions = { source: 'form-payment-create', mode: 'manual', fieldOverrides, configId: explicitConfigId };
    const simResult = isMemberScoped
      ? await simulateMembershipForMember(tenantId, member.id, simOptions)
      : await simulateMembershipForOrg(tenantId, organizationId, simOptions);

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

    // Double-payment guard (provider-independent): an open monthly plan
    // agreement (card OR Direct Debit) for this membership year blocks the
    // one-off annual PaymentIntent.
    if (isMemberScoped) {
      const { annualPaymentBlockedByOpenPlan } = await import('../membership/monthly-card.js');
      const blocked = await annualPaymentBlockedByOpenPlan({
        tenantId,
        memberId: member.id,
        yearLabel: simResult.membershipYear?.label,
      });
      if (blocked) {
        return res.status(409).json({
          error: 'A monthly payment plan already exists for this membership year. Please continue with the plan, or contact your administrator to cancel it before paying annually.',
          code: 'open_plan_exists',
          provider: blocked.provider,
        });
      }
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
    const { paymentIntentId, membershipYear: confirmYear, invoice_address: formInvoiceAddress } = req.body;
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

    const { retrieveTenantPaymentIntent } = await import('../_lib/stripeCredentials.js');

    // Task #3278 — mode-flip resilient PI lookup: if the tenant's
    // stripe_mode_membership was flipped mid-session, the PI lives in the
    // other mode's account; retrieve it there instead of 500ing on
    // resource_missing while the card was charged.
    let retrieved;
    try {
      retrieved = await retrieveTenantPaymentIntent(tenantId, 'membership', paymentIntentId);
    } catch (retrieveErr) {
      console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [FormPayment] Could not retrieve PI ${paymentIntentId} in either Stripe mode (tenant ${tenantId}, member ${member.id}): ${retrieveErr.message}`);
      return res.status(500).json({ error: 'We could not verify your payment with Stripe. If your card was charged (you received a Stripe receipt), your membership will be reconciled automatically — please do not pay again. Otherwise, please retry.' });
    }
    if (!retrieved) {
      return res.status(503).json({ error: 'Payment verification not available' });
    }
    const { paymentIntent, stripe } = retrieved;

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not been completed', status: paymentIntent.status });
    }

    // From here on the charge HAS succeeded — any rejection below must be
    // logged distinctly and must tell the payer the charge went through and
    // will be reconciled (Task #3278), never imply the payment failed.
    const confirmFailure = (reason, extra = {}) => {
      console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [FormPayment] Succeeded PI ${paymentIntentId} could not be recorded: ${reason}`, JSON.stringify({ tenantId, memberId: member.id, organizationId: organizationId || null, ...extra }));
      return res.status(400).json({
        error: 'Your card payment was successful and you will receive a Stripe receipt, but we could not finish updating your membership record automatically. It will be reconciled by the administrator shortly — please do NOT pay again.',
        paymentSucceeded: true,
        reason,
      });
    };

    if (paymentIntent.metadata?.member_id !== member.id) {
      return confirmFailure('metadata member_id mismatch', { piMemberId: paymentIntent.metadata?.member_id });
    }

    if (paymentIntent.metadata?.tenant_id !== tenantId) {
      return confirmFailure('metadata tenant_id mismatch', { piTenantId: paymentIntent.metadata?.tenant_id });
    }

    const targetYear = confirmYear || paymentIntent.metadata?.membership_year;

    const confirmSimOptions = { source: 'form-payment-confirm', mode: 'manual', targetYear, fieldOverrides, configId: explicitConfigId };
    const simResult = isMemberScoped
      ? await simulateMembershipForMember(tenantId, member.id, confirmSimOptions)
      : await simulateMembershipForOrg(tenantId, organizationId, confirmSimOptions);

    if (!simResult.success) {
      return confirmFailure(`simulation failed during confirm: ${simResult.error || 'unknown'}`, { simSteps: simResult.steps });
    }

    const confirmChargeTotal = simResult.totalWithVat || simResult.finalCost;
    const expectedAmount = Math.round(confirmChargeTotal * 100);
    if (paymentIntent.amount !== expectedAmount) {
      return confirmFailure(`amount mismatch: expected ${expectedAmount}, PI charged ${paymentIntent.amount}`);
    }

    let recordCreated = false;
    // True only when THIS request inserted the history row — gates the
    // membership-paid workflow so a retried/concurrent confirm (idempotent
    // return above, or 23505 duplicate below) never fires it twice.
    let newlyCreated = false;
    const paidAtIso = new Date().toISOString();
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
        vat_rate_percent: simResult.vatRatePercent || null,
        vat_amount: simResult.vatAmount || 0,
        total_with_vat: simResult.totalWithVat || simResult.finalCost,
        year_number: simResult.yearNumber || null,
        prorata_days: simResult.prorataDays || null,
        free_period_days_applied: simResult.freePeriodDaysApplied || 0,
        override_applied: simResult.overrideApplied || false,
        override_type: simResult.overrideType || null,
        payment_method: 'stripe',
        stripe_payment_intent_id: paymentIntentId,
        status: 'active',
        // Card payments are settled immediately — mark the row paid at
        // creation so the reconciliation cron never re-processes it (and
        // never double-fires the membership-paid workflow).
        payment_status: 'paid',
        paid_at: paidAtIso,
        notes: `Payment received via Stripe (form). PI: ${paymentIntentId}. Member: ${member.id}`,
      };

      const { error: insertError } = await supabase
        .from(historyTable)
        .insert(insertData);

      if (!insertError) {
        recordCreated = true;
        newlyCreated = true;
      } else if (insertError.code === '23505') {
        console.log(`[FormPayment] Duplicate constraint hit for PI ${paymentIntentId} - already processed`);
        recordCreated = true;
      } else {
        // Task #3278 — do NOT auto-refund here: the charge succeeded and
        // the Stripe membership webhook / reconcile cron will record it
        // (reconstructing the row if needed). Refunding would race the
        // webhook and could produce a refunded-but-paid membership.
        console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [FormPayment] History insert failed after succeeded PI ${paymentIntentId}: ${insertError.message}`, JSON.stringify({ tenantId, memberId: member.id, code: insertError.code }));
        return res.status(500).json({
          error: 'Your card payment was successful and you will receive a Stripe receipt, but we could not finish updating your membership record automatically. It will be reconciled by the administrator shortly — please do NOT pay again.',
          paymentSucceeded: true,
        });
      }
    }

    let xeroInvoice = null;
    let accountingSyncError = null;
    if (recordCreated) {
      try {
        const { getAccountingProvider } = await import('../_lib/accountingProvider.js');
        const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Member';

        let invoiceOrgName, invoicingAddress, invoicingEmail;
        if (isMemberScoped) {
          invoiceOrgName = memberName;
          invoicingEmail = member.email || null;
          invoicingAddress = formInvoiceAddress || await resolveInvoiceAddress(supabase, simResult.config, member.id, 'member');
        } else {
          const { data: org } = await supabase
            .from('organization')
            .select('name, invoicing_address, invoicing_email')
            .eq('id', organizationId)
            .single();
          invoiceOrgName = org?.name || 'Organisation';
          invoicingEmail = org?.invoicing_email || null;
          invoicingAddress = formInvoiceAddress || await resolveInvoiceAddress(supabase, simResult.config, organizationId, 'organization');
        }

        const reference = `Membership ${targetYear}`;

        const _provider = await getAccountingProvider(tenantId);
        xeroInvoice = await _provider.createMembershipInvoice({
          appTenantId: tenantId,
          organizationName: invoiceOrgName,
          invoicingEmail,
          invoicingAddress: invoicingAddress || undefined,
          membershipYear: targetYear,
          tierLabel: simResult.tierLabel,
          finalCost: simResult.finalCost,
          currency: simResult.currency || 'GBP',
          reference,
          vatRate: simResult.taxType || simResult.matchedBand?.vat_rate || null,
          nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
          markAsPaid: true,
          stripePaymentIntentId: paymentIntentId,
          invoiceDescription: simResult.config?.invoice_description || null,
        });
        if (xeroInvoice && xeroInvoice.invoice_id) {
          try {
            await supabase
              .from(historyTable)
              .update(buildInvoiceColumnUpdate(xeroInvoice))
              .eq('stripe_payment_intent_id', paymentIntentId)
              .eq('tenant_id', tenantId);
            console.log(`[FormPayment] Updated history record with invoice ${xeroInvoice.invoice_number}`);
          } catch (updateErr) {
            console.error('[FormPayment] Failed to update history with Xero invoice (non-fatal):', updateErr.message);
          }
        }
      } catch (xeroErr) {
        // Task #1112 — was silently swallowed. Flag the history row so the
        // admin UI shows a retry affordance and the warning surfaces in the
        // API response.
        console.error('[FormPayment] Accounting invoice failed for PI ' + paymentIntentId + ':', xeroErr);
        accountingSyncError = xeroErr?.message || String(xeroErr) || 'Unknown accounting provider error';
        try {
          await supabase
            .from(historyTable)
            .update({
              accounting_sync_status: 'failed',
              accounting_sync_error: accountingSyncError.slice(0, 1000),
            })
            .eq('stripe_payment_intent_id', paymentIntentId)
            .eq('tenant_id', tenantId);
        } catch (flagErr) {
          console.error('[FormPayment] Failed to flag accounting_sync_status on history row:', flagErr.message);
        }
      }
    }

    // Task #3110 — fire admin-configured "membership paid" workflows
    // (field_change on payment_status unpaid->paid) for card payments.
    // Fired on Stripe success regardless of accounting-sync outcome, gated
    // on newlyCreated so retries/concurrent confirms never double-fire.
    // Never allowed to break the payment response.
    if (newlyCreated) {
      try {
        const { fireWorkflowForPaidRow } = await import('../_lib/membershipPaymentReconciliation.js');
        const { data: historyRow } = await supabase
          .from(historyTable)
          .select('*')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (historyRow) {
          const baseUrl = req.headers.host
            ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
            : '';
          await fireWorkflowForPaidRow({
            table: historyTable,
            row: historyRow,
            snapshot: { paidAt: historyRow.paid_at || paidAtIso },
            baseUrl,
            source: 'membership_card_payment_confirm',
          });
        } else {
          console.warn(`[FormPayment] Could not reload history row for PI ${paymentIntentId}; membership-paid workflow not fired`);
        }
      } catch (wfErr) {
        console.error(`[FormPayment] Membership-paid workflow trigger failed for PI ${paymentIntentId} (non-fatal):`, wfErr.message);
      }
    }

    const noteTable = isMemberScoped ? 'member_note' : 'organization_note';
    const noteIdCol = isMemberScoped ? 'member_id' : 'organization_id';
    try {
      const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Member';
      const invoiceNote = xeroInvoice
        ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
        : recordCreated ? ` Accounting invoice could not be created${accountingSyncError ? ` (${accountingSyncError})` : ''}; flagged for admin retry.` : '';
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
      accountingSyncError: accountingSyncError || null,
      warning: accountingSyncError
        ? 'Your payment was received and your membership is recorded, but the accounting invoice could not be generated automatically. The administrator has been notified and will issue it manually.'
        : null,
      message: 'Payment confirmed successfully',
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
