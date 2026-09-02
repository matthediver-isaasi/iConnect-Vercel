import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { sendMembershipFeeTokenEmail } from '../_lib/membershipFeeTokenEmail.js';
import { loadAddonLines, computeAddonTotals, buildAddonDisplayLines } from '../_lib/membershipAddons.js';
import { resolveMemberFeeApproval } from '../_lib/membershipFeeApproval.js';

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
    const { organizationId, memberId, membershipYear, recipientEmail, recipientEmails } = req.body;

    if (!organizationId && !memberId) {
      return res.status(400).json({ error: 'organizationId or memberId is required' });
    }
    if (organizationId && memberId) {
      return res.status(400).json({ error: 'Provide either organizationId or memberId, not both' });
    }

    const isMemberScoped = !!memberId;
    const simResult = isMemberScoped
      ? await simulateMembershipForMember(tenantId, memberId, {
          source: 'email-fees',
          mode: 'manual',
          targetYear: membershipYear || null,
        })
      : await simulateMembershipForOrg(tenantId, organizationId, {
          source: 'email-fees',
          mode: 'manual',
          targetYear: membershipYear || null,
        });

    if (!simResult.success) {
      return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
    }

    const yearLabel = simResult.membershipYear?.label;
    if (!yearLabel) {
      return res.status(400).json({ error: 'Could not determine the membership year for this fee calculation' });
    }

    // Emailing a fee must never create a second invitation for a year that has
    // already been recorded. The public payment page has its own guard too,
    // but rejecting here gives the admin an actionable explanation.
    if (isMemberScoped && simResult.existingRecord) {
      return res.status(409).json({
        error: `A membership record for ${yearLabel} already exists; fees cannot be emailed for this year`,
        code: 'membership_year_already_exists',
      });
    }

    let entityName;
    let toEmails = [];
    if (isMemberScoped) {
      const member = simResult.member;
      entityName = member?.name || 'Member';
      const memberEmail = (member?.email || '').trim().toLowerCase();
      if (memberEmail) toEmails = [memberEmail];

      const approval = await resolveMemberFeeApproval(supabase, {
        tenantId,
        memberId,
        membershipYear: yearLabel,
      });
      if (approval.required && !approval.approved) {
        return res.status(400).json({
          error: 'Fees must be approved before sending the fee email. Use the Approve Fees button first.',
          code: 'membership_fees_not_approved',
        });
      }
    } else {
      entityName = simResult.org?.name || 'Organisation';
      if (recipientEmails && Array.isArray(recipientEmails) && recipientEmails.length > 0) {
        toEmails = [...new Set(recipientEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
      } else if (recipientEmail) {
        toEmails = [recipientEmail.trim().toLowerCase()];
      }
    }

    // Approved add-on lines (Training Fund top-ups, freeform) are invoiced
    // alongside the membership fee, so the fee email / PO page must show
    // and total them too.
    const addonLines = isMemberScoped ? [] : await loadAddonLines(tenantId, organizationId, yearLabel);
    const addonTotals = computeAddonTotals(addonLines);

    const finalCost = Math.round(((simResult.finalCost || 0) + addonTotals.subtotal) * 100) / 100;
    const currency = simResult.currency || 'GBP';
    const tierLabel = simResult.tierLabel;
    const stripeEnabled = !!simResult.config?.online_card_payment;

    let poNumber = null;
    if (!isMemberScoped) {
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
    }

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
      organizationId: isMemberScoped ? null : organizationId,
      memberId: isMemberScoped ? memberId : null,
      organizationName: entityName,
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
      const noteContent = `[Membership Fee Email] Fee notification sent to ${result.sentTo.join(', ')} for ${yearLabel}. Amount: ${currencySymbol}${parseFloat(finalCost).toFixed(2)}.`;
      if (isMemberScoped) {
        await supabase.from('member_note').insert({
          target_member_id: memberId,
          author_member_id: noteCreatorId,
          content: noteContent,
          attachments: [],
        });
      } else {
        await supabase.from('organization_note').insert({
          organization_id: organizationId,
          member_id: noteCreatorId,
          content: noteContent,
          attachments: [],
        });
      }
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
