import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import { sendMembershipFeeTokenEmail } from '../_lib/membershipFeeTokenEmail.js';
import { loadAddonLines, computeAddonTotals, buildAddonDisplayLines } from '../_lib/membershipAddons.js';

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
    const { organizationId, membershipYear, recipientEmail, recipientEmails } = req.body;

    if (!organizationId) {
      return res.status(400).json({ error: 'organizationId is required' });
    }

    const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
      source: 'email-fees',
      mode: 'manual',
      targetYear: membershipYear || null,
    });

    if (!simResult.success) {
      return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
    }

    const org = simResult.org;
    const yearLabel = simResult.membershipYear?.label;

    // Approved add-on lines (Training Fund top-ups, freeform) are invoiced
    // alongside the membership fee, so the fee email / PO page must show
    // and total them too.
    const addonLines = await loadAddonLines(tenantId, organizationId, yearLabel);
    const addonTotals = computeAddonTotals(addonLines);

    const finalCost = Math.round(((simResult.finalCost || 0) + addonTotals.subtotal) * 100) / 100;
    const currency = simResult.currency || 'GBP';
    const tierLabel = simResult.tierLabel;
    const stripeEnabled = !!simResult.config?.online_card_payment;

    let toEmails = [];
    if (recipientEmails && Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      toEmails = [...new Set(recipientEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    } else if (recipientEmail) {
      toEmails = [recipientEmail.trim().toLowerCase()];
    }

    let poNumber = null;
    try {
      const { data: invoicingSetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq('organization_id', organizationId)
        .eq('membership_year', yearLabel)
        .maybeSingle();
      poNumber = invoicingSetting?.purchase_order_number || null;
    } catch {}

    const costBreakdown = {
      annualCost: simResult.annualCost,
      annualCostBeforeDiscounts: simResult.annualCostBeforeDiscounts,
      customDiscountTotal: simResult.customDiscountTotal || 0,
      customDiscountDetails: simResult.customDiscountDetails || [],
      prorataCost: simResult.prorataCost,
      prorataDays: simResult.prorataDays,
      dailyCost: simResult.dailyCost,
      freeDiscount: simResult.freeDiscount || 0,
      freePeriodDaysApplied: simResult.freePeriodDaysApplied || 0,
      freePeriodAmount: simResult.freePeriodAmount,
      freePeriodUnit: simResult.freePeriodUnit,
      yearNumber: simResult.yearNumber,
      rolloverDiscount: simResult.rolloverDiscount || 0,
      proRataEnabled: simResult.proRataEnabled,
      overrideType: simResult.overrideType || null,
      overrideDiscountType: simResult.overrideDiscountType || null,
      overrideDiscountValue: simResult.overrideDiscountValue || null,
      vatRatePercent: simResult.vatRatePercent || null,
      vatAmount: Math.round(((simResult.vatAmount || 0) + addonTotals.vat) * 100) / 100,
      totalWithVat: Math.round(((simResult.totalWithVat || simResult.finalCost || 0) + addonTotals.total) * 100) / 100,
      taxLabel: simResult.taxLabel || null,
      ...(addonLines.length > 0 ? { addonLines: buildAddonDisplayLines(addonLines) } : {}),
    };

    const result = await sendMembershipFeeTokenEmail({
      client: supabase,
      tenantId,
      organizationId,
      organizationName: org.name,
      membershipYear: yearLabel,
      finalCost,
      currency,
      tierLabel,
      costBreakdown,
      poNumber,
      recipientEmails: toEmails,
      tierConfig: simResult.config,
      stripeEnabled,
    });

    if (!result.success) {
      const status = result.error === 'No recipient email available' ? 400 : 500;
      return res.status(status).json({ error: result.error || 'Failed to send fee email' });
    }

    const currencySymbol = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' }[currency] || currency;
    try {
      const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
      await supabase.from('organization_note').insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Fee Email] Fee notification sent to ${result.sentTo.join(', ')} for ${yearLabel}. Amount: ${currencySymbol}${parseFloat(finalCost).toFixed(2)}.`,
        attachments: [],
      });
    } catch {}

    return res.json({
      success: true,
      sentTo: result.sentTo,
      membershipYear: yearLabel,
      finalCost,
      token: result.token,
      paymentUrl: result.paymentUrl,
      message: `Fee notification sent to ${result.sentTo.join(', ')}${result.failed && result.failed.length ? `. Failed: ${result.failed.join(', ')}` : ''}`,
    });
  } catch (error) {
    console.error('[Email Fees] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
