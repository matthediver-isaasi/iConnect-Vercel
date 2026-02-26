import { supabase } from '../_lib/database.js';
import { createXeroMembershipInvoice } from '../_lib/xero.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { sendMembershipInvoiceEmail } from '../_lib/membershipInvoiceEmail.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/process-membership-renewals] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    const { data: configs, error: configError } = await supabase
      .from('membership_tier_config')
      .select('*')
      .is('effective_to', null);

    if (configError) {
      console.error('[cron/process-membership-renewals] Error fetching configs:', configError);
      return res.status(500).json({ error: 'Failed to fetch tier configs' });
    }

    const tenantIds = [];
    const currentHourUTC = new Date().getUTCHours();

    if (!configs || configs.length === 0) {
      console.log('[cron/process-membership-renewals] No active tier configs found');
    } else {
      tenantIds.push(...new Set(configs.map(c => c.tenant_id)));

      const { data: cronTimeSettings } = await supabase
        .from('system_settings')
        .select('tenant_id, setting_value')
        .eq('setting_key', 'membership_cron_time')
        .in('tenant_id', tenantIds);

      const tenantCronHours = {};
      for (const row of (cronTimeSettings || [])) {
        const hour = parseInt(row.setting_value?.split(':')[0], 10);
        tenantCronHours[row.tenant_id] = isNaN(hour) ? 6 : hour;
      }

      for (const tenantId of tenantIds) {
        const scheduledHour = tenantCronHours[tenantId] ?? 6;
        if (scheduledHour !== currentHourUTC) {
          console.log(`[cron/process-membership-renewals] Skipping tenant ${tenantId} — scheduled for ${String(scheduledHour).padStart(2, '0')}:00 UTC, current hour is ${String(currentHourUTC).padStart(2, '0')}:00 UTC`);
          continue;
        }

        try {
          await processTenantRenewals(tenantId, results);
        } catch (tenantErr) {
          console.error(`[cron/process-membership-renewals] Error processing tenant ${tenantId}:`, tenantErr);
          results.errors++;
          results.details.push({ tenantId, error: tenantErr.message });
        }

        try {
          await processTenantMemberRenewals(tenantId, results);
        } catch (memberErr) {
          console.error(`[cron/process-membership-renewals] Error processing member renewals for tenant ${tenantId}:`, memberErr);
          results.errors++;
          results.details.push({ tenantId, error: `Member renewals: ${memberErr.message}` });
        }
      }
    }

    const duration = Date.now() - startTime;

    for (const tenantId of tenantIds) {
      try {
        const tenantDetails = results.details.filter(d => d.tenantId === tenantId);
        const tenantProcessed = tenantDetails.filter(d => d.status === 'processed').length;
        const tenantSkipped = tenantDetails.filter(d => d.status === 'skipped').length;
        const tenantErrors = tenantDetails.filter(d => d.status === 'error').length;

        await supabase.from('scheduled_task_log').insert({
          tenant_id: tenantId,
          task_name: 'membership_renewals',
          task_display_name: 'Membership Renewals',
          status: tenantErrors > 0 ? 'partial' : 'success',
          details: JSON.stringify({
            processed: tenantProcessed,
            skipped: tenantSkipped,
            errors: tenantErrors,
            duration_ms: duration,
            details: tenantDetails,
          }),
          executed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error(`[cron/process-membership-renewals] Failed to log for tenant ${tenantId}:`, logErr);
      }
    }

    if (tenantIds.length === 0) {
      try {
        await supabase.from('scheduled_task_log').insert({
          tenant_id: null,
          task_name: 'membership_renewals',
          task_display_name: 'Membership Renewals',
          status: 'success',
          details: JSON.stringify({ message: 'No active tier configs found', duration_ms: duration }),
          executed_at: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('[cron/process-membership-renewals] Failed to log:', logErr);
      }
    }

    console.log(`[cron/process-membership-renewals] Completed in ${duration}ms. Processed: ${results.processed}, Skipped: ${results.skipped}, Errors: ${results.errors}`);

    return res.json({
      success: true,
      duration_ms: duration,
      results,
    });

  } catch (error) {
    console.error('[cron/process-membership-renewals] Fatal error:', error);

    try {
      await supabase.from('scheduled_task_log').insert({
        tenant_id: null,
        task_name: 'membership_renewals',
        task_display_name: 'Membership Renewals',
        status: 'error',
        details: JSON.stringify({ error: error.message }),
        executed_at: new Date().toISOString(),
      });
    } catch (logErr) {
      console.error('[cron/process-membership-renewals] Failed to log error:', logErr);
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function processTenantRenewals(tenantId, results) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: invoicingRows, error: invError } = await supabase
    .from('organisation_membership_invoicing')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('invoicing_mode', ['automatic', 'scheduled']);

  if (invError) {
    if (invError.code === '42P01') return;
    throw invError;
  }

  if (!invoicingRows || invoicingRows.length === 0) return;

  for (const invoicingSetting of invoicingRows) {
    const orgId = invoicingSetting.organization_id;
    const mode = invoicingSetting.invoicing_mode;
    const targetYear = invoicingSetting.membership_year || null;

    try {
      const simResult = await simulateMembershipForOrg(tenantId, orgId, {
        source: 'cron',
        mode,
        targetYear,
      });

      if (!simResult.success) {
        results.skipped++;
        results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: simResult.error || 'Simulation failed' });
        continue;
      }

      if (!simResult.goLiveDate) {
        results.skipped++;
        results.details.push({
          tenantId,
          orgId,
          orgName: simResult.org?.name || orgId,
          mode,
          status: 'skipped',
          reason: 'No Go Live date set - organisation cannot be auto-renewed without a go-live date',
        });
        console.log(`[cron/process-membership-renewals] Skipped org ${simResult.org?.name || orgId}: no Go Live date`);
        continue;
      }

      const membershipYear = simResult.membershipYear;
      const yearStart = new Date(membershipYear.start);
      yearStart.setHours(0, 0, 0, 0);
      const renewalDue = today >= yearStart;

      const approvalCheck = await checkCronApproval(tenantId, orgId, membershipYear.label);
      if (approvalCheck.required && !approvalCheck.approved) {
        results.skipped++;
        results.details.push({ tenantId, orgId, orgName: simResult.org?.name || orgId, mode, status: 'skipped', reason: 'Fees not yet approved' });
        continue;
      }

      if (mode === 'automatic') {
        if (!renewalDue) {
          results.skipped++;
          continue;
        }
        if (simResult.existingRecord) {
          results.skipped++;
          results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: `Record for ${membershipYear.label} already exists` });
          continue;
        }
        await processOrgRenewal(tenantId, orgId, simResult, mode, true, results);
      } else if (mode === 'scheduled') {
        if (!renewalDue && !simResult.existingRecord) {
          results.skipped++;
          continue;
        }

        if (!simResult.existingRecord && renewalDue) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          await processOrgRenewal(tenantId, orgId, simResult, mode, invoiceDue, results);
        } else if (simResult.existingRecord && !simResult.existingRecord.xero_invoice_id) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          if (invoiceDue) {
            await invoiceExistingRecord(tenantId, orgId, simResult, results);
          } else {
            results.skipped++;
          }
        } else {
          results.skipped++;
          results.details.push({ tenantId, orgId, mode, status: 'skipped', reason: `Record for ${membershipYear.label} already exists with invoice` });
        }
      }
    } catch (orgErr) {
      console.error(`[cron/process-membership-renewals] Error processing org ${orgId}:`, orgErr);
      results.errors++;
      results.details.push({ tenantId, orgId, mode, status: 'error', reason: orgErr.message });
    }
  }
}

function isInvoiceDateReached(invoicingSetting, today) {
  if (!invoicingSetting.invoice_date) return false;
  const scheduledDate = new Date(invoicingSetting.invoice_date);
  scheduledDate.setHours(0, 0, 0, 0);
  return today >= scheduledDate;
}

async function invoiceExistingRecord(tenantId, orgId, simResult, results) {
  const existingRecord = simResult.existingRecord;
  if (!existingRecord) return;

  const org = simResult.org;
  if (!org) return;

  const { data: record } = await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('id', existingRecord.id)
    .single();

  if (!record) return;

  let bandVatRate = simResult.taxType || record.vat_rate || null;
  if (!bandVatRate && record.band_id) {
    try {
      const { data: band } = await supabase
        .from('membership_tier_band')
        .select('vat_rate')
        .eq('id', record.band_id)
        .maybeSingle();
      bandVatRate = band?.vat_rate || null;
    } catch {}
  }

  let poNumber = record.purchase_order_number || null;
  if (!poNumber) {
    try {
      const { data: invoicingSetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq('organization_id', orgId)
        .eq('membership_year', record.membership_year)
        .maybeSingle();
      poNumber = invoicingSetting?.purchase_order_number || null;
    } catch {}
  }

  let xeroInvoice = null;
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    xeroInvoice = await createXeroMembershipInvoice({
      appTenantId: tenantId,
      organizationName: org.name,
      invoicingAddress: org.invoicing_address,
      membershipYear: record.membership_year,
      tierLabel: record.tier_label,
      finalCost: parseFloat(record.final_cost),
      currency: record.currency || 'GBP',
      reference: xeroReference,
      vatRate: bandVatRate,
      invoiceDescription: simResult.config?.invoice_description || null,
    });

    if (xeroInvoice) {
      await supabase
        .from('organisation_membership_history')
        .update({
          xero_invoice_id: xeroInvoice.invoice_id,
          xero_invoice_number: xeroInvoice.invoice_number,
        })
        .eq('id', existingRecord.id);
    }
  } catch (xeroErr) {
    console.error(`[cron/process-membership-renewals] Scheduled Xero invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
  }

  if (xeroInvoice) {
    try {
      await sendMembershipInvoiceEmail({
        tenantId,
        organizationId: orgId,
        organizationName: org.name,
        membershipYear: record.membership_year,
        finalCost: parseFloat(record.final_cost),
        currency: record.currency || 'GBP',
        tierLabel: record.tier_label,
        xeroInvoiceNumber: xeroInvoice.invoice_number,
        xeroInvoiceId: xeroInvoice.invoice_id,
        historyRecordId: existingRecord.id,
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice email failed for org ${orgId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const invoiceNote = xeroInvoice
      ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
      : ' Xero invoice could not be created - check Xero connection.';
    await supabase
      .from('organization_note')
      .insert({
        organization_id: orgId,
        member_id: null,
        content: `[Membership Invoice - Scheduled] Invoice generated for ${record.membership_year}. Fee: ${record.currency || 'GBP'} ${parseFloat(record.final_cost).toFixed(2)}.${invoiceNote}`,
        attachments: [],
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create invoice note for org ${orgId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    orgId,
    orgName: org.name,
    mode: 'scheduled',
    action: 'invoiced',
    status: 'processed',
    membershipYear: record.membership_year,
    finalCost: parseFloat(record.final_cost),
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Scheduled invoice: ${org.name} for ${record.membership_year}, cost: ${parseFloat(record.final_cost).toFixed(2)}, invoice: ${xeroInvoice?.invoice_number || 'none'}`);
}

async function processOrgRenewal(tenantId, orgId, simResult, mode, createInvoice, results) {
  const org = simResult.org;
  if (!org) {
    results.skipped++;
    results.details.push({
      tenantId,
      orgId,
      mode,
      status: 'skipped',
      reason: 'Organisation not found',
    });
    return;
  }

  if (simResult.existingRecord) {
    results.skipped++;
    results.details.push({
      tenantId,
      orgId,
      orgName: org.name,
      mode,
      status: 'skipped',
      reason: `Record for ${simResult.membershipYear.label} already exists (safety check in processOrgRenewal)`,
    });
    console.log(`[cron/process-membership-renewals] DUPLICATE PREVENTION: Skipped ${org.name} - record for ${simResult.membershipYear.label} already exists`);
    return;
  }

  const membershipYear = simResult.membershipYear;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const yearNumber = simResult.yearNumber;
  const goLiveDate = simResult.goLiveDate;
  const freeDiscount = simResult.freeDiscount || 0;
  const rolloverDiscount = simResult.rolloverDiscount || 0;
  const customDiscountTotal = simResult.customDiscountTotal || 0;
  const customDiscountDetails = simResult.customDiscountDetails || [];

  let poNumber = null;
  try {
    const { data: invoicingSetting } = await supabase
      .from('organisation_membership_invoicing')
      .select('purchase_order_number')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId)
      .eq('membership_year', membershipYear.label)
      .maybeSingle();
    poNumber = invoicingSetting?.purchase_order_number || null;
  } catch (poErr) {
    console.log(`[cron/process-membership-renewals] Could not fetch PO for org ${orgId} (non-fatal):`, poErr.message);
  }

  const { data: record, error: insertError } = await supabase
    .from('organisation_membership_history')
    .insert({
      tenant_id: tenantId,
      organization_id: orgId,
      membership_year: membershipYear.label,
      config_id: simResult.config.id,
      band_id: simResult.matchedBand?.id || null,
      tier_label: tierLabel,
      field_value: simResult.fieldValue,
      annual_cost: annualCost,
      prorata_cost: simResult.prorataCost,
      free_period_discount: freeDiscount,
      rollover_discount: rolloverDiscount,
      custom_discount_total: customDiscountTotal,
      custom_discount_details: customDiscountDetails.length > 0 ? customDiscountDetails : null,
      final_cost: finalCost,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: simResult.totalWithVat || finalCost,
      year_number: yearNumber,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'active',
      notes: `${mode === 'automatic' ? 'Automatic' : 'Scheduled'} renewal via cron job (year ${yearNumber}, go-live: ${goLiveDate})`,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      results.skipped++;
      results.details.push({
        tenantId,
        orgId,
        orgName: org.name,
        mode,
        status: 'skipped',
        reason: `Duplicate record prevented by database constraint for ${membershipYear.label}`,
      });
      console.log(`[cron/process-membership-renewals] DB CONSTRAINT: Duplicate prevented for ${org.name} - ${membershipYear.label}`);
      return;
    }
    throw new Error(`Failed to create history record: ${insertError.message}`);
  }

  let xeroInvoice = null;
  if (createInvoice) {
    try {
      const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;
      const xeroReference = poNumber
        ? `Membership ${membershipYear.label} - PO: ${poNumber}`
        : `Membership ${membershipYear.label}`;
      xeroInvoice = await createXeroMembershipInvoice({
        appTenantId: tenantId,
        organizationName: org.name,
        invoicingAddress: org.invoicing_address,
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
          .from('organisation_membership_history')
          .update({
            xero_invoice_id: xeroInvoice.invoice_id,
            xero_invoice_number: xeroInvoice.invoice_number,
          })
          .eq('id', record.id);

        if (linkError) {
          console.error(`[cron/process-membership-renewals] Failed to link Xero invoice for org ${orgId}:`, linkError.message);
        }
      }
    } catch (xeroErr) {
      console.error(`[cron/process-membership-renewals] Xero invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
    }
  }

  if (xeroInvoice) {
    try {
      await sendMembershipInvoiceEmail({
        tenantId,
        organizationId: orgId,
        organizationName: org.name,
        membershipYear: membershipYear.label,
        finalCost,
        currency,
        tierLabel,
        xeroInvoiceNumber: xeroInvoice.invoice_number,
        xeroInvoiceId: xeroInvoice.invoice_id,
        historyRecordId: record.id,
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice email failed for org ${orgId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const modeLabel = mode === 'automatic' ? 'Automatic' : 'Scheduled';
    let noteContent = `[Membership Renewal - ${modeLabel}] Membership renewed for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}.`;
    if (createInvoice) {
      noteContent += xeroInvoice
        ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
        : ' Xero invoice could not be created - check Xero connection.';
    } else {
      noteContent += ' Invoice will be generated on the scheduled date.';
    }
    await supabase
      .from('organization_note')
      .insert({
        organization_id: orgId,
        member_id: null,
        content: noteContent,
        attachments: [],
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create note for org ${orgId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    orgId,
    orgName: org.name,
    mode,
    action: createInvoice ? 'renewed_and_invoiced' : 'renewed',
    status: 'processed',
    membershipYear: membershipYear.label,
    yearNumber,
    goLiveDate: goLiveDate || null,
    finalCost,
    freeDiscount,
    rolloverDiscount,
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Renewed: ${org.name} for ${membershipYear.label} (year ${yearNumber}), cost: ${finalCost.toFixed(2)}, free: ${freeDiscount.toFixed(2)}, rollover: ${rolloverDiscount.toFixed(2)}, invoice: ${createInvoice ? (xeroInvoice?.invoice_number || 'failed') : 'deferred'}`);
}

async function checkCronApproval(tenantId, orgId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (setting?.setting_value !== 'true') return { required: false };

    const { data: invoicing } = await supabase
      .from('organisation_membership_invoicing')
      .select('fees_approved')
      .eq('tenant_id', tenantId)
      .eq('organization_id', orgId)
      .eq('membership_year', membershipYearLabel)
      .maybeSingle();

    return { required: true, approved: !!invoicing?.fees_approved };
  } catch {
    return { required: false };
  }
}

async function processTenantMemberRenewals(tenantId, results) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: invoicingRows, error: invError } = await supabase
    .from('member_membership_invoicing')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('invoicing_mode', ['automatic', 'scheduled']);

  if (invError) {
    if (invError.code === '42P01') return;
    throw invError;
  }

  if (!invoicingRows || invoicingRows.length === 0) return;

  for (const invoicingSetting of invoicingRows) {
    const memberId = invoicingSetting.member_id;
    const mode = invoicingSetting.invoicing_mode;
    const targetYear = invoicingSetting.membership_year || null;

    try {
      const simResult = await simulateMembershipForMember(tenantId, memberId, {
        source: 'cron',
        mode,
        targetYear,
      });

      if (!simResult.success) {
        results.skipped++;
        results.details.push({ tenantId, memberId, mode, type: 'member', status: 'skipped', reason: simResult.error || 'Simulation failed' });
        continue;
      }

      const memberName = simResult.member?.name || `${simResult.member?.first_name || ''} ${simResult.member?.last_name || ''}`.trim() || 'Unknown Member';

      const membershipYear = simResult.membershipYear;
      const yearStart = new Date(membershipYear.start);
      yearStart.setHours(0, 0, 0, 0);
      const renewalDue = today >= yearStart;

      const approvalCheck = await checkMemberCronApproval(tenantId, memberId, membershipYear.label);
      if (approvalCheck.required && !approvalCheck.approved) {
        results.skipped++;
        results.details.push({ tenantId, memberId, memberName, mode, type: 'member', status: 'skipped', reason: 'Fees not yet approved' });
        continue;
      }

      if (mode === 'automatic') {
        if (!renewalDue) {
          results.skipped++;
          continue;
        }
        if (simResult.existingRecord) {
          results.skipped++;
          results.details.push({ tenantId, memberId, mode, type: 'member', status: 'skipped', reason: `Record for ${membershipYear.label} already exists` });
          continue;
        }
        await processMemberRenewal(tenantId, memberId, simResult, mode, true, results);
      } else if (mode === 'scheduled') {
        if (!renewalDue && !simResult.existingRecord) {
          results.skipped++;
          continue;
        }

        if (!simResult.existingRecord && renewalDue) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          await processMemberRenewal(tenantId, memberId, simResult, mode, invoiceDue, results);
        } else if (simResult.existingRecord && !simResult.existingRecord.xero_invoice_id) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          if (invoiceDue) {
            await invoiceExistingMemberRecord(tenantId, memberId, simResult, results);
          } else {
            results.skipped++;
          }
        } else {
          results.skipped++;
          results.details.push({ tenantId, memberId, mode, type: 'member', status: 'skipped', reason: `Record for ${membershipYear.label} already exists with invoice` });
        }
      }
    } catch (memberErr) {
      console.error(`[cron/process-membership-renewals] Error processing member ${memberId}:`, memberErr);
      results.errors++;
      results.details.push({ tenantId, memberId, mode, type: 'member', status: 'error', reason: memberErr.message });
    }
  }
}

async function checkMemberCronApproval(tenantId, memberId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (setting?.setting_value !== 'true') return { required: false };

    let overrideQuery = supabase
      .from('member_membership_invoicing')
      .select('fees_approved, membership_year')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId);

    if (membershipYearLabel) {
      overrideQuery = overrideQuery.or(`membership_year.eq.${membershipYearLabel},membership_year.is.null`);
    }

    const { data: invoicingRows } = await overrideQuery;
    if (!invoicingRows || invoicingRows.length === 0) return { required: true, approved: false };

    const yearSpecific = invoicingRows.find(r => r.membership_year === membershipYearLabel);
    const fallback = invoicingRows.find(r => !r.membership_year);
    const invoicing = yearSpecific || fallback;

    return { required: true, approved: !!invoicing?.fees_approved };
  } catch {
    return { required: false };
  }
}

async function processMemberRenewal(tenantId, memberId, simResult, mode, createInvoice, results) {
  const member = simResult.member;
  if (!member) {
    results.skipped++;
    results.details.push({
      tenantId,
      memberId,
      mode,
      type: 'member',
      status: 'skipped',
      reason: 'Member not found',
    });
    return;
  }

  const memberName = member.name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Member';

  if (simResult.existingRecord) {
    results.skipped++;
    results.details.push({
      tenantId,
      memberId,
      memberName,
      mode,
      type: 'member',
      status: 'skipped',
      reason: `Record for ${simResult.membershipYear.label} already exists (safety check in processMemberRenewal)`,
    });
    console.log(`[cron/process-membership-renewals] DUPLICATE PREVENTION: Skipped member ${memberName} - record for ${simResult.membershipYear.label} already exists`);
    return;
  }

  const membershipYear = simResult.membershipYear;
  const finalCost = simResult.finalCost;
  const annualCost = simResult.annualCost;
  const tierLabel = simResult.tierLabel;
  const currency = simResult.currency;
  const yearNumber = simResult.yearNumber;
  const goLiveDate = simResult.goLiveDate;
  const freeDiscount = simResult.freeDiscount || 0;
  const rolloverDiscount = simResult.rolloverDiscount || 0;
  const customDiscountTotal = simResult.customDiscountTotal || 0;
  const customDiscountDetails = simResult.customDiscountDetails || [];

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
    console.log(`[cron/process-membership-renewals] Could not fetch PO for member ${memberId} (non-fatal):`, poErr.message);
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
      free_period_discount: freeDiscount,
      rollover_discount: rolloverDiscount,
      custom_discount_total: customDiscountTotal,
      custom_discount_details: customDiscountDetails.length > 0 ? customDiscountDetails : null,
      final_cost: finalCost,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: simResult.totalWithVat || finalCost,
      year_number: yearNumber,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'active',
      notes: `${mode === 'automatic' ? 'Automatic' : 'Scheduled'} renewal via cron job (year ${yearNumber}, member: ${memberName})`,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      results.skipped++;
      results.details.push({
        tenantId,
        memberId,
        memberName,
        mode,
        type: 'member',
        status: 'skipped',
        reason: `Duplicate record prevented by database constraint for ${membershipYear.label}`,
      });
      console.log(`[cron/process-membership-renewals] DB CONSTRAINT: Duplicate prevented for member ${memberName} - ${membershipYear.label}`);
      return;
    }
    throw new Error(`Failed to create member history record: ${insertError.message}`);
  }

  let xeroInvoice = null;
  if (createInvoice) {
    try {
      const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;
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
          console.error(`[cron/process-membership-renewals] Failed to link Xero invoice for member ${memberId}:`, linkError.message);
        }
      }
    } catch (xeroErr) {
      console.error(`[cron/process-membership-renewals] Xero invoice failed for member ${memberId} (non-fatal):`, xeroErr.message);
    }
  }

  if (xeroInvoice && member.email) {
    try {
      await sendMemberInvoiceEmailFromCron({
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
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice email failed for member ${memberId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const modeLabel = mode === 'automatic' ? 'Automatic' : 'Scheduled';
    let noteContent = `[Membership Renewal - ${modeLabel}] Membership renewed for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}.`;
    if (createInvoice) {
      noteContent += xeroInvoice
        ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
        : ' Xero invoice could not be created - check Xero connection.';
    } else {
      noteContent += ' Invoice will be generated on the scheduled date.';
    }
    await supabase
      .from('member_note')
      .insert({
        member_id: memberId,
        created_by: null,
        content: noteContent,
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create note for member ${memberId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    memberId,
    memberName,
    mode,
    type: 'member',
    action: createInvoice ? 'renewed_and_invoiced' : 'renewed',
    status: 'processed',
    membershipYear: membershipYear.label,
    yearNumber,
    goLiveDate: goLiveDate || null,
    finalCost,
    freeDiscount,
    rolloverDiscount,
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Renewed member: ${memberName} for ${membershipYear.label} (year ${yearNumber}), cost: ${finalCost.toFixed(2)}, free: ${freeDiscount.toFixed(2)}, rollover: ${rolloverDiscount.toFixed(2)}, invoice: ${createInvoice ? (xeroInvoice?.invoice_number || 'failed') : 'deferred'}`);
}

async function invoiceExistingMemberRecord(tenantId, memberId, simResult, results) {
  const existingRecord = simResult.existingRecord;
  if (!existingRecord) return;

  const member = simResult.member;
  if (!member) return;

  const memberName = member.name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Member';

  const { data: record } = await supabase
    .from('member_membership_history')
    .select('*')
    .eq('id', existingRecord.id)
    .single();

  if (!record) return;

  let bandVatRate = simResult.taxType || record.vat_rate || null;
  if (!bandVatRate && record.band_id) {
    try {
      const { data: band } = await supabase
        .from('membership_tier_band')
        .select('vat_rate')
        .eq('id', record.band_id)
        .maybeSingle();
      bandVatRate = band?.vat_rate || null;
    } catch {}
  }

  let poNumber = record.purchase_order_number || null;
  if (!poNumber) {
    try {
      const { data: invoicingSetting } = await supabase
        .from('member_membership_invoicing')
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq('member_id', memberId)
        .eq('membership_year', record.membership_year)
        .maybeSingle();
      poNumber = invoicingSetting?.purchase_order_number || null;
    } catch {}
  }

  let xeroInvoice = null;
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    xeroInvoice = await createXeroMembershipInvoice({
      appTenantId: tenantId,
      organizationName: memberName,
      invoicingAddress: null,
      membershipYear: record.membership_year,
      tierLabel: record.tier_label,
      finalCost: parseFloat(record.final_cost),
      currency: record.currency || 'GBP',
      reference: xeroReference,
      vatRate: bandVatRate,
      invoiceDescription: simResult.config?.invoice_description || null,
    });

    if (xeroInvoice) {
      await supabase
        .from('member_membership_history')
        .update({
          xero_invoice_id: xeroInvoice.invoice_id,
          xero_invoice_number: xeroInvoice.invoice_number,
        })
        .eq('id', existingRecord.id);
    }
  } catch (xeroErr) {
    console.error(`[cron/process-membership-renewals] Scheduled Xero invoice failed for member ${memberId} (non-fatal):`, xeroErr.message);
  }

  if (xeroInvoice && member.email) {
    try {
      await sendMemberInvoiceEmailFromCron({
        tenantId,
        memberId,
        memberName,
        memberEmail: member.email,
        membershipYear: record.membership_year,
        finalCost: parseFloat(record.final_cost),
        currency: record.currency || 'GBP',
        tierLabel: record.tier_label,
        xeroInvoiceNumber: xeroInvoice.invoice_number,
        xeroInvoiceId: xeroInvoice.invoice_id,
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice email failed for member ${memberId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const invoiceNote = xeroInvoice
      ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
      : ' Xero invoice could not be created - check Xero connection.';
    await supabase
      .from('member_note')
      .insert({
        member_id: memberId,
        created_by: null,
        content: `[Membership Invoice - Scheduled] Invoice generated for ${record.membership_year}. Fee: ${record.currency || 'GBP'} ${parseFloat(record.final_cost).toFixed(2)}.${invoiceNote}`,
      });
  } catch (noteErr) {
    console.error(`[cron/process-membership-renewals] Failed to create invoice note for member ${memberId} (non-fatal):`, noteErr);
  }

  results.processed++;
  results.details.push({
    tenantId,
    memberId,
    memberName,
    mode: 'scheduled',
    type: 'member',
    action: 'invoiced',
    status: 'processed',
    membershipYear: record.membership_year,
    finalCost: parseFloat(record.final_cost),
    xeroInvoice: xeroInvoice?.invoice_number || null,
  });

  console.log(`[cron/process-membership-renewals] Scheduled member invoice: ${memberName} for ${record.membership_year}, cost: ${parseFloat(record.final_cost).toFixed(2)}, invoice: ${xeroInvoice?.invoice_number || 'none'}`);
}

async function sendMemberInvoiceEmailFromCron({
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
  onlineInvoiceUrl,
}) {
  if (!xeroInvoiceId || !xeroInvoiceNumber || !memberEmail) return;

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

    console.log(`[cron/process-membership-renewals] Sent member invoice email to ${memberEmail} for ${membershipYear}`);
  } catch (err) {
    console.error(`[cron/process-membership-renewals] Member invoice email error:`, err.message);
  }
}
