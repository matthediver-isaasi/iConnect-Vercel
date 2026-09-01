import { supabase } from '../_lib/database.js';
import { getAccountingProvider, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { loadAddonLines, computeAddonTotals, buildExtraLineItems, buildAddonDisplayLines, processTrainingFundAddons } from '../_lib/membershipAddons.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { sendMembershipInvoiceEmail } from '../_lib/membershipInvoiceEmail.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import { processTenantReminders } from '../_lib/membershipReminders.js';
import { processTenantDdRenewals } from '../_lib/gocardlessDdRenewals.js';
import { processTenantCardRenewals } from '../_lib/stripeCardRenewals.js';
import { getPausedMemberIdSet, processPauseAutoRestarts } from '../_lib/memberPause.js';
import {
  resolveMembershipInvoiceAddress,
  shouldSuppressAnnualInvoice,
} from '../_lib/membershipInstalmentInvoicing.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';
import {
  canActivateScheduledMembershipWithoutInvoice,
  isZeroDueExistingMembership,
  isZeroDueMembership,
  zeroDuePaymentFields,
  fireNewZeroDueMembershipPaidWorkflow,
} from '../_lib/zeroDueMembership.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/process-membership-renewals] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.membershipRenewals,
  });

  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }

  const startTime = Date.now();
  const results = { processed: 0, skipped: 0, errors: 0, details: [] };

  try {
    // Task #3586: scheduled pause restarts run every hour for ALL tenants
    // (deliberately outside the per-tenant cron-hour gate so access is
    // restored on the restart date, not at the tenant's billing hour).
    try {
      await processPauseAutoRestarts(results);
    } catch (pauseErr) {
      console.error('[cron/process-membership-renewals] Pause auto-restart sweep failed:', pauseErr);
      results.errors++;
      results.details.push({ step: 'pause-auto-restart', error: pauseErr.message });
    }

    const { data: configs, error: configError } = await supabase
      .from('membership_tier_config')
      .select('*')
      .is('effective_to', null);

    if (configError) {
      console.error('[cron/process-membership-renewals] Error fetching configs:', configError);
      await reportHeartbeat(false);
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
          await activateScheduledRecords(tenantId, results);
        } catch (activateErr) {
          console.error(`[cron/process-membership-renewals] Error activating scheduled records for tenant ${tenantId}:`, activateErr);
          results.errors++;
          results.details.push({ tenantId, error: `Scheduled activation: ${activateErr.message}` });
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

        try {
          await processTenantDdRenewals(tenantId, results);
        } catch (ddErr) {
          console.error(`[cron/process-membership-renewals] Error processing DD renewals for tenant ${tenantId}:`, ddErr);
          results.errors++;
          results.details.push({ tenantId, error: `DD renewals: ${ddErr.message}` });
        }

        try {
          await processTenantCardRenewals(tenantId, results);
        } catch (cardErr) {
          console.error(`[cron/process-membership-renewals] Error processing card renewals for tenant ${tenantId}:`, cardErr);
          results.errors++;
          results.details.push({ tenantId, error: `Card renewals: ${cardErr.message}` });
        }

        try {
          await processTenantReminders(tenantId, results);
        } catch (reminderErr) {
          console.error(`[cron/process-membership-renewals] Error processing reminders for tenant ${tenantId}:`, reminderErr);
          results.errors++;
          results.details.push({ tenantId, error: `Reminders: ${reminderErr.message}` });
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

    await reportHeartbeat(results.errors === 0);
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

    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Activate advance-invoiced ("Invoice Now") membership records on their normal
// start date. These rows were created with status='scheduled' and an invoice
// already attached, so activation must NOT generate another invoice or email.
async function activateScheduledRecords(tenantId, results) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split('T')[0];

  const { data: rows, error } = await supabase
    .from('organisation_membership_history')
    .select('id, organization_id, membership_year, scheduled_activation_date, xero_invoice_id, accounting_invoice_id, payment_status, paid_at, final_cost, total_with_vat')
    .eq('tenant_id', tenantId)
    .eq('status', 'scheduled')
    .lte('scheduled_activation_date', todayStr);

  if (error) {
    // Table or column not yet present — nothing to activate.
    if (error.code === '42P01' || error.code === '42703') return;
    throw error;
  }

  if (!rows || rows.length === 0) return;

  for (const row of rows) {
    const invoiceLessZeroDue = !row.xero_invoice_id
      && !row.accounting_invoice_id
      && canActivateScheduledMembershipWithoutInvoice(row);

    // Advance zero-due rows have no accounting invoice by design. Their
    // durable delivery may have failed after the original insert, so retry it
    // before activation; a failure bubbles to the cron retry path.
    if (invoiceLessZeroDue) {
      await fireNewZeroDueMembershipPaidWorkflow({
        table: 'organisation_membership_history',
        row,
        paidAt: row.paid_at,
        source: 'cron_org_membership_zero_due',
      });
    }

    // Defense in depth: an advance-invoiced row must have a linked invoice
    // before we activate it. Activating a 'scheduled' row with no invoice would
    // create a membership year that is active but never billed. The advance
    // handler is strict (it rolls back when no invoice is produced), so this
    // should not normally happen — but never silently activate an unbilled row.
    if (!row.xero_invoice_id && !row.accounting_invoice_id && !invoiceLessZeroDue) {
      results.skipped++;
      results.details.push({
        tenantId,
        orgId: row.organization_id,
        status: 'skipped',
        reason: `Scheduled membership for ${row.membership_year} has no linked invoice — not activated (needs attention)`,
      });
      continue;
    }

    const { data: updated, error: upErr } = await supabase
      .from('organisation_membership_history')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id');

    if (upErr) {
      results.errors++;
      results.details.push({
        tenantId,
        orgId: row.organization_id,
        status: 'error',
        reason: `Failed to activate advance-invoiced record for ${row.membership_year}: ${upErr.message}`,
      });
      continue;
    }

    // Another run may have already flipped it (guarded by status='scheduled').
    if (!updated || updated.length === 0) continue;

    results.processed++;
    results.details.push({
      tenantId,
      orgId: row.organization_id,
      status: 'processed',
      reason: `Activated advance-invoiced membership for ${row.membership_year} (no new invoice generated)`,
    });

    try {
      await supabase.from('organization_note').insert({
        organization_id: row.organization_id,
        member_id: null,
        content: `[Membership Renewal - Scheduled Activation] Advance-invoiced membership for ${row.membership_year} activated on its start date. No new invoice was generated.`,
        attachments: [],
      });
    } catch (noteErr) {
      console.error('[cron/process-membership-renewals] Failed to create activation note (non-fatal):', noteErr.message);
    }
  }
}

async function processTenantRenewals(tenantId, results) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data: invoicingRows, error: invError } = await supabase
    .from('organisation_membership_invoicing')
    .select('organization_id, invoicing_mode, membership_year, invoice_date')
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
        } else if (simResult.existingRecord && !simResult.existingRecord.xero_invoice_id && !simResult.existingRecord.accounting_invoice_id) {
          const invoiceDue = isInvoiceDateReached(invoicingSetting, today);
          await invoiceExistingRecord(tenantId, orgId, simResult, results, invoiceDue);
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

async function invoiceExistingRecord(tenantId, orgId, simResult, results, invoiceDue = true) {
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

  const existingAddonLines = await loadAddonLines(tenantId, orgId, record.membership_year);
  if (record.payment_status === 'paid' && !record.xero_invoice_id && !record.accounting_invoice_id
    && isZeroDueExistingMembership(record)) {
    await fireNewZeroDueMembershipPaidWorkflow({
      table: 'organisation_membership_history',
      row: record,
      paidAt: record.paid_at,
      source: 'cron_org_membership_zero_due',
    });
    results.processed++;
    results.details.push({ tenantId, orgId, status: 'processed', action: 'zero_due_workflow_delivery_retried', membershipYear: record.membership_year });
    return;
  }
  if (!invoiceDue) {
    results.skipped++;
    return;
  }

  // Task #3633: a row linked to a per-instalment monthly plan is invoiced
  // one small invoice per collection — never raise an annual invoice for it.
  try {
    if (await shouldSuppressAnnualInvoice(record)) {
      results.skipped++;
      results.details.push({ tenantId, orgId, status: 'skipped', reason: `Membership ${record.membership_year} is on a per-instalment monthly plan — annual invoice suppressed` });
      return;
    }
  } catch (suppressErr) {
    // FAIL CLOSED: if we can't determine the invoicing mode, withhold the
    // annual invoice — the next cron run retries; a wrong invoice wouldn't.
    results.skipped++;
    results.details.push({ tenantId, orgId, status: 'skipped', reason: `Annual invoice withheld — could not verify invoicing mode: ${suppressErr.message}` });
    return;
  }

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

  // Add-on lines stored at fee-approval time. When the record was created by
  // processOrgRenewal with add-ons present, the add-on subtotal was baked
  // into final_cost and the notes carry an explicit "add-on line(s) included"
  // marker — only then do we subtract it back out for the membership fee
  // line (the add-ons go on the invoice as their own extra line items).
  // Records created without that marker keep their full final_cost so we
  // never underbill.
  const addonLines = existingAddonLines;
  const addonTotals = computeAddonTotals(addonLines);
  const addonsBaked = /add-on line\(s\) included/.test(record.notes || '');
  const membershipFeeCost = addonsBaked
    ? Math.max(0, Math.round((parseFloat(record.final_cost) - addonTotals.subtotal) * 100) / 100)
    : Math.round(parseFloat(record.final_cost) * 100) / 100;

  let xeroInvoice = null;
  const provider = await getAccountingProvider(tenantId);
  const providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    const resolvedAddr = await resolveMembershipInvoiceAddress({
      db: supabase, row: record, config: simResult.config, entityId: orgId, entityType: 'organization',
    });
    xeroInvoice = await provider.createMembershipInvoice({
      appTenantId: tenantId,
      organizationName: org.name,
      invoicingEmail: org.invoicing_email || null,
      invoicingAddress: resolvedAddr,
      membershipYear: record.membership_year,
      tierLabel: record.tier_label,
      finalCost: membershipFeeCost,
      currency: record.currency || 'GBP',
      reference: xeroReference,
      vatRate: bandVatRate,
      nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
      invoiceDescription: simResult.config?.invoice_description || null,
      extraLineItems: buildExtraLineItems(addonLines),
    });

    if (xeroInvoice) {
      const invoiceUpdate = buildInvoiceColumnUpdate(xeroInvoice);
      if (!addonsBaked && addonLines.length > 0) {
        // The stored record predates the add-on bake — fold the addon
        // totals in now so stored totals match the invoice just created.
        invoiceUpdate.final_cost = Math.round((parseFloat(record.final_cost || 0) + addonTotals.subtotal) * 100) / 100;
        invoiceUpdate.vat_amount = Math.round((parseFloat(record.vat_amount || 0) + addonTotals.vat) * 100) / 100;
        invoiceUpdate.total_with_vat = Math.round((parseFloat(record.total_with_vat || record.final_cost || 0) + addonTotals.total) * 100) / 100;
        invoiceUpdate.notes = `${record.notes || ''} ${addonLines.length} add-on line(s) included.`.trim();
      }
      await supabase
        .from('organisation_membership_history')
        .update(invoiceUpdate)
        .eq('id', existingRecord.id);

      try {
        await processTrainingFundAddons({
          tenantId,
          organizationId: orgId,
          invoice: xeroInvoice,
          addonLines,
        });
      } catch (tfErr) {
        console.error(`[cron/process-membership-renewals] Training fund add-on processing failed for org ${orgId} (non-fatal):`, tfErr.message);
      }
    }
  } catch (xeroErr) {
    console.error(`[cron/process-membership-renewals] Scheduled ${providerLabel} invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
  }

  if (xeroInvoice) {
    try {
      if (poNumber) {
        // PO already on file → send the traditional invoice email with the Xero link.
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
          tierConfig: simResult.config,
        });
      } else {
        // No PO → mint a membership_fee_token and send the
        // Pay-by-card / Submit-PO email (mirrors manual "Email fees" flow).
        // The pre-created Xero invoice details are attached to the token so
        // PO submission can push the PO into the Xero Reference, and Stripe
        // payment can apply against the existing invoice instead of creating
        // a duplicate. (Task #990)
        const { sendMembershipFeeTokenEmail } = await import('../_lib/membershipFeeTokenEmail.js');
        const stripeEnabled = !!simResult.config?.online_card_payment;
        // Token totals are membership fee + add-ons, matching the invoice
        // just created (membershipFeeCost is the membership-only figure
        // regardless of whether the stored record had add-ons baked in).
        const tokenFinalCost = Math.round((membershipFeeCost + addonTotals.subtotal) * 100) / 100;
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
          vatRatePercent: simResult.vatRatePercent || null,
          vatAmount: Math.round(((simResult.vatAmount || 0) + addonTotals.vat) * 100) / 100,
          totalWithVat: Math.round(((simResult.totalWithVat || membershipFeeCost) + addonTotals.total) * 100) / 100,
          taxLabel: simResult.taxLabel || null,
          ...(addonLines.length > 0 ? { addonLines: buildAddonDisplayLines(addonLines) } : {}),
        };
        await sendMembershipFeeTokenEmail({
          client: supabase,
          tenantId,
          organizationId: orgId,
          organizationName: org.name,
          membershipYear: record.membership_year,
          finalCost: tokenFinalCost,
          currency: record.currency || 'GBP',
          tierLabel: record.tier_label,
          costBreakdown,
          poNumber: null,
          stripeEnabled,
          tierConfig: simResult.config,
          xeroInvoiceId: xeroInvoice.invoice_id,
          xeroInvoiceNumber: xeroInvoice.invoice_number,
          xeroOnlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
          historyRecordId: existingRecord.id,
        });
      }
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice/fee email failed for org ${orgId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const invoiceNote = xeroInvoice
      ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
      : ` ${providerLabel} invoice could not be created - check ${providerLabel} connection.`;
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

  // Add-ons and VAT are part of the amount due. Decide before touching PO or
  // any other invoice-only data.
  const addonLines = await loadAddonLines(tenantId, orgId, membershipYear.label);
  const addonTotals = computeAddonTotals(addonLines);
  const zeroDue = isZeroDueMembership(simResult, addonTotals);
  const paidAt = zeroDue ? new Date().toISOString() : null;

  let poNumber = null;
  try {
    if (!zeroDue) {
      const { data: invoicingSetting } = await supabase
        .from('organisation_membership_invoicing')
        .select('purchase_order_number')
        .eq('tenant_id', tenantId)
        .eq('organization_id', orgId)
        .eq('membership_year', membershipYear.label)
        .maybeSingle();
      poNumber = invoicingSetting?.purchase_order_number || null;
    }
  } catch (poErr) {
    console.log(`[cron/process-membership-renewals] Could not fetch PO for org ${orgId} (non-fatal):`, poErr.message);
  }

  // Add-on lines stored at fee-approval time. ALWAYS bake them into the
  // stored history totals — even when the invoice is deferred (scheduled
  // mode) — because invoiceExistingRecord later derives the membership fee
  // line by subtracting the addon subtotal from record.final_cost. If the
  // record were stored without add-ons, that subtraction would underbill.
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
      final_cost: Math.round((finalCost + addonTotals.subtotal) * 100) / 100,
      currency: currency,
      billing_period: simResult.billingPeriod || 'annual',
      purchase_order_number: poNumber,
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: Math.round(((simResult.vatAmount || 0) + addonTotals.vat) * 100) / 100,
      total_with_vat: Math.round(((simResult.totalWithVat || finalCost) + addonTotals.total) * 100) / 100,
      year_number: yearNumber,
      prorata_days: simResult.prorataDays || null,
      free_period_days_applied: simResult.freePeriodDaysApplied || 0,
      override_applied: simResult.overrideApplied || false,
      override_type: simResult.overrideType || null,
      status: 'active',
      notes: `${mode === 'automatic' ? 'Automatic' : 'Scheduled'} renewal via cron job (year ${yearNumber}, go-live: ${goLiveDate})${addonLines.length > 0 ? `. ${addonLines.length} add-on line(s) included.` : ''}`,
      ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
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

  if (zeroDue) {
    await fireNewZeroDueMembershipPaidWorkflow({
      table: 'organisation_membership_history',
      row: record,
      paidAt,
      source: 'cron_org_membership_zero_due',
    });

    results.processed++;
    results.details.push({
      tenantId,
      orgId,
      orgName: org.name,
      mode,
      action: 'renewed_zero_due',
      status: 'processed',
      membershipYear: membershipYear.label,
      yearNumber,
      goLiveDate: goLiveDate || null,
      finalCost,
      xeroInvoice: null,
    });
    return;
  }

  let xeroInvoice = null;
  let providerLabel = 'Xero';
  if (createInvoice) {
    try {
      const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;
      const xeroReference = poNumber
        ? `Membership ${membershipYear.label} - PO: ${poNumber}`
        : `Membership ${membershipYear.label}`;
      const resolvedOrgAddr = await resolveMembershipInvoiceAddress({
        db: supabase, row: record, config: simResult.config, entityId: orgId, entityType: 'organization',
      });
      const provider = await getAccountingProvider(tenantId);
      providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
      xeroInvoice = await provider.createMembershipInvoice({
        appTenantId: tenantId,
        organizationName: org.name,
        invoicingEmail: org.invoicing_email || null,
        invoicingAddress: resolvedOrgAddr,
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
          console.error(`[cron/process-membership-renewals] Failed to link ${providerLabel} invoice for org ${orgId}:`, linkError.message);
        }

        try {
          await processTrainingFundAddons({
            tenantId,
            organizationId: orgId,
            invoice: xeroInvoice,
            addonLines,
          });
        } catch (tfErr) {
          console.error(`[cron/process-membership-renewals] Training fund add-on processing failed for org ${orgId} (non-fatal):`, tfErr.message);
        }
      }
    } catch (xeroErr) {
      console.error(`[cron/process-membership-renewals] ${providerLabel} invoice failed for org ${orgId} (non-fatal):`, xeroErr.message);
    }
  }

  if (xeroInvoice) {
    try {
      if (poNumber) {
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
          tierConfig: simResult.config,
        });
      } else {
        // No PO → mint membership_fee_token and send Pay-by-card/Submit-PO
        // email. Pre-created Xero invoice details are attached to the token
        // so PO submission can push the PO to Xero and Stripe payment can
        // apply against the existing invoice instead of creating a duplicate.
        // (Task #990)
        const { sendMembershipFeeTokenEmail } = await import('../_lib/membershipFeeTokenEmail.js');
        const stripeEnabled = !!simResult.config?.online_card_payment;
        // Token totals include add-on lines so the email/PO page matches the
        // invoice just created (record.final_cost is stored addon-inclusive).
        const tokenFinalCost = Math.round((finalCost + addonTotals.subtotal) * 100) / 100;
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
          vatRatePercent: simResult.vatRatePercent || null,
          vatAmount: Math.round(((simResult.vatAmount || 0) + addonTotals.vat) * 100) / 100,
          totalWithVat: Math.round(((simResult.totalWithVat || finalCost) + addonTotals.total) * 100) / 100,
          taxLabel: simResult.taxLabel || null,
          ...(addonLines.length > 0 ? { addonLines: buildAddonDisplayLines(addonLines) } : {}),
        };
        const sendResult = await sendMembershipFeeTokenEmail({
          client: supabase,
          tenantId,
          organizationId: orgId,
          organizationName: org.name,
          membershipYear: membershipYear.label,
          finalCost: tokenFinalCost,
          currency,
          tierLabel,
          costBreakdown,
          poNumber: null,
          stripeEnabled,
          tierConfig: simResult.config,
          xeroInvoiceId: xeroInvoice.invoice_id,
          xeroInvoiceNumber: xeroInvoice.invoice_number,
          xeroOnlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
          historyRecordId: record.id,
        });
        if (sendResult && sendResult.success === false) {
          console.error(`[cron/process-membership-renewals] Fee token email reported failure for org ${orgId}:`, sendResult.error || 'unknown');
        }
      }
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice/fee email failed for org ${orgId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const modeLabel = mode === 'automatic' ? 'Automatic' : 'Scheduled';
    let noteContent = `[Membership Renewal - ${modeLabel}] Membership renewed for ${membershipYear.label}. Fee: ${currency} ${finalCost.toFixed(2)}.`;
    if (createInvoice) {
      noteContent += xeroInvoice
        ? ` ${providerLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
        : ` ${providerLabel} invoice could not be created - check ${providerLabel} connection.`;
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
    .select('member_id, invoicing_mode, membership_year, invoice_date')
    .eq('tenant_id', tenantId)
    .in('invoicing_mode', ['automatic', 'scheduled']);

  if (invError) {
    if (invError.code === '42P01') return;
    throw invError;
  }

  if (!invoicingRows || invoicingRows.length === 0) return;

  // Task #3586: paused members are excluded from renewal invoicing entirely.
  const pausedMemberIds = await getPausedMemberIdSet(tenantId);

  for (const invoicingSetting of invoicingRows) {
    const memberId = invoicingSetting.member_id;
    if (pausedMemberIds.has(memberId)) {
      results.skipped++;
      results.details.push({ tenantId, memberId, type: 'member', status: 'skipped', reason: 'Membership paused' });
      continue;
    }
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
          await invoiceExistingMemberRecord(tenantId, memberId, simResult, results, invoiceDue);
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
      ...(zeroDue ? zeroDuePaymentFields(paidAt) : {}),
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

  if (zeroDue) {
    await fireNewZeroDueMembershipPaidWorkflow({
      table: 'member_membership_history',
      row: record,
      paidAt,
      source: 'cron_member_membership_zero_due',
    });

    results.processed++;
    results.details.push({
      tenantId,
      memberId,
      memberName,
      mode,
      type: 'member',
      action: 'renewed_zero_due',
      status: 'processed',
      membershipYear: membershipYear.label,
      yearNumber,
      goLiveDate: goLiveDate || null,
      finalCost,
      xeroInvoice: null,
    });
    return;
  }

  let xeroInvoice = null;
  let memberProviderLabel = 'Xero';
  if (createInvoice) {
    try {
      const bandVatRate = simResult.taxType || simResult.matchedBand?.vat_rate || null;
      const xeroReference = poNumber
        ? `Membership ${membershipYear.label} - PO: ${poNumber}`
        : `Membership ${membershipYear.label}`;
      const resolvedMemberAddr = await resolveMembershipInvoiceAddress({
        db: supabase, row: record, config: simResult.config, entityId: memberId, entityType: 'member',
      });
      const memberProvider = await getAccountingProvider(tenantId);
      memberProviderLabel = memberProvider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
      xeroInvoice = await memberProvider.createMembershipInvoice({
        appTenantId: tenantId,
        organizationName: memberName,
        invoicingEmail: member.email || null,
        invoicingAddress: resolvedMemberAddr,
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
          console.error(`[cron/process-membership-renewals] Failed to link ${memberProviderLabel} invoice for member ${memberId}:`, linkError.message);
        }
      }
    } catch (xeroErr) {
      console.error(`[cron/process-membership-renewals] ${memberProviderLabel} invoice failed for member ${memberId} (non-fatal):`, xeroErr.message);
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
        historyRecordId: record.id,
        vatAmount: simResult.vatAmount || 0,
        totalWithVat: simResult.totalWithVat || finalCost,
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
        ? ` ${memberProviderLabel} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
        : ` ${memberProviderLabel} invoice could not be created - check ${memberProviderLabel} connection.`;
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

async function invoiceExistingMemberRecord(tenantId, memberId, simResult, results, invoiceDue = true) {
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

  if (record.payment_status === 'paid' && !record.xero_invoice_id && !record.accounting_invoice_id
    && isZeroDueExistingMembership(record)) {
    await fireNewZeroDueMembershipPaidWorkflow({
      table: 'member_membership_history',
      row: record,
      paidAt: record.paid_at,
      source: 'cron_member_membership_zero_due',
    });
    results.processed++;
    results.details.push({ tenantId, memberId, type: 'member', status: 'processed', action: 'zero_due_workflow_delivery_retried', membershipYear: record.membership_year });
    return;
  }
  if (!invoiceDue) {
    results.skipped++;
    return;
  }

  // Task #3633: per-instalment monthly plan rows never get an annual invoice.
  try {
    if (await shouldSuppressAnnualInvoice(record)) {
      results.skipped++;
      results.details.push({ tenantId, memberId, type: 'member', status: 'skipped', reason: `Membership ${record.membership_year} is on a per-instalment monthly plan — annual invoice suppressed` });
      return;
    }
  } catch (suppressErr) {
    // FAIL CLOSED: withhold the annual invoice when the mode is unknowable.
    results.skipped++;
    results.details.push({ tenantId, memberId, type: 'member', status: 'skipped', reason: `Annual invoice withheld — could not verify invoicing mode: ${suppressErr.message}` });
    return;
  }

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
  const memberProvider2 = await getAccountingProvider(tenantId);
  const memberProviderLabel2 = memberProvider2?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    const resolvedMemberAddr2 = await resolveMembershipInvoiceAddress({
      db: supabase, row: record, config: simResult.config, entityId: memberId, entityType: 'member',
    });
    xeroInvoice = await memberProvider2.createMembershipInvoice({
      appTenantId: tenantId,
      organizationName: memberName,
      invoicingEmail: member.email || null,
      invoicingAddress: resolvedMemberAddr2,
      membershipYear: record.membership_year,
      tierLabel: record.tier_label,
      finalCost: parseFloat(record.final_cost),
      currency: record.currency || 'GBP',
      reference: xeroReference,
      vatRate: bandVatRate,
      nominalCode: await resolveMembershipNominalCode(supabase, tenantId, simResult),
      invoiceDescription: simResult.config?.invoice_description || null,
    });

    if (xeroInvoice) {
      await supabase
        .from('member_membership_history')
        .update(buildInvoiceColumnUpdate(xeroInvoice))
        .eq('id', existingRecord.id);
    }
  } catch (xeroErr) {
    console.error(`[cron/process-membership-renewals] Scheduled ${memberProviderLabel2} invoice failed for member ${memberId} (non-fatal):`, xeroErr.message);
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
        historyRecordId: existingRecord.id,
        vatAmount: parseFloat(record.vat_amount || 0),
        totalWithVat: parseFloat(record.total_with_vat || record.final_cost),
        onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
      });
    } catch (emailErr) {
      console.error(`[cron/process-membership-renewals] Invoice email failed for member ${memberId} (non-fatal):`, emailErr.message);
    }
  }

  try {
    const invoiceNote = xeroInvoice
      ? ` ${memberProviderLabel2} invoice ${xeroInvoice.invoice_number || '(no invoice number)'} created.`
      : ` ${memberProviderLabel2} invoice could not be created - check ${memberProviderLabel2} connection.`;
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
  historyRecordId,
  vatAmount,
  totalWithVat,
  onlineInvoiceUrl,
}) {
  if (!xeroInvoiceId || !memberEmail) return;

  // Fallback to public PDF token when no provider-hosted invoice link exists.
  let viewInvoiceUrl = onlineInvoiceUrl || null;
  let tenantBrand = null;
  try {
    const { data: t } = await supabase
      .from('tenant')
      .select('name, slug, logo_url, primary_color')
      .eq('id', tenantId)
      .maybeSingle();
    tenantBrand = t || null;
  } catch {}
  if (!viewInvoiceUrl && historyRecordId) {
    try {
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
    } catch (tokenErr) {
      console.warn('[cron/process-membership-renewals] Member PDF token fallback failed (non-fatal):', tokenErr.message);
    }
  }

  // QBO may legitimately return no DocNumber when "Custom transaction numbers"
  // is enabled. Send the email anyway but omit the invoice-number row and drop
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
