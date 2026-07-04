import crypto from 'crypto';
import { supabase as defaultSupabase } from './database.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { buildInboxDelivery } from './transactionalInbox.js';
import { resolveTierRecipients } from './membershipRecipientResolver.js';

/**
 * Substitute the fee-link email placeholders documented under the
 * "Membership Fees" category on /EmailPlaceholders.
 *
 * Optional tokens (xero_invoice_number, xero_online_invoice_url, po_number)
 * MUST render as empty strings when absent — we never leak the raw token.
 */
function renderFeeLinkPlaceholders(str, data) {
  if (!str) return '';
  return String(str).replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const v = data[key];
      return v === null || v === undefined ? '' : String(v);
    }
    return m;
  });
}

async function loadFeeLinkTemplate(client, tenantId, templateId) {
  if (!templateId) return null;
  try {
    const { data } = await client
      .from('email_template')
      .select('id, name, subject, body, is_active')
      .eq('id', templateId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data || data.is_active === false) return null;
    if (!/\{\{\s*payment_link\s*\}\}/.test(data.body || '')) {
      console.warn(
        `[FeeTokenEmail] Tier-configured template ${templateId} no longer contains {{payment_link}}; ` +
        `falling back to system default.`
      );
      return null;
    }
    return data;
  } catch (err) {
    console.warn('[FeeTokenEmail] Failed to load fee-link template, falling back to default:', err.message);
    return null;
  }
}

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';

let tokenTableEnsured = false;
async function ensureTokenTable(client) {
  if (tokenTableEnsured) return;
  try {
    const { error: checkError } = await client
      .from('membership_fee_token')
      .select('id')
      .limit(1);
    if (!checkError || checkError.code !== '42P01') {
      tokenTableEnsured = true;
      return;
    }
    await client.rpc('exec_sql', {
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
          xero_invoice_id TEXT,
          xero_invoice_number TEXT,
          xero_online_invoice_url TEXT,
          history_record_id UUID,
          paid_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_membership_fee_token_token ON membership_fee_token(token);
        CREATE INDEX IF NOT EXISTS idx_membership_fee_token_tenant_org ON membership_fee_token(tenant_id, organization_id, membership_year);
      `,
    });
    tokenTableEnsured = true;
  } catch (err) {
    console.error('[FeeTokenEmail] ensureTokenTable error:', err.message);
    tokenTableEnsured = true;
  }
}

function buildBreakdownRows(currencySymbol, costBreakdown, finalCost) {
  const rows = [];
  if (costBreakdown.annualCostBeforeDiscounts != null && costBreakdown.annualCostBeforeDiscounts !== finalCost) {
    rows.push({ label: 'Annual Membership Fee', value: `${currencySymbol}${parseFloat(costBreakdown.annualCostBeforeDiscounts).toFixed(2)}` });
  } else if (costBreakdown.annualCost != null) {
    rows.push({ label: 'Annual Membership Fee', value: `${currencySymbol}${parseFloat(costBreakdown.annualCost).toFixed(2)}` });
  }
  if (Array.isArray(costBreakdown.customDiscountDetails) && costBreakdown.customDiscountDetails.length > 0) {
    costBreakdown.customDiscountDetails.forEach((d) => {
      rows.push({ label: `Discount: ${d.label || d.ruleName || 'Custom'}`, value: `-${currencySymbol}${parseFloat(d.applied_amount || d.amount || 0).toFixed(2)}`, isDiscount: true });
    });
  } else if (costBreakdown.customDiscountTotal > 0) {
    rows.push({ label: 'Discounts', value: `-${currencySymbol}${parseFloat(costBreakdown.customDiscountTotal).toFixed(2)}`, isDiscount: true });
  }
  if (costBreakdown.proRataEnabled && costBreakdown.prorataDays != null) {
    const prorataCostVal = parseFloat(costBreakdown.prorataCost || 0);
    rows.push({ label: `Pro-rata (${costBreakdown.prorataDays} days)`, value: `${currencySymbol}${prorataCostVal.toFixed(2)}` });
  }
  if (costBreakdown.freeDiscount > 0) {
    let label;
    if (costBreakdown.freePeriodUnit === 'percent') {
      label = `New Member Discount (${costBreakdown.freePeriodAmount}%)`;
      if (costBreakdown.yearNumber === 2) label += ' (rollover from Y1)';
    } else if (costBreakdown.yearNumber === 2) {
      label = `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} days rollover)`;
    } else {
      label = `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} free days)`;
    }
    rows.push({ label, value: `-${currencySymbol}${parseFloat(costBreakdown.freeDiscount).toFixed(2)}`, isDiscount: true });
  }
  if (costBreakdown.rolloverDiscount > 0) {
    const label = costBreakdown.freePeriodUnit === 'percent'
      ? `New Member Discount (${costBreakdown.freePeriodAmount}%) (rollover from Y1)`
      : `New Member Discount (${costBreakdown.freePeriodDaysApplied || 0} days rollover)`;
    rows.push({ label, value: `-${currencySymbol}${parseFloat(costBreakdown.rolloverDiscount).toFixed(2)}`, isDiscount: true });
  }
  if (costBreakdown.overrideType === 'price') {
    rows.push({ label: 'Manual Price Override', value: 'Applied', isNote: true });
  } else if (costBreakdown.overrideType === 'structure') {
    rows.push({ label: 'Structure Override', value: 'Applied', isNote: true });
  }
  return rows;
}

/**
 * Mint (or reuse) a membership_fee_token for the given tenant/org/year and
 * email the Pay-by-card / Submit-PO link to one or more recipients.
 *
 * Used by both:
 *  - manual "Email fees" admin action (api/membership/email-fees.js)
 *  - auto-renewal cron when no PO is on file at renewal time
 *
 * @returns {Promise<{ success: boolean, token?: string, paymentUrl?: string, sentTo?: string[], failed?: string[], error?: string }>}
 */
export async function sendMembershipFeeTokenEmail({
  client = defaultSupabase,
  tenantId,
  organizationId,
  organizationName,
  membershipYear,
  finalCost,
  currency = 'GBP',
  tierLabel,
  costBreakdown,
  poNumber = null,
  recipientEmails,
  tierConfig = null,
  stripeEnabled = false,
  xeroInvoiceId = null,
  xeroInvoiceNumber = null,
  xeroOnlineInvoiceUrl = null,
  historyRecordId = null,
}) {
  if (!client) return { success: false, error: 'Database not configured' };

  let toEmails = Array.isArray(recipientEmails)
    ? [...new Set(recipientEmails.map((e) => (e || '').trim().toLowerCase()).filter(Boolean))]
    : [];

  if (toEmails.length === 0) {
    const resolved = await resolveTierRecipients({
      client,
      tenantId,
      organizationId,
      tierConfig,
    });
    toEmails = resolved.recipients;
    if (resolved.usedFallback) {
      console.warn(
        `[FeeTokenEmail] Tier recipients resolved to no addresses for org ${organizationId}; ` +
        `using invoicing-email/primary-contact safety fallback (${toEmails.join(', ') || 'none'}).`
      );
    }
  }
  if (toEmails.length === 0) {
    return { success: false, error: 'No recipient email available' };
  }

  await ensureTokenTable(client);

  // Idempotency: if a non-terminal token already exists for this
  // (tenant, org, year), reuse it instead of minting a duplicate. Manual
  // "Email fees" intentionally re-sends, but the cron path benefits from
  // reuse so repeated cron runs don't pile up tokens for the same year.
  //
  // We only reuse a *pending* token. A `po_submitted` token must NOT be
  // silently re-priced underneath an existing submission — if its snapshot
  // is stale and the admin re-emails (e.g. after a discount change), we mint
  // a fresh pending token so the new email links to a page matching its body.
  let token = null;
  let tokenId = null;
  let expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  try {
    const { data: existing } = await client
      .from('membership_fee_token')
      .select('id, token, expires_at, status')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYear)
      .in('status', ['pending', 'po_submitted'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing && existing.status === 'pending' && new Date(existing.expires_at) > new Date()) {
      token = existing.token;
      tokenId = existing.id;
      expiresAt = new Date(existing.expires_at);
    }
  } catch {}

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    const insertPayload = {
      token,
      tenant_id: tenantId,
      organization_id: organizationId,
      membership_year: membershipYear,
      status: 'pending',
      final_cost: finalCost,
      currency,
      tier_label: tierLabel,
      cost_breakdown: costBreakdown || {},
      po_number: poNumber,
      recipient_email: toEmails.join(', '),
      xero_invoice_id: xeroInvoiceId,
      xero_invoice_number: xeroInvoiceNumber,
      xero_online_invoice_url: xeroOnlineInvoiceUrl,
      history_record_id: historyRecordId,
      expires_at: expiresAt.toISOString(),
    };
    const { data: inserted, error: tokenError } = await client
      .from('membership_fee_token')
      .insert(insertPayload)
      .select('id')
      .single();
    if (tokenError) {
      // If columns don't exist yet (migration not applied), retry with the
      // legacy column set so the email still goes out.
      if (/column .* does not exist/i.test(tokenError.message || '')) {
        const legacy = { ...insertPayload };
        delete legacy.xero_invoice_id;
        delete legacy.xero_invoice_number;
        delete legacy.xero_online_invoice_url;
        delete legacy.history_record_id;
        const { data: retry, error: retryErr } = await client
          .from('membership_fee_token')
          .insert(legacy)
          .select('id')
          .single();
        if (retryErr) {
          console.error('[FeeTokenEmail] Token insert retry failed:', retryErr.message);
          return { success: false, error: 'Failed to create payment token' };
        }
        tokenId = retry?.id || null;
      } else {
        console.error('[FeeTokenEmail] Token insert failed:', tokenError.message);
        return { success: false, error: 'Failed to create payment token' };
      }
    } else {
      tokenId = inserted?.id || null;
    }
  } else {
    // Reusing an existing pending token: refresh the snapshotted cost fields
    // to the freshly-computed values so the public PO page (which reads cost
    // straight off the token row) always matches the latest email body.
    // Without this, changing a discount + re-emailing shows the new amount in
    // the email but the old amount on the linked page.
    const { error: refreshErr } = await client
      .from('membership_fee_token')
      .update({
        final_cost: finalCost,
        cost_breakdown: costBreakdown || {},
        currency,
        tier_label: tierLabel,
        po_number: poNumber,
        recipient_email: toEmails.join(', '),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tokenId);
    if (refreshErr) {
      console.warn('[FeeTokenEmail] Token snapshot refresh failed (non-fatal):', refreshErr.message);
    }

    // Backfill xero details onto the reused token if the caller has them.
    // Kept as a separate update so the core snapshot refresh above still
    // succeeds on legacy schemas where the xero columns may not exist.
    if (xeroInvoiceId || xeroInvoiceNumber || xeroOnlineInvoiceUrl || historyRecordId) {
      const { error: xeroErr } = await client
        .from('membership_fee_token')
        .update({
          xero_invoice_id: xeroInvoiceId,
          xero_invoice_number: xeroInvoiceNumber,
          xero_online_invoice_url: xeroOnlineInvoiceUrl,
          history_record_id: historyRecordId,
        })
        .eq('id', tokenId);
      if (xeroErr) {
        console.warn('[FeeTokenEmail] Token xero backfill failed (non-fatal):', xeroErr.message);
      }
    }
  }

  const { data: tenant } = await client
    .from('tenant')
    .select('name, slug, primary_color, logo_url')
    .eq('id', tenantId)
    .maybeSingle();

  const tenantSlug = tenant?.slug;
  const paymentUrl = tenantSlug
    ? `https://${tenantSlug}.${APP_DOMAIN}/membership-fees/${token}`
    : `https://${APP_DOMAIN}/membership-fees/${token}`;

  const tenantName = tenant?.name || 'Organisation';
  const primaryColor = tenant?.primary_color || '#5C0085';
  const currencySymbol = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' }[currency] || currency;

  const cb = costBreakdown || {};
  const rows = buildBreakdownRows(currencySymbol, cb, finalCost);
  const hasVat = cb.vatRatePercent && cb.vatAmount > 0;
  const displayTotal = hasVat ? cb.totalWithVat : finalCost;
  if (hasVat) {
    rows.push({ label: 'Net Amount', value: `${currencySymbol}${parseFloat(finalCost).toFixed(2)}`, isSubtotal: true });
    rows.push({ label: `VAT (${cb.vatRatePercent}%)`, value: `${currencySymbol}${parseFloat(cb.vatAmount).toFixed(2)}` });
  }

  const breakdownHtml = rows.map((row) => `
    <tr>
      <td style="padding: 4px 0; color: ${row.isDiscount ? '#16a34a' : row.isSubtotal ? '#333' : '#666'};">${row.label}</td>
      <td style="padding: 4px 0; text-align: right; font-weight: 600; color: ${row.isDiscount ? '#16a34a' : row.isNote ? '#888' : 'inherit'};">${row.value}</td>
    </tr>
  `).join('');

  const ctaMessage = stripeEnabled
    ? 'You can provide a Purchase Order number or make an immediate payment using the link below:'
    : 'Please review your fee details and submit a Purchase Order number using the link below:';
  const ctaButtonText = stripeEnabled ? 'View & Pay Membership Fee' : 'View & Submit Purchase Order';

  const defaultEmailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="padding: 20px; border: 1px solid #e5e5e5; border-radius: 8px;">
        <h2 style="color: ${primaryColor}; margin-top: 0;">Membership Fee for ${membershipYear}</h2>
        <p>Dear ${organizationName},</p>
        <p>Your membership fee for the period <strong>${membershipYear}</strong> has been calculated:</p>
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
              <td style="padding: 4px 0; text-align: right; font-weight: 700; font-size: 18px;">${currencySymbol}${parseFloat(displayTotal).toFixed(2)}</td>
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

  const customTemplate = await loadFeeLinkTemplate(
    client,
    tenantId,
    tierConfig?.fee_link_email_template_id,
  );

  let emailHtml = defaultEmailHtml;
  let emailSubject = `Membership Fee for ${membershipYear} - ${tenantName}`;

  if (customTemplate) {
    const expiresHuman = expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    const paymentLinkHtml = `<a href="${paymentUrl}" style="color: ${primaryColor}; text-decoration: underline;">${paymentUrl}</a>`;
    const placeholderData = {
      payment_link: paymentLinkHtml,
      recipient_name: organizationName || tenantName,
      organisation_name: organizationName || '',
      organization_name: organizationName || '',
      membership_year: membershipYear || '',
      tier_label: tierLabel || '',
      final_cost: finalCost != null ? `${currencySymbol}${parseFloat(finalCost).toFixed(2)}` : '',
      currency,
      vat_amount: hasVat ? `${currencySymbol}${parseFloat(cb.vatAmount).toFixed(2)}` : '',
      total_with_vat: hasVat ? `${currencySymbol}${parseFloat(cb.totalWithVat).toFixed(2)}` : '',
      po_number: poNumber || '',
      expires_at: expiresHuman,
      xero_invoice_number: xeroInvoiceNumber || '',
      xero_online_invoice_url: xeroOnlineInvoiceUrl || '',
      tenant_name: tenantName,
    };
    emailHtml = renderFeeLinkPlaceholders(customTemplate.body || defaultEmailHtml, placeholderData);
    const renderedSubject = renderFeeLinkPlaceholders(customTemplate.subject || '', placeholderData).trim();
    if (renderedSubject) emailSubject = renderedSubject;
  }

  const sentTo = [];
  const failed = [];
  for (const email of toEmails) {
    const inboxDelivery = await buildInboxDelivery({
      tenantId,
      email,
      labelKey: 'membership',
    });
    const r = await sendTenantEmail({
      tenantId,
      to: email,
      subject: emailSubject,
      html: emailHtml,
      inboxDelivery,
    });
    if (r.success) sentTo.push(email);
    else {
      console.error(`[FeeTokenEmail] send failed to ${email}:`, r.error);
      failed.push(email);
    }
  }

  if (sentTo.length === 0) {
    return { success: false, error: 'Failed to send to any recipient', token, paymentUrl };
  }

  return { success: true, token, paymentUrl, sentTo, failed };
}
