import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { createXeroMembershipInvoice } from '../_lib/xero.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';

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
    return res.status(500).json({ error: 'Internal server error' });
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

async function checkApprovalRequired(tenantId, memberId, membershipYear) {
  const { data: setting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_require_approval')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (setting?.setting_value !== 'true') return { required: false };

  let approvalQuery = supabase
    .from('member_membership_invoicing')
    .select('fees_approved, membership_year')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId);

  if (membershipYear) {
    approvalQuery = approvalQuery.or(`membership_year.eq.${membershipYear},membership_year.is.null`);
  }

  const { data: invoicingRows } = await approvalQuery;
  if (!invoicingRows || invoicingRows.length === 0) return { required: true, approved: false };

  const yearSpecific = invoicingRows.find(r => r.membership_year === membershipYear);
  const fallback = invoicingRows.find(r => !r.membership_year);
  const invoicing = yearSpecific || fallback;

  return { required: true, approved: !!invoicing?.fees_approved };
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

  if (simResult.existingRecord) {
    return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists` });
  }

  const approval = await checkApprovalRequired(tenantId, memberId, simResult.membershipYear.label);
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

  let poNumber = null;
  try {
    const { data: invoicingSetting } = await supabase
      .from('member_membership_invoicing')
      .select('purchase_order_number')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('membership_year', membershipYear.label)
      .maybeSingle();
    poNumber = invoicingSetting?.purchase_order_number || null;
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
      status: 'active',
      notes: `Manual renewal via admin action (year ${simResult.yearNumber}, member: ${memberName})`,
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

  let xeroInvoice = null;
  try {
    const xeroReference = poNumber
      ? `Membership ${membershipYear.label} - PO: ${poNumber}`
      : `Membership ${membershipYear.label}`;
    xeroInvoice = await createXeroMembershipInvoice({
      appTenantId: tenantId,
      organizationName: memberName,
      invoicingAddress: null,
      membershipYear: membershipYear.label,
      tierLabel,
      finalCost,
      currency: currency,
      reference: xeroReference,
      vatRate: bandVatRate,
      invoiceDescription: simResult.config?.invoice_description || null,
    });

    if (xeroInvoice) {
      const { error: linkError } = await supabase
        .from('member_membership_history')
        .update({
          xero_invoice_id: xeroInvoice.invoice_id,
          xero_invoice_number: xeroInvoice.invoice_number,
        })
        .eq('id', record.id);

      if (linkError) {
        console.error(`[Member Invoicing] Failed to link Xero invoice to history record (non-fatal):`, linkError.message);
      } else {
        console.log(`[Member Invoicing] Xero invoice created: ${xeroInvoice.invoice_number} for ${memberName}`);
      }
    }
  } catch (xeroErr) {
    console.error('[Member Invoicing] Xero invoice creation failed (non-fatal):', xeroErr.message);
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
      ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
      : ' Xero invoice could not be created - check Xero connection.';
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
    message: `Membership renewed for ${membershipYear.label}. Fee: ${finalCost.toFixed(2)}.${xeroInvoice ? ` Invoice ${xeroInvoice.invoice_number} created.` : ''}`,
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
  vatAmount,
  totalWithVat,
  onlineInvoiceUrl,
}) {
  if (!xeroInvoiceId || !xeroInvoiceNumber) {
    console.log('[Member Invoice Email] No Xero invoice details - skipping email');
    return { success: false, error: 'No invoice details available' };
  }

  if (!memberEmail) {
    console.log('[Member Invoice Email] No member email - skipping email');
    return { success: false, error: 'No email address available' };
  }

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
          .replace(/\{invoiceNumber\}/gi, xeroInvoiceNumber)
      : `Membership Invoice ${xeroInvoiceNumber} - ${membershipYear}`;

    const formattedCost = parseFloat(finalCost).toFixed(2);
    const formattedVat = parseFloat(vatAmount || 0).toFixed(2);
    const formattedTotal = parseFloat(totalWithVat || finalCost).toFixed(2);

    let body;
    if (template?.body) {
      body = template.body
        .replace(/\{memberName\}/gi, memberName)
        .replace(/\{organizationName\}/gi, memberName)
        .replace(/\{membershipYear\}/gi, membershipYear)
        .replace(/\{tierLabel\}/gi, tierLabel || 'Standard')
        .replace(/\{finalCost\}/gi, formattedCost)
        .replace(/\{currency\}/gi, currency)
        .replace(/\{invoiceNumber\}/gi, xeroInvoiceNumber)
        .replace(/\{vatAmount\}/gi, formattedVat)
        .replace(/\{totalWithVat\}/gi, formattedTotal)
        .replace(/\{onlineInvoiceUrl\}/gi, onlineInvoiceUrl || '');
    } else {
      body = `
        <p>Dear ${memberName},</p>
        <p>Your membership invoice for ${membershipYear} has been generated.</p>
        <table style="border-collapse: collapse; margin: 16px 0;">
          <tr><td style="padding: 4px 12px; font-weight: bold;">Invoice Number</td><td style="padding: 4px 12px;">${xeroInvoiceNumber}</td></tr>
          <tr><td style="padding: 4px 12px; font-weight: bold;">Membership Year</td><td style="padding: 4px 12px;">${membershipYear}</td></tr>
          <tr><td style="padding: 4px 12px; font-weight: bold;">Tier</td><td style="padding: 4px 12px;">${tierLabel || 'Standard'}</td></tr>
          <tr><td style="padding: 4px 12px; font-weight: bold;">Fee</td><td style="padding: 4px 12px;">${currency} ${formattedCost}</td></tr>
          ${vatAmount > 0 ? `<tr><td style="padding: 4px 12px; font-weight: bold;">VAT</td><td style="padding: 4px 12px;">${currency} ${formattedVat}</td></tr>` : ''}
          ${vatAmount > 0 ? `<tr><td style="padding: 4px 12px; font-weight: bold;">Total (incl. VAT)</td><td style="padding: 4px 12px;">${currency} ${formattedTotal}</td></tr>` : ''}
        </table>
        ${onlineInvoiceUrl ? `<p><a href="${onlineInvoiceUrl}">View and pay your invoice online</a></p>` : ''}
        <p>Thank you for your membership.</p>
      `;
    }

    await sendTenantEmail({
      tenantId,
      to: memberEmail,
      subject,
      html: body,
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

  const { data: existing } = await supabase
    .from('member_membership_invoicing')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .eq('membership_year', membershipYear)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('member_membership_invoicing')
      .update({ fees_approved: approved, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) {
      console.error('[Member Invoicing] Error updating approval:', error);
      return res.status(500).json({ error: 'Failed to update approval status' });
    }
  } else {
    const { error } = await supabase
      .from('member_membership_invoicing')
      .insert({
        tenant_id: tenantId,
        member_id: memberId,
        membership_year: membershipYear,
        invoicing_mode: 'manual',
        fees_approved: approved,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[Member Invoicing] Error creating approval record:', error);
      return res.status(500).json({ error: 'Failed to create approval record' });
    }
  }

  return res.json({ success: true, fees_approved: approved });
}
