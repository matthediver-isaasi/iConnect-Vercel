import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import crypto from 'crypto';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

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
    const { organizationId, membershipYear, recipientEmail } = req.body;

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
    const finalCost = simResult.finalCost;
    const currency = simResult.currency || 'GBP';
    const tierLabel = simResult.tierLabel;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('name, slug, logo_url, primary_color')
      .eq('id', tenantId)
      .single();

    let toEmail = recipientEmail;
    if (!toEmail) {
      const { data: primaryContact } = await supabase
        .from('member')
        .select('email')
        .eq('organization_id', organizationId)
        .eq('is_primary_contact', true)
        .limit(1)
        .maybeSingle();

      toEmail = primaryContact?.email;
    }

    if (!toEmail) {
      return res.status(400).json({ error: 'No recipient email provided and no primary contact found for this organisation' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
      rolloverDiscount: simResult.rolloverDiscount || 0,
      proRataEnabled: simResult.proRataEnabled,
      overrideType: simResult.overrideType || null,
    };

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

    const { error: tokenError } = await supabase
      .from('membership_fee_token')
      .insert({
        token,
        tenant_id: tenantId,
        organization_id: organizationId,
        membership_year: yearLabel,
        status: 'pending',
        final_cost: finalCost,
        currency,
        tier_label: tierLabel,
        cost_breakdown: costBreakdown,
        po_number: poNumber,
        recipient_email: toEmail,
        expires_at: expiresAt.toISOString(),
      });

    if (tokenError) {
      console.error('[Email Fees] Error creating token:', tokenError);
      return res.status(500).json({ error: 'Failed to create payment token' });
    }

    const tenantSlug = tenant?.slug;
    const paymentUrl = tenantSlug
      ? `https://${tenantSlug}.${APP_DOMAIN}/membership-fees/${token}`
      : `https://${APP_DOMAIN}/membership-fees/${token}`;

    const tenantName = tenant?.name || 'Organisation';
    const primaryColor = tenant?.primary_color || '#5C0085';

    const currencySymbol = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' }[currency] || currency;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${tenant?.logo_url ? `<div style="text-align: center; padding: 20px 0;"><img src="${tenant.logo_url}" alt="${tenantName}" style="max-height: 60px;" /></div>` : ''}
        <div style="padding: 20px; border: 1px solid #e5e5e5; border-radius: 8px;">
          <h2 style="color: ${primaryColor}; margin-top: 0;">Membership Fee for ${yearLabel}</h2>
          <p>Dear ${org.name},</p>
          <p>Your membership fee for the period <strong>${yearLabel}</strong> has been calculated:</p>
          <div style="background: #f9f9f9; padding: 16px; border-radius: 6px; margin: 16px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 4px 0; color: #666;">Tier</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 600;">${tierLabel || 'Standard'}</td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #666;">Total Fee</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 700; font-size: 18px;">${currencySymbol}${finalCost.toFixed(2)}</td>
              </tr>
            </table>
          </div>
          <p>You can provide a Purchase Order number or make an immediate payment using the link below:</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${paymentUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">View & Pay Membership Fee</a>
          </div>
          <p style="color: #999; font-size: 12px;">This link expires on ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
      </div>
    `;

    const emailResult = await sendTenantEmail({
      tenantId,
      to: toEmail,
      subject: `Membership Fee for ${yearLabel} - ${tenantName}`,
      html: emailHtml,
    });

    if (!emailResult.success) {
      console.error('[Email Fees] Email send failed:', emailResult.error);
      return res.status(500).json({ error: `Failed to send email: ${emailResult.error}` });
    }

    try {
      const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
      await supabase.from('organization_note').insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Fee Email] Fee notification sent to ${toEmail} for ${yearLabel}. Amount: ${currencySymbol}${finalCost.toFixed(2)}.`,
        attachments: [],
      });
    } catch {}

    return res.json({
      success: true,
      sentTo: toEmail,
      membershipYear: yearLabel,
      finalCost,
      token,
      paymentUrl,
      message: `Fee notification sent to ${toEmail}`,
    });
  } catch (error) {
    console.error('[Email Fees] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
