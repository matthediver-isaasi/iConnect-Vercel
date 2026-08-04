import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getAccountingProvider, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import { sendMembershipInvoiceEmail } from '../_lib/membershipInvoiceEmail.js';
import { resolveInvoiceAddress } from '../_lib/invoiceAddressResolver.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import {
  getMembershipAddonSettings,
  validateAddonLines,
  loadAddonLines,
  buildExtraLineItems,
  processTrainingFundAddons,
} from '../_lib/membershipAddons.js';

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
      if (req.body?.advance === true) {
        return handleAdvanceInvoice(req, res, tenantId, tenantContext);
      }
      return handleManualRenewal(req, res, tenantId, tenantContext);
    } else if (req.method === 'PATCH') {
      return handleApproval(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Org Membership Invoicing] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { organizationId } = req.query;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  try {
    await ensureColumns();

    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId);

    if (error) {
      if (error.code === '42P01') {
        return res.json({ settings: {} });
      }
      console.error('[Invoicing] Error fetching settings:', error);
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
          addon_lines: Array.isArray(row.addon_lines) ? row.addon_lines : [],
          id: row.id,
        };
      }
    }

    return res.json({ settings });
  } catch (err) {
    console.error('[Invoicing] Error in GET:', err);
    return res.json({ settings: {} });
  }
}

let columnEnsured = false;
async function ensureColumns() {
  if (columnEnsured) return;
  try {
    await supabase.rpc('exec_sql', {
      sql_text: `
        ALTER TABLE organisation_membership_invoicing 
        ADD COLUMN IF NOT EXISTS membership_year TEXT;
        ALTER TABLE organisation_membership_invoicing 
        ADD COLUMN IF NOT EXISTS purchase_order_number TEXT;
        ALTER TABLE organisation_membership_invoicing 
        ADD COLUMN IF NOT EXISTS po_source TEXT;
        ALTER TABLE organisation_membership_invoicing 
        ADD COLUMN IF NOT EXISTS fees_approved BOOLEAN DEFAULT false;
        ALTER TABLE organisation_membership_invoicing 
        ADD COLUMN IF NOT EXISTS addon_lines JSONB;
      `
    });
    columnEnsured = true;
  } catch (err) {
    columnEnsured = true;
  }
}

async function handlePut(req, res, tenantId, tenantContext) {
  const { organizationId, invoicingMode, invoiceDate, membershipYear, purchaseOrderNumber } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  if (!membershipYear) {
    return res.status(400).json({ error: 'membershipYear is required' });
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

  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id, invoicing_address')
    .eq('id', organizationId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!org) {
    return res.status(404).json({ error: 'Organisation not found' });
  }

  await ensureColumns();

  const { data: existing } = await supabase
    .from('organisation_membership_invoicing')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', membershipYear)
    .maybeSingle();

  const invoicingData = {
    tenant_id: tenantId,
    organization_id: organizationId,
    membership_year: membershipYear,
    invoicing_mode: invoicingMode,
    invoice_date: invoicingMode === 'scheduled' ? invoiceDate : null,
    purchase_order_number: purchaseOrderNumber?.trim() || null,
    po_source: null,
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing) {
    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .update(invoicingData)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('[Invoicing] Error updating settings:', error);
      return res.status(500).json({ error: 'Failed to update invoicing settings' });
    }
    result = data;
  } else {
    const { data, error } = await supabase
      .from('organisation_membership_invoicing')
      .insert(invoicingData)
      .select()
      .single();

    if (error) {
      console.error('[Invoicing] Error creating settings:', error);
      return res.status(500).json({ error: 'Failed to create invoicing settings' });
    }
    result = data;
  }

  return res.json(result);
}

async function checkApprovalRequired(tenantId, organizationId, membershipYear) {
  const { data: setting } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'membership_require_approval')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (setting?.setting_value !== 'true') return { required: false };

  await ensureColumns();

  const { data: invoicing } = await supabase
    .from('organisation_membership_invoicing')
    .select('fees_approved')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', membershipYear)
    .maybeSingle();

  return { required: true, approved: !!invoicing?.fees_approved };
}

async function handleManualRenewal(req, res, tenantId, tenantContext) {
  const { organizationId, membershipYear: requestedYear } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
    source: 'manual',
    mode: 'manual',
    targetYear: requestedYear || null,
  });

  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Simulation failed' });
  }

  if (!simResult.goLiveDate) {
    return res.status(400).json({ error: 'Organisation does not have a Go Live date set. A go-live date is required before membership can be renewed.' });
  }

  if (simResult.existingRecord) {
    return res.status(400).json({ error: `A membership record for ${simResult.membershipYear.label} already exists` });
  }

  const approval = await checkApprovalRequired(tenantId, organizationId, simResult.membershipYear.label);
  if (approval.required && !approval.approved) {
    return res.status(400).json({ error: 'Fees must be approved before renewal can be processed. Use the Approve Fees button first.' });
  }

  const org = simResult.org;
  const membershipYear = simResult.membershipYear;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;

  let poNumber = null;
  try {
    const { data: invoicingSetting } = await supabase
      .from('organisation_membership_invoicing')
      .select('purchase_order_number')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYear.label)
      .maybeSingle();
    poNumber = invoicingSetting?.purchase_order_number || null;
  } catch (poErr) {
    console.log('[Invoicing] Could not fetch PO number (non-fatal):', poErr.message);
  }

  // Add-on lines stored at fee-approval time — appended to the invoice as
  // extra line items only. They are intentionally NOT added to the stored
  // membership cost fields (final_cost / vat_amount / total_with_vat), which
  // record the pure membership fee.
  const addonLines = await loadAddonLines(tenantId, organizationId, membershipYear.label);

  const { data: record, error: insertError } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: organizationId,
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
      final_cost: Math.round(finalCost * 100) / 100,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: Math.round((simResult.vatAmount || 0) * 100) / 100,
      total_with_vat: Math.round((simResult.totalWithVat || finalCost) * 100) / 100,
      year_number: simResult.yearNumber || null,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'active',
      notes: `Manual renewal via admin action (year ${simResult.yearNumber}, go-live: ${simResult.goLiveDate})${addonLines.length > 0 ? `. ${addonLines.length} add-on line(s) invoiced.` : ''}`,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(400).json({ error: `A membership record for ${membershipYear.label} already exists (duplicate prevented)` });
    }
    console.error('[Invoicing] Error creating history record:', insertError);
    return res.status(500).json({ error: 'Failed to create membership record' });
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
      organizationName: org.name,
      invoicingEmail: org.invoicing_email || null,
      invoicingAddress: await resolveInvoiceAddress(supabase, simResult.config, organizationId, 'organization'),
      membershipYear: membershipYear.label,
      tierLabel,
      finalCost,
      currency: currency,
      reference: xeroReference,
      vatRate: bandVatRate,
      nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
      invoiceDescription: simResult.config?.invoice_description || null,
      extraLineItems: buildExtraLineItems(addonLines),
    });

    if (xeroInvoice) {
      const { error: linkError } = await supabase
        .from('organisation_membership_history')
        .update(buildInvoiceColumnUpdate(xeroInvoice))
        .eq('id', record.id);

      if (linkError) {
        console.error(`[Invoicing] Failed to link ${providerLabel} invoice to history record (non-fatal):`, linkError.message);
      } else {
        console.log(`[Invoicing] ${providerLabel} invoice created: ${xeroInvoice.invoice_number || '(no invoice number)'} for ${org.name}`);
      }

      try {
        await processTrainingFundAddons({
          tenantId,
          organizationId,
          invoice: xeroInvoice,
          addonLines,
          createdBy: tenantContext.memberId || null,
        });
      } catch (tfErr) {
        console.error('[Invoicing] Training fund add-on processing failed (non-fatal):', tfErr.message);
      }
    }
  } catch (xeroErr) {
    console.error(`[Invoicing] ${providerLabel} invoice creation failed (non-fatal):`, xeroErr.message);
  }

  if (xeroInvoice) {
    try {
      await sendMembershipInvoiceEmail({
        tenantId,
        organizationId,
        organizationName: org.name,
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
        tierConfig: simResult.config,
      });
    } catch (emailErr) {
      console.error('[Invoicing] Invoice email failed (non-fatal):', emailErr.message);
    }
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    const invoiceNote = xeroInvoice
      ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
      : ` ${providerLabel} invoice could not be created - check ${providerLabel} connection.`;
    await supabase
      .from('organization_note')
      .insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Renewal - Manual] Membership renewed for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}.${invoiceNote}`,
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Invoicing] Failed to create note (non-fatal):', noteErr);
  }

  return res.json({
    success: true,
    record: { ...record, xero_invoice_id: xeroInvoice?.invoice_id, xero_invoice_number: xeroInvoice?.invoice_number },
    xeroInvoice: xeroInvoice || null,
    message: `Membership renewed for ${membershipYear.label}. Fee: ${finalCost.toFixed(2)}.${xeroInvoice ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.` : ''}`,
  });
}

async function handleAdvanceInvoice(req, res, tenantId, tenantContext) {
  const { organizationId, membershipYear: requestedYear, asOfDate } = req.body;

  if (!organizationId) {
    return res.status(400).json({ error: 'organizationId is required' });
  }

  if (!requestedYear) {
    return res.status(400).json({ error: 'membershipYear is required' });
  }

  const simResult = await simulateMembershipForOrg(tenantId, organizationId, {
    source: 'manual',
    mode: 'manual',
    targetYear: requestedYear,
    asOfDate: asOfDate || null,
  });

  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Simulation failed' });
  }

  if (!simResult.goLiveDate) {
    return res.status(400).json({ error: 'Organisation does not have a Go Live date set. A go-live date is required before membership can be invoiced.' });
  }

  const membershipYear = simResult.membershipYear;

  // Idempotency: never create a second record (or invoice) for this year.
  if (simResult.existingRecord) {
    return res.status(400).json({ error: `A membership record for ${membershipYear.label} already exists` });
  }

  const approval = await checkApprovalRequired(tenantId, organizationId, membershipYear.label);
  if (approval.required && !approval.approved) {
    return res.status(400).json({ error: 'Fees must be approved before the invoice can be sent. Use the Approve Fees button first.' });
  }

  const org = simResult.org;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;

  // Activation date = the normal start date of the membership schedule. The
  // renewal cron flips this record from 'scheduled' to 'active' on/after this
  // date WITHOUT generating another invoice.
  const activationDate = new Date(membershipYear.start).toISOString().split('T')[0];

  let poNumber = null;
  try {
    const { data: invoicingSetting } = await supabase
      .from('organisation_membership_invoicing')
      .select('purchase_order_number')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYear.label)
      .maybeSingle();
    poNumber = invoicingSetting?.purchase_order_number || null;
  } catch (poErr) {
    console.log('[Invoicing] Could not fetch PO number (non-fatal):', poErr.message);
  }

  // Add-on lines stored at fee-approval time — appended to the invoice as
  // extra line items only. They are intentionally NOT added to the stored
  // membership cost fields (final_cost / vat_amount / total_with_vat), which
  // record the pure membership fee.
  const addonLines = await loadAddonLines(tenantId, organizationId, membershipYear.label);

  const { data: record, error: insertError } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: organizationId,
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
      final_cost: Math.round(finalCost * 100) / 100,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: Math.round((simResult.vatAmount || 0) * 100) / 100,
      total_with_vat: Math.round((simResult.totalWithVat || finalCost) * 100) / 100,
      year_number: simResult.yearNumber || null,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'scheduled',
      scheduled_activation_date: activationDate,
      notes: `Advance invoice (Invoice Now) via admin action (year ${simResult.yearNumber}, go-live: ${simResult.goLiveDate}). Membership activates on ${activationDate}.${addonLines.length > 0 ? ` ${addonLines.length} add-on line(s) invoiced.` : ''}`,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return res.status(400).json({ error: `A membership record for ${membershipYear.label} already exists (duplicate prevented)` });
    }
    console.error('[Invoicing] Error creating advance history record:', insertError);
    return res.status(500).json({ error: 'Failed to create membership record' });
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
      organizationName: org.name,
      invoicingEmail: org.invoicing_email || null,
      invoicingAddress: await resolveInvoiceAddress(supabase, simResult.config, organizationId, 'organization'),
      membershipYear: membershipYear.label,
      tierLabel,
      finalCost,
      currency: currency,
      reference: xeroReference,
      vatRate: bandVatRate,
      nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
      invoiceDescription: simResult.config?.invoice_description || null,
      extraLineItems: buildExtraLineItems(addonLines),
    });
  } catch (xeroErr) {
    console.error(`[Invoicing] ${providerLabel} advance invoice creation failed:`, xeroErr.message);
  }

  // Strict: the whole point of "Invoice Now" is to send the invoice in advance.
  // If no invoice was produced we must NOT leave a 'scheduled' row behind — the
  // renewal cron would later flip it to 'active' and the org would have a paid
  // membership year with no invoice. Roll the row back and surface the failure.
  if (!xeroInvoice) {
    await supabase.from('organisation_membership_history').delete().eq('id', record.id);
    return res.status(502).json({
      error: `Could not create the ${providerLabel} invoice. Check the ${providerLabel} connection and try again — no invoice was sent and nothing was scheduled.`,
    });
  }

  const { error: linkError } = await supabase
    .from('organisation_membership_history')
    .update(buildInvoiceColumnUpdate(xeroInvoice))
    .eq('id', record.id);

  if (linkError) {
    // The invoice exists in the accounting system but we could not record it on
    // the membership row. Mark the row so it is not silently activated and so an
    // admin can reconcile, and report failure to the caller.
    console.error(`[Invoicing] Failed to link ${providerLabel} advance invoice to history record:`, linkError.message);
    return res.status(500).json({
      error: `The ${providerLabel} invoice ${xeroInvoice.invoice_number || ''} was created but could not be linked to the membership record. Please check ${providerLabel} before retrying.`,
    });
  }
  console.log(`[Invoicing] ${providerLabel} advance invoice created: ${xeroInvoice.invoice_number || '(no invoice number)'} for ${org.name}`);

  try {
    await processTrainingFundAddons({
      tenantId,
      organizationId,
      invoice: xeroInvoice,
      addonLines,
      createdBy: tenantContext.memberId || null,
    });
  } catch (tfErr) {
    console.error('[Invoicing] Training fund add-on processing failed (non-fatal):', tfErr.message);
  }

  {
    try {
      await sendMembershipInvoiceEmail({
        tenantId,
        organizationId,
        organizationName: org.name,
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
        tierConfig: simResult.config,
      });
    } catch (emailErr) {
      console.error('[Invoicing] Advance invoice email failed (non-fatal):', emailErr.message);
    }
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    const invoiceNote = xeroInvoice
      ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
      : ` ${providerLabel} invoice could not be created - check ${providerLabel} connection.`;
    await supabase
      .from('organization_note')
      .insert({
        organization_id: organizationId,
        member_id: noteCreatorId,
        content: `[Membership Renewal - Invoice Now] Advance invoice sent for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}. Membership will activate on ${activationDate}.${invoiceNote}`,
        attachments: []
      });
  } catch (noteErr) {
    console.error('[Invoicing] Failed to create note (non-fatal):', noteErr);
  }

  return res.json({
    success: true,
    record: { ...record, xero_invoice_id: xeroInvoice?.invoice_id, xero_invoice_number: xeroInvoice?.invoice_number },
    xeroInvoice: xeroInvoice || null,
    message: `Advance invoice sent for ${membershipYear.label}. Fee: ${finalCost.toFixed(2)}. Membership will activate on ${activationDate}.${xeroInvoice ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.` : ''}`,
  });
}

async function handleApproval(req, res, tenantId) {
  const { organizationId, membershipYear, action, addonLines } = req.body;

  if (!organizationId || !membershipYear) {
    return res.status(400).json({ error: 'organizationId and membershipYear are required' });
  }

  if (!['approve', 'unapprove'].includes(action)) {
    return res.status(400).json({ error: 'action must be "approve" or "unapprove"' });
  }

  await ensureColumns();

  const approved = action === 'approve';

  // Add-on lines may only be supplied on approve, and are validated against
  // the tenant's add-on settings. Unapprove always clears stored add-ons.
  let storedAddonLines = null;
  if (approved && addonLines != null) {
    const settings = await getMembershipAddonSettings(tenantId);
    const validation = validateAddonLines(addonLines, settings);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    storedAddonLines = validation.lines.length > 0 ? validation.lines : null;
  }

  const { data: existing } = await supabase
    .from('organisation_membership_invoicing')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('membership_year', membershipYear)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('organisation_membership_invoicing')
      .update({ fees_approved: approved, addon_lines: approved ? storedAddonLines : null, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) {
      console.error('[Invoicing] Error updating approval:', error);
      return res.status(500).json({ error: 'Failed to update approval status' });
    }
  } else {
    const { error } = await supabase
      .from('organisation_membership_invoicing')
      .insert({
        tenant_id: tenantId,
        organization_id: organizationId,
        membership_year: membershipYear,
        // 'automatic' (the resolver's fallback), NOT 'manual': fee approval
        // must not change the effective invoicing mode (Task #3244).
        invoicing_mode: 'automatic',
        fees_approved: approved,
        addon_lines: approved ? storedAddonLines : null,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('[Invoicing] Error creating approval record:', error);
      return res.status(500).json({ error: 'Failed to create approval record' });
    }
  }

  return res.json({ success: true, fees_approved: approved, addon_lines: approved ? (storedAddonLines || []) : [] });
}
