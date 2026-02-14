import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { createXeroMembershipInvoice } from '../_lib/xero.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';

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
    .select('id, name, tenant_id')
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

  const org = simResult.org;
  const membershipYear = simResult.membershipYear;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const bandVatRate = simResult.matchedBand?.vat_rate || null;

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
      final_cost: finalCost,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      status: 'active',
      notes: `Manual renewal via admin action (year ${simResult.yearNumber}, go-live: ${simResult.goLiveDate})`,
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
  try {
    const xeroReference = poNumber
      ? `Membership ${membershipYear.label} - PO: ${poNumber}`
      : `Membership ${membershipYear.label}`;
    xeroInvoice = await createXeroMembershipInvoice({
      appTenantId: tenantId,
      organizationName: org.name,
      membershipYear: membershipYear.label,
      tierLabel,
      finalCost,
      currency: currency,
      reference: xeroReference,
      vatRate: bandVatRate,
    });

    if (xeroInvoice) {
      const { error: linkError } = await supabase
        .from('organisation_membership_history')
        .update({
          xero_invoice_id: xeroInvoice.invoice_id,
          xero_invoice_number: xeroInvoice.invoice_number,
        })
        .eq('id', record.id);

      if (linkError) {
        console.error(`[Invoicing] Failed to link Xero invoice to history record (non-fatal):`, linkError.message);
      } else {
        console.log(`[Invoicing] Xero invoice created: ${xeroInvoice.invoice_number} for ${org.name}`);
      }
    }
  } catch (xeroErr) {
    console.error('[Invoicing] Xero invoice creation failed (non-fatal):', xeroErr.message);
  }

  try {
    const noteCreatorId = tenantContext.memberId || tenantContext.tenantUserId || null;
    const invoiceNote = xeroInvoice
      ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
      : ' Xero invoice could not be created - check Xero connection.';
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
    message: `Membership renewed for ${membershipYear.label}. Fee: ${finalCost.toFixed(2)}.${xeroInvoice ? ` Invoice ${xeroInvoice.invoice_number} created.` : ''}`
  });
}
