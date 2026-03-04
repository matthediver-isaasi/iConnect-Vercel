import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import crypto from 'crypto';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

let tokenTableEnsured = false;
async function ensureTokenTable() {
  if (tokenTableEnsured) return;
  try {
    const { error: checkError } = await supabase
      .from('membership_fee_token')
      .select('id')
      .limit(1);

    if (!checkError) {
      tokenTableEnsured = true;
      return;
    }

    if (checkError.code === '42P01') {
      await supabase.rpc('exec_sql', {
        sql_text: `
          CREATE TABLE IF NOT EXISTS membership_fee_token (
            id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
            token TEXT NOT NULL UNIQUE,
            tenant_id UUID NOT NULL,
            organization_id UUID NOT NULL,
            membership_year TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'po_submitted', 'paid', 'expired', 'cancelled')),
            final_cost NUMERIC(12, 2),
            currency TEXT DEFAULT 'GBP',
            tier_label TEXT,
            cost_breakdown JSONB,
            po_number TEXT,
            stripe_payment_intent_id TEXT,
            stripe_client_secret TEXT,
            recipient_email TEXT,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_membership_fee_token_token ON membership_fee_token(token);
          CREATE INDEX IF NOT EXISTS idx_membership_fee_token_tenant_org ON membership_fee_token(tenant_id, organization_id, membership_year);
        `
      });
    }
    tokenTableEnsured = true;
  } catch (err) {
    console.error('[Email Fees] Error ensuring token table:', err.message);
    tokenTableEnsured = true;
  }
}

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
    const finalCost = simResult.finalCost;
    const currency = simResult.currency || 'GBP';
    const tierLabel = simResult.tierLabel;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('name, slug, primary_color')
      .eq('id', tenantId)
      .single();

    let stripeEnabled = false;
    try {
      const { data: stripeSetting } = await supabase
        .from('system_settings')
        .select('setting_value')
        .eq('setting_key', 'membership_stripe_enabled')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      stripeEnabled = stripeSetting?.setting_value === 'true';
    } catch {}


    let toEmails = [];

    if (recipientEmails && Array.isArray(recipientEmails) && recipientEmails.length > 0) {
      toEmails = [...new Set(recipientEmails.map(e => e.trim().toLowerCase()).filter(Boolean))];
    } else if (recipientEmail) {
      toEmails = [recipientEmail.trim().toLowerCase()];
    }

    if (toEmails.length === 0) {
      const { data: orgData } = await supabase
        .from('organization')
        .select('invoicing_email')
        .eq('id', organizationId)
        .single();

      if (orgData?.invoicing_email) {
        toEmails.push(orgData.invoicing_email.trim().toLowerCase());
      }
    }
    if (toEmails.length === 0) {
      const { data: primaryContact } = await supabase
        .from('member')
        .select('email')
        .eq('organization_id', organizationId)
        .eq('is_primary_contact', true)
        .limit(1)
        .maybeSingle();

      if (primaryContact?.email) {
        toEmails.push(primaryContact.email.trim().toLowerCase());
      }
    }

    if (toEmails.length === 0) {
      return res.status(400).json({ error: 'No recipient email provided and no invoicing email or primary contact found for this organisation' });
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
      freePeriodAmount: simResult.freePeriodAmount,
      freePeriodUnit: simResult.freePeriodUnit,
      yearNumber: simResult.yearNumber,
      rolloverDiscount: simResult.rolloverDiscount || 0,
      proRataEnabled: simResult.proRataEnabled,
      overrideType: simResult.overrideType || null,
      overrideDiscountType: simResult.overrideDiscountType || null,
      overrideDiscountValue: simResult.overrideDiscountValue || null,
      vatRatePercent: simResult.vatRatePercent || null,
      vatAmount: simResult.vatAmount || 0,
      totalWithVat: simResult.totalWithVat || finalCost,
      taxLabel: simResult.taxLabel || null,
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

    await ensureTokenTable();

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
        recipient_email: toEmails.join(', '),
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

    const breakdownRows = [];

    if (costBreakdown.annualCostBeforeDiscounts != null && costBreakdown.annualCostBeforeDiscounts !== finalCost) {
      breakdownRows.push({ label: 'Annual Membership Fee', value: `${currencySymbol}${parseFloat(costBreakdown.annualCostBeforeDiscounts).toFixed(2)}` });
    } else if (costBreakdown.annualCost != null) {
      breakdownRows.push({ label: 'Annual Membership Fee', value: `${currencySymbol}${parseFloat(costBreakdown.annualCost).toFixed(2)}` });
    }

    if (costBreakdown.customDiscountDetails && costBreakdown.customDiscountDetails.length > 0) {
      costBreakdown.customDiscountDetails.forEach(d => {
        breakdownRows.push({ label: `Discount: ${d.label || d.ruleName || 'Custom'}`, value: `-${currencySymbol}${parseFloat(d.applied_amount || d.amount || 0).toFixed(2)}`, isDiscount: true });
      });
    } else if (costBreakdown.customDiscountTotal > 0) {
      breakdownRows.push({ label: 'Discounts', value: `-${currencySymbol}${parseFloat(costBreakdown.customDiscountTotal).toFixed(2)}`, isDiscount: true });
    }

    if (costBreakdown.proRataEnabled && costBreakdown.prorataDays != null) {
      const prorataCostVal = parseFloat(costBreakdown.prorataCost || 0);
      breakdownRows.push({ label: `Pro-rata (${costBreakdown.prorataDays} days)`, value: `${currencySymbol}${prorataCostVal.toFixed(2)}` });
    }

    if (costBreakdown.freeDiscount > 0) {
      let discountLabel;
      if (costBreakdown.freePeriodUnit === 'percent') {
        discountLabel = `New Member Discount (${costBreakdown.freePeriodAmount}%)`;
        if (costBreakdown.yearNumber === 2) discountLabel += ' (rollover from Y1)';
      } else if (costBreakdown.yearNumber === 2) {
        discountLabel = `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} days rollover)`;
      } else {
        discountLabel = `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} free days)`;
      }
      breakdownRows.push({ label: discountLabel, value: `-${currencySymbol}${parseFloat(costBreakdown.freeDiscount).toFixed(2)}`, isDiscount: true });
    }

    if (costBreakdown.rolloverDiscount > 0) {
      let rolloverLabel;
      if (costBreakdown.freePeriodUnit === 'percent') {
        rolloverLabel = `New Member Discount (${costBreakdown.freePeriodAmount}%) (rollover from Y1)`;
      } else {
        rolloverLabel = `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} days rollover)`;
      }
      breakdownRows.push({ label: rolloverLabel, value: `-${currencySymbol}${parseFloat(costBreakdown.rolloverDiscount).toFixed(2)}`, isDiscount: true });
    }

    if (costBreakdown.overrideType) {
      if (costBreakdown.overrideType === 'price') {
        breakdownRows.push({ label: 'Manual Price Override', value: 'Applied', isNote: true });
      } else if (costBreakdown.overrideType === 'structure') {
        breakdownRows.push({ label: 'Structure Override', value: 'Applied', isNote: true });
      }
    }

    const hasVat = costBreakdown.vatRatePercent && costBreakdown.vatAmount > 0;
    const displayTotal = hasVat ? costBreakdown.totalWithVat : finalCost;

    if (hasVat) {
      breakdownRows.push({ label: 'Net Amount', value: `${currencySymbol}${finalCost.toFixed(2)}`, isSubtotal: true });
      breakdownRows.push({ label: `VAT (${costBreakdown.vatRatePercent}%)`, value: `${currencySymbol}${parseFloat(costBreakdown.vatAmount).toFixed(2)}` });
    }

    const breakdownHtml = breakdownRows.map(row => `
      <tr>
        <td style="padding: 4px 0; color: ${row.isDiscount ? '#16a34a' : row.isSubtotal ? '#333' : '#666'};">${row.label}</td>
        <td style="padding: 4px 0; text-align: right; font-weight: 600; color: ${row.isDiscount ? '#16a34a' : row.isNote ? '#888' : 'inherit'};">${row.value}</td>
      </tr>
    `).join('');

    const ctaMessage = stripeEnabled
      ? 'You can provide a Purchase Order number or make an immediate payment using the link below:'
      : 'Please review your fee details and submit a Purchase Order number using the link below:';
    const ctaButtonText = stripeEnabled
      ? 'View & Pay Membership Fee'
      : 'View & Submit Purchase Order';

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
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
              ${breakdownHtml}
              <tr>
                <td colspan="2" style="padding: 8px 0 4px 0; border-top: 1px solid #ddd;"></td>
              </tr>
              <tr>
                <td style="padding: 4px 0; color: #333; font-weight: 600;">Total Due${hasVat ? ' (incl. VAT)' : ''}</td>
                <td style="padding: 4px 0; text-align: right; font-weight: 700; font-size: 18px;">${currencySymbol}${displayTotal.toFixed(2)}</td>
              </tr>
            </table>
          </div>
          <p>${ctaMessage}</p>
          <div style="text-align: center; margin: 24px 0;">
            <a href="${paymentUrl}" style="display: inline-block; background: ${primaryColor}; color: white; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600;">${ctaButtonText}</a>
          </div>
          <p style="color: #999; font-size: 12px;">This link expires on ${expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
        </div>
        <p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">${tenantName}</p>
      </div>
    `;

    const sentTo = [];
    const failed = [];

    for (const email of toEmails) {
      const emailResult = await sendTenantEmail({
        tenantId,
        to: email,
        subject: `Membership Fee for ${yearLabel} - ${tenantName}`,
        html: emailHtml,
      });

      if (emailResult.success) {
        sentTo.push(email);
      } else {
        console.error(`[Email Fees] Email send failed for ${email}:`, emailResult.error);
        failed.push(email);
      }
    }

    if (sentTo.length === 0) {
      return res.status(500).json({ error: 'Failed to send email to any recipient' });
    }

    try {
      const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
      const recipientList = sentTo.join(', ');
      await supabase.from('organization_note').insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Fee Email] Fee notification sent to ${recipientList} for ${yearLabel}. Amount: ${currencySymbol}${finalCost.toFixed(2)}.`,
        attachments: [],
      });
    } catch {}

    return res.json({
      success: true,
      sentTo,
      membershipYear: yearLabel,
      finalCost,
      token,
      paymentUrl,
      message: `Fee notification sent to ${sentTo.join(', ')}${failed.length > 0 ? `. Failed: ${failed.join(', ')}` : ''}`,
    });
  } catch (error) {
    console.error('[Email Fees] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
