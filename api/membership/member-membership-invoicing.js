import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getAccountingProvider, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { buildInboxDelivery } from '../_lib/transactionalInbox.js';
import { resolveInvoiceAddress } from '../_lib/invoiceAddressResolver.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import {
  isZeroDueExistingMembership,
  isZeroDueMembership,
  zeroDuePaymentFields,
  fireNewZeroDueMembershipPaidWorkflow,
} from '../_lib/zeroDueMembership.js';
import { resolveEntityAnnualRenewalEligibility, annualRecordSchedule } from '../_lib/annualRenewalPolicy.js';
import { resolveMemberFeeApproval, setMemberFeeApproval } from '../_lib/membershipFeeApproval.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
      return handleGet(req, res, tenantId);
    } else if (req.method === 'PUT') {
      return handlePut(req, res, tenantId, tenantContext);
    } else if (req.method === 'POST') {
      return handleManualRenewal(req, res, tenantId, tenantContext);
    } else if (req.method === 'PATCH') {
      return handleApproval(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Member Membership Invoicing] Error:', error);
    return res.status(500).json({ error: 'Internal server error', retryable: true });
  }
}

async function handleGet(req, res, tenantId) {
  const { memberId } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  try {
    const { data, error } = await supabase
      .from('member_membership_invoicing')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId);

    if (error) {
      if (error.code === '42P01') {
        return res.json({ settings: {} });
      }
      console.error('[Member Invoicing] Error fetching settings:', error);
      return res.status(500).json({ error: 'Failed to fetch invoicing settings' });
    }

    const settings = {};
    if (data && data.length > 0) {
      for (const row of data) {
        const key = row.membership_year || '_legacy';
        settings[key] = {
          invoicing_mode: row.invoicing_mode,
          invoice_date: row.invoice_date,
          purchase_order_number: row.purchase_order_number || null,
          po_supplied_by_member: row.po_source === 'member',
          fees_approved: !!row.fees_approved,
          id: row.id,
        };
      }
    }

    return res.json({ settings });
  } catch (err) {
    console.error('[Member Invoicing] Error in GET:', err);
    return res.json({ settings: {} });
  }
}

async function handlePut(req, res, tenantId, tenantContext) {
  const { memberId, invoicingMode, invoiceDate, membershipYear, purchaseOrderNumber } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  if (!invoicingMode || !['automatic', 'scheduled', 'manual'].includes(invoicingMode)) {
    return res.status(400).json({ error: 'invoicingMode must be "automatic", "scheduled", or "manual"' });
  }

  if (invoicingMode === 'scheduled' && !invoiceDate) {
    return res.status(400).json({ error: 'invoice_date is required when invoicing mode is "scheduled"' });
  }

  if (invoicingMode === 'scheduled' && invoiceDate) {
    const dateObj = new Date(invoiceDate);
    if (isNaN(dateObj.getTime())) {
      return res.status(400).json({ error: 'Invalid invoice date format' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateObj < today) {
      return res.status(400).json({ error: 'Invoice date must not be in the past' });
    }
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email, tenant_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  let existingQuery = supabase
    .from('member_membership_invoicing')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);
  if (membershipYear) {
    existingQuery = existingQuery.eq('membership_year', membershipYear);
  } else {
    existingQuery = existingQuery.is('membership_year', null);
  }
  const { data: existing } = await existingQuery.maybeSingle();

  const invoicingData = {
    tenant_id: tenantId,
    member_id: memberId,
    membership_year: membershipYear || null,
    invoicing_mode: invoicingMode,
    invoice_date: invoicingMode === 'scheduled' ? invoiceDate : null,
    purchase_order_number: purchaseOrderNumber?.trim() || null,
    po_source: null,
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('member_membership_invoicing')
      .update(invoicingData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('[Member Invoicing] Error updating settings:', error);
      return res.status(500).json({ error: 'Failed to update invoicing settings' });
    }
    result = data;
  } else {
    const { data, error } = await supabase
      .from('member_membership_invoicing')
      .insert(invoicingData)
      .select()
      .single();

    if (error) {
      console.error('[Member Invoicing] Error creating settings:', error);
      return res.status(500).json({ error: 'Failed to create invoicing settings' });
    }
    result = data;
  }

  return res.json(result);
}

async function handleManualRenewal(req, res, tenantId, tenantContext) {
  const { memberId, membershipYear: requestedYear } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  const simResult = await simulateMembershipForMember(tenantId, memberId, {
    source: 'manual',
    mode: 'manual',
    targetYear: requestedYear || null,
  });

  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Simulation failed' });
  }
  const renewalEligibility = await resolveEntityAnnualRenewalEligibility(supabase, {
    tenantId,
    memberId,
    config: simResult.config,
    membershipYear: simResult.membershipYear,
  });
  if (!renewalEligibility.eligible) {
    return res.status(409).json({ error: renewalEligibility.message, code: renewalEligibility.code, lifecycle: renewalEligibility.lifecycle });
  }

  if (simResult.existingRecord) {
    const { data: existingRow, error: existingRowError } = await supabase
      .from('member_membership_history')
      .select('*')
      .eq('id', simResult.existingRecord.id)
      .maybeSingle();
    if (existingRowError) throw existingRowError;
    if (isZeroDueExistingMembership(existingRow) && existingRow?.payment_status === 'paid') {
      await fireNewZeroDueMembershipPaidWorkflow({
        table: 'member_membership_history',
        row: existingRow,
        paidAt: existingRow.paid_at,
        baseUrl: req.headers.host ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}` : '',
        source: 'manual_member_membership_zero_due',
      });
      return res.json({ success: true, record: existingRow, xeroInvoice: null, message: `Membership renewed for ${simResult.membershipYear.label}. Nothing is due.` });
    }
    return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists` });
  }

  const approval = await resolveMemberFeeApproval(supabase, {
    tenantId,
    memberId,
    membershipYear: simResult.membershipYear.label,
  });
  if (approval.required && !approval.approved) {
    return res.status(400).json({ error: 'Fees must be approved before renewal can be processed. Use the Approve Fees button first.' });
  }

  const member = simResult.member;
  const memberName = member.name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Member';
  const membershipYear = simResult.membershipYear;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;

  const zeroDue = isZeroDueMembership(simResult);
  const paidAt = zeroDue ? new Date().toISOString() : null;

  let poNumber = null;
  try {
    if (!zeroDue) {
      const { data: invoicingSetting } = await supabase
        .from('member_membership_invoicing')
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('membership_year', membershipYear.label)
        .maybeSingle();
      poNumber = invoicingSetting?.purchase_order_number || null;
    }
  } catch (poErr) {
    console.log('[Member Invoicing] Could not fetch PO number (non-fatal):', poErr.message);
  }

  const { data: record, error: insertError } = await supabase
    .from('member_membership_history')
    .insert({
      tenant_id: tenantId,
      member_id: memberId,
      membership_year: membershipYear.label,
      config_id: simResult.config.id,
      band_id: simResult.matchedBand?.id || null,
      tier_label: tierLabel,
      field_value: simResult.fieldValue,
      annual_cost: annualCost,
      prorata_cost: simResult.prorataCost,
      free_period_discount: simResult.freeDiscount || 0,
      rollover_discount: simResult.rolloverDiscount || 0,
      custom_discount_total: simResult.customDiscountTotal || 0,
      custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
      final_cost: finalCost,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: simResult.totalWithVat || finalCost,
      year_number: simResult.yearNumber || null,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
       ...annualRecordSchedule(renewalEligibility),
       notes: `Manual renewal via admin action (year ${simResult.yearNumber}, member: ${memberName}). Term: ${renewalEligibility.lifecycle.termStart} to ${renewalEligibility.lifecycle.termEnd}.`,
      ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(400).json({ error: `A membership record for ${membershipYear.label} already exists (duplicate prevented)` });
    }
    console.error('[Member Invoicing] Error creating history record:', insertError);
    return res.status(500).json({ error: 'Failed to create membership record' });
  }

  if (zeroDue) {
    await fireNewZeroDueMembershipPaidWorkflow({
      table: 'member_membership_history',
      row: record,
      paidAt,
      baseUrl: req.headers.host
        ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
        : '',
      source: 'manual_member_membership_zero_due',
    });

    return res.json({
      success: true,
      record,
      xeroInvoice: null,
      message: `Membership renewed for ${membershipYear.label}. Nothing is due.`,
    });
  }

  let xeroInvoice = null;
  const provider = await getAccountingProvider(tenantId);
  const providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
  try {
    const xeroReference = poNumber
      ? `Membership ${membershipYear.label} - PO: ${poNumber}`
      : `Membership ${membershipYear.label}`;
    xeroInvoice = await provider.createMembershipInvoice({
      appTenantId: tenantId,
      organizationName: memberName,
      invoicingEmail: member.email || null,
      invoicingAddress: await resolveInvoiceAddress(supabase, simResult.config, memberId, 'member'),
      membershipYear: membershipYear.label,
      tierLabel,
      finalCost,
      currency: currency,
      reference: xeroReference,
      vatRate: bandVatRate,
      nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
      invoiceDescription: simResult.config?.invoice_description || null,
    });

    if (xeroInvoice) {
      const { error: linkError } = await supabase
        .from('member_membership_history')
        .update(buildInvoiceColumnUpdate(xeroInvoice))
        .eq('id', record.id);

      if (linkError) {
        console.error(`[Member Invoicing] Failed to link ${providerLabel} invoice to history record (non-fatal):`, linkError.message);
      } else {
        console.log(`[Member Invoicing] ${providerLabel} invoice created: ${xeroInvoice.invoice_number || '(no invoice number)'} for ${memberName}`);
      }
    }
  } catch (xeroErr) {
    console.error(`[Member Invoicing] ${providerLabel} invoice creation failed (non-fatal):`, xeroErr.message);
  }

  if (xeroInvoice && member.email) {
    try {
      await sendMemberInvoiceEmail({
        tenantId,
        memberId,
        memberName,
        memberEmail: member.email,
        membershipYear: membershipYear.label,
        finalCost,
        currency,
        tierLabel,
        xeroInvoiceNumber: xeroInvoice.invoice_number,
        xeroInvoiceId: xeroInvoice.invoice_id,
        historyRecordId: record.id,
        vatAmount: simResult.vatAmount || 0,
        totalWithVat: simResult.totalWithVat || finalCost,
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error('[Member Invoicing] Invoice email failed (non-fatal):', emailErr.message);
    }
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    const invoiceNote = xeroInvoice
      ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
      : ` ${providerLabel} invoice could not be created - check ${providerLabel} connection.`;
    await supabase
      .from('member_note')
      .insert({
        member_id: memberId,
        created_by: noteCreatorId,
        content: `[Membership Renewal - Manual] Membership renewed for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}.${invoiceNote}`,
      });
  } catch (noteErr) {
    console.error('[Member Invoicing] Failed to create note (non-fatal):', noteErr);
  }

  return res.json({
    success: true,
    record: { ...record, xero_invoice_id: xeroInvoice?.invoice_id, xero_invoice_number: xeroInvoice?.invoice_number },
    xeroInvoice: xeroInvoice || null,
    message: `Membership renewed for ${membershipYear.label}. Fee: ${finalCost.toFixed(2)}.${xeroInvoice ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.` : ''}`,
  });
}

async function sendMemberInvoiceEmail({
  tenantId,
  memberId,
  memberName,
  memberEmail,
  membershipYear,
  finalCost,
  currency,
  tierLabel,
  xeroInvoiceNumber,
  xeroInvoiceId,
  historyRecordId,
  vatAmount,
  totalWithVat,
  onlineInvoiceUrl,
}) {
  if (!xeroInvoiceId) {
    console.log('[Member Invoice Email] No invoice id - skipping email');
    return { success: false, error: 'No invoice details available' };
  }

  if (!memberEmail) {
    console.log('[Member Invoice Email] No member email - skipping email');
    return { success: false, error: 'No email address available' };
  }

  // QBO may legitimately return no DocNumber when "Custom transaction numbers"
  // is enabled. Send the email anyway, but omit the invoice-number row + drop
  // the number from the subject so we never surface QBO's internal id.
  const hasInvoiceNumber = !!xeroInvoiceNumber;

  try {
    const { data: template } = await supabase
      .from('email_template')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('template_key', 'membership_invoice')
      .maybeSingle();

    const subject = template?.subject
      ? template.subject
          .replace(/\{membershipYear\}/gi, membershipYear)
          .replace(/\{invoiceNumber\}/gi, xeroInvoiceNumber || '')
      : (hasInvoiceNumber
          ? `Membership Invoice ${xeroInvoiceNumber} - ${membershipYear}`
          : `Membership Invoice - ${membershipYear}`);

    const formattedCost = parseFloat(finalCost).toFixed(2);
    const formattedVat = parseFloat(vatAmount || 0).toFixed(2);
    const formattedTotal = parseFloat(totalWithVat || finalCost).toFixed(2);

    // Fallback to public PDF token if no provider-hosted invoice link exists.
    let viewInvoiceUrl = onlineInvoiceUrl || null;
    const { data: tenantBrand } = await supabase
      .from('tenant')
      .select('name, slug, logo_url, primary_color')
      .eq('id', tenantId)
      .maybeSingle();
    if (!viewInvoiceUrl && historyRecordId) {
      const { getOrCreateInvoicePdfToken, buildInvoicePdfUrl } = await import('../_lib/invoicePdfToken.js');
      const pdfToken = await getOrCreateInvoicePdfToken({
        client: supabase,
        tenantId,
        historyTable: 'member_membership_history',
        recordId: historyRecordId,
      });
      if (pdfToken) {
        viewInvoiceUrl = buildInvoicePdfUrl(pdfToken, tenantBrand?.slug || null);
      }
    }

    let body;
    if (template?.body) {
      body = template.body
        .replace(/\{memberName\}/gi, memberName)
        .replace(/\{organizationName\}/gi, memberName)
        .replace(/\{membershipYear\}/gi, membershipYear)
        .replace(/\{tierLabel\}/gi, tierLabel || 'Standard')
        .replace(/\{finalCost\}/gi, formattedCost)
        .replace(/\{currency\}/gi, currency)
        .replace(/\{invoiceNumber\}/gi, xeroInvoiceNumber || '')
        .replace(/\{vatAmount\}/gi, formattedVat)
        .replace(/\{totalWithVat\}/gi, formattedTotal)
        .replace(/\{onlineInvoiceUrl\}/gi, viewInvoiceUrl || '');
    } else {
      // Shared layout with the org membership invoice email (fee table + CTA).
      const { buildMembershipInvoiceEmailHtml } = await import('../_lib/membershipInvoiceEmail.js');
      body = buildMembershipInvoiceEmailHtml({
        recipientName: memberName,
        tenantName: tenantBrand?.name || null,
        logoUrl: tenantBrand?.logo_url || null,
        primaryColor: tenantBrand?.primary_color || null,
        membershipYear,
        finalCost,
        currency,
        tierLabel,
        invoiceNumber: hasInvoiceNumber ? xeroInvoiceNumber : null,
        vatAmount: vatAmount || 0,
        totalWithVat: totalWithVat || finalCost,
        viewInvoiceUrl,
      });
    }

    const inboxDelivery = await buildInboxDelivery({
      tenantId,
      memberId,
      email: memberEmail,
      labelKey: 'membership',
    });

    await sendTenantEmail({
      tenantId,
      to: memberEmail,
      subject,
      html: body,
      inboxDelivery,
    });

    console.log(`[Member Invoice Email] Sent invoice email to ${memberEmail} for ${membershipYear}`);
    return { success: true };
  } catch (err) {
    console.error('[Member Invoice Email] Error:', err);
    return { success: false, error: err.message };
  }
}

async function handleApproval(req, res, tenantId) {
  const { memberId, membershipYear, action } = req.body;

  if (!memberId || !membershipYear) {
    return res.status(400).json({ error: 'memberId and membershipYear are required' });
  }

  if (!['approve', 'unapprove'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "unapprove"' });
  }

  const approved = action === 'approve';

  const { data: member, error: memberError } = await supabase
    .from('member')
    .select('id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (memberError) {
    console.error('[Member Invoicing] Error resolving approval member:', memberError);
    return res.status(500).json({ error: 'Failed to resolve member' });
  }
  if (!member) return res.status(404).json({ error: 'Member not found' });

  try {
    await setMemberFeeApproval(supabase, {
      tenantId,
      memberId,
      membershipYear,
      approved,
    });
  } catch (error) {
    console.error('[Member Invoicing] Error updating approval:', error);
    return res.status(500).json({ error: 'Failed to update approval status' });
  }

  return res.json({ success: true, fees_approved: approved });
}
