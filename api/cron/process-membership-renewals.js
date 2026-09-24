import { supabase } from '../_lib/database.js';
import { getAccountingProvider, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { loadAddonLines, computeAddonTotals, buildExtraLineItems, buildAddonDisplayLines, processTrainingFundAddons } from '../_lib/membershipAddons.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { membershipIncentiveSnapshot } from '../_lib/membershipIncentiveSnapshot.js';
import { sendMembershipInvoiceEmail } from '../_lib/membershipInvoiceEmail.js';
import { sendTenantEmail } from '../_lib/tenantEmailService.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import { processTenantReminders } from '../_lib/membershipRemindersLive.js';
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
import { processTenantAnnualExpirySweep } from '../_lib/annualMembershipExpiryEnforcement.js';
import { invalidateMemberSessions } from '../_lib/session.js';
import { annualRecordSchedule, resolveEntityAnnualRenewalEligibility } from '../_lib/annualRenewalPolicy.js';
import { upfrontRollingCommitment } from '../_lib/upfrontRollingRenewal.js';
import { runMembershipRenewals } from '../_lib/membershipRenewalRunner.js';
import { renewalRows } from '../_lib/membershipRenewalBudget.js';
import { selectScheduledActivations, runScheduledActivation } from '../_lib/directDebitOwnerPipeline.js';
import { selectAnnualOwnerSettings, runAnnualOwnerRow } from '../_lib/annualOwnerRenewalPipeline.js';

export function buildCronRollingFields(simResult, eligibility, addonTotals = { subtotal: 0, vat: 0, total: 0 }) {
  if (simResult.config?.start_mode !== 'immediate') return {};
  return {
    ...annualRecordSchedule(eligibility),
    ...upfrontRollingCommitment(simResult, { addonTotals }),
  };
}

async function resolveCronRollingFields(tenantId, owner, simResult, addonTotals) {
  if (simResult.config?.start_mode !== 'immediate') return {};
  const eligibility = await resolveEntityAnnualRenewalEligibility(supabase, {
    tenantId, ...owner, config: simResult.config, membershipYear: simResult.membershipYear,
  });
  if (!eligibility.eligible) throw new Error(eligibility.message || 'Rolling renewal is not eligible.');
  return buildCronRollingFields(simResult, eligibility, addonTotals);
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) return res.status(503).json({ error: 'Cron authentication is not configured' });
  if (authHeader !== `Bearer ${cronSecret}`) {
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

  const results = await runMembershipRenewals({
    db: supabase,
    pause: processPauseAutoRestarts,
    expiry: (db, tenantId, results, now, options) => processTenantAnnualExpirySweep(db, tenantId, results, now, {
      ...options, invalidateSessions: invalidateMemberSessions,
    }),
    stages: [
      ['organisation-activation', activateScheduledRecords],
      ['member-activation', activateScheduledMemberRecords],
      ['organisation-renewals', processTenantRenewals],
      ['member-renewals', processTenantMemberRenewals],
      ['direct-debit-renewals', processTenantDdRenewals],
      ['card-renewals', processTenantCardRenewals],
      ['reminders', processTenantReminders],
    ],
  });
  const heartbeat = results.heartbeat ? await reportHeartbeat(results.healthy) : { sent: false, reason: 'busy' };
  console.log(JSON.stringify({ job: 'membership_renewals', stage: 'heartbeat', outcome: results.outcome, ...heartbeat }));
  return res.status(results.outcome === 'busy' ? 202 : results.healthy ? 200 : 500).json({
    success: results.healthy, outcome: results.outcome, duration_ms: results.duration_ms, results, heartbeat,
  });
}

// Activate advance-invoiced ("Invoice Now") membership records on their normal
// start date. These rows were created with status='scheduled' and an invoice
// already attached, so activation must NOT generate another invoice or email.
async function activateScheduledRecords(tenantId, results) {
  const now = new Date();
  const rows = renewalRows(() => selectScheduledActivations(supabase, tenantId, 'organisation', now),
  { control: results.__renewalControl, results, missingSchema: true });
  for await (const row of rows) {
    let outcome;
    try {
      outcome = await runScheduledActivation({ row, tenantId, scope: 'organisation', now,
        effects: scheduledActivationEffects(supabase) });
    } catch (error) {
      if (error.code === 'RENEWAL_BUDGET_EXHAUSTED') throw error;
      results.errors++;
      results.details.push({ tenantId, orgId: row.organization_id, status: 'error',
        reason: `Failed to activate advance-invoiced record for ${row.membership_year}: ${error.message}` });
      continue;
    }
    if (outcome.skipped) {
      results.skipped++;
      results.details.push({ tenantId, orgId: row.organization_id, status: 'skipped', reason: outcome.reason });
      continue;
    }
    if (!outcome.activated) continue;
    results.processed++;
    results.details.push({ tenantId, orgId: row.organization_id, status: 'processed',
      reason: `Activated advance-invoiced membership for ${row.membership_year} (no new invoice generated)` });
  }
}

async function activateScheduledMemberRecords(tenantId, results) {
  const now = new Date();
  const rows = renewalRows(() => selectScheduledActivations(supabase, tenantId, 'member', now),
  { control: results.__renewalControl, results, missingSchema: true });
  for await (const row of rows) {
    const outcome = await runScheduledActivation({ row, tenantId, scope: 'member', now,
      effects: scheduledActivationEffects(supabase) });
    if (outcome.skipped) {
      results.skipped++;
      results.details.push({ tenantId, memberId: row.member_id, status: 'skipped', reason: outcome.reason });
      continue;
    }
    if (outcome.activated) {
      results.processed++;
      results.details.push({
        tenantId,
        memberId: row.member_id,
        status: 'processed',
        reason: `Activated scheduled membership for ${row.membership_year}`,
      });
    }
  }
}

export function scheduledActivationEffects(db) {
  return { async perform(operation) {
    const payload = operation.payload;
    if (operation.type === 'owner.zero_due_workflow') return fireNewZeroDueMembershipPaidWorkflow({ ...payload, client: db });
    if (operation.type === 'owner.activate_scheduled') return db.from(payload.table).update(payload.values)
      .eq('id', payload.id).eq('tenant_id', payload.tenantId).eq('status', 'scheduled').select('id');
    if (operation.type === 'owner.activation_note') {
      try { return await db.from('organization_note').insert(payload); }
      catch (error) { console.error('[cron/process-membership-renewals] Failed to create activation note (non-fatal):', error.message); return null; }
    }
    throw new Error(`Unknown scheduled activation effect: ${operation.type}`);
  } };
}
async function processTenantRenewals(tenantId, results) {
  return processAnnualOwnerRows(tenantId, 'organisation', results);
}

async function processAnnualOwnerRows(tenantId, scope, results) {
  const now = new Date();
  const column = scope === 'member' ? 'member_id' : 'organization_id';
  const rows = renewalRows(() => selectAnnualOwnerSettings(supabase, tenantId, scope),
    { key: column, control: results.__renewalControl, results, missingSchema: true });
  for await (const setting of rows) {
    try {
      await runAnnualOwnerRow({ db: supabase, tenantId, scope, setting, now,
        effects: annualOwnerEffects(results),
        trace: stage => {
          if (stage.status === 'skipped') results.skipped++;
          results.details.push({ tenantId, [scope === 'member' ? 'memberId' : 'orgId']: setting[column], ...stage });
        },
      });
    } catch (error) {
      if (error.code === 'RENEWAL_BUDGET_EXHAUSTED') throw error;
      results.errors++;
      results.details.push({ tenantId, [scope === 'member' ? 'memberId' : 'orgId']: setting[column], status: 'error', reason: error.message });
    }
  }
}

export function annualOwnerEffects(results, db = supabase) {
  return { async perform(operation) {
    const p = operation.payload;
    if (operation.type === 'owner.annual_zero_workflow') {
      const result = await fireNewZeroDueMembershipPaidWorkflow({ ...p, client: db });
      results.processed++;
      return result;
    }
    if (operation.type === 'owner.annual_history_insert') {
      const inserted = await db.from(p.table).insert(p.values).select().single();
      if (inserted.error?.code === '23505') { results.skipped++; return { duplicate: true }; }
      if (inserted.error) throw new Error(`Failed to create history record: ${inserted.error.message}`);
      const continuation = p.scope === 'member' ? processMemberRenewal : processOrgRenewal;
      await continuation(p.values.tenant_id, p.ownerId, p.sim, p.mode, p.invoiceDue, results, inserted.data, p);
      return inserted;
    }
    if (operation.type === 'owner.annual_invoice') {
      const provider = await getAccountingProvider(p.tenantId);
      const invoice = await provider.createMembershipInvoice(p.invoice);
      const continuation = p.scope === 'member' ? invoiceExistingMemberRecord : invoiceExistingRecord;
      await continuation(p.tenantId, p.ownerId, p.sim, results, p.invoiceDue, { invoice, provider, record: p.record });
      return invoice;
    }
    throw new Error(`Unknown annual owner effect: ${operation.type}`);
  } };
}

async function invoiceExistingRecord(tenantId, orgId, simResult, results, invoiceDue = true, prepared = null) {
  const existingRecord = simResult.existingRecord;
  if (!existingRecord) return;

  const org = simResult.org;
  if (!org) return;

  const { data: record } = prepared?.record ? { data: prepared.record } : await supabase
    .from('organisation_membership_history')
    .select('*')
    .eq('id', existingRecord.id)
    .single();

  if (!record) return;

  const existingAddonLines = await loadAddonLines(tenantId, orgId, record.membership_year);
  if (!prepared && record.payment_status === 'paid' && !record.xero_invoice_id && !record.accounting_invoice_id
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
    if (!prepared && await shouldSuppressAnnualInvoice(record)) {
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
  const provider = prepared?.provider || await getAccountingProvider(tenantId);
  const providerLabel = provider?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    const resolvedAddr = await resolveMembershipInvoiceAddress({
      db: supabase, row: record, config: simResult.config, entityId: orgId, entityType: 'organization',
    });
    xeroInvoice = prepared ? prepared.invoice : await provider.createMembershipInvoice({
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

async function processOrgRenewal(tenantId, orgId, simResult, mode, createInvoice, results, preparedRecord = null, preparedContext = null) {
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
  const addonLines = preparedContext?.addonLines || await loadAddonLines(tenantId, orgId, membershipYear.label);
  const addonTotals = preparedContext?.addons || computeAddonTotals(addonLines);
  const zeroDue = preparedContext?.zeroDue ?? isZeroDueMembership(simResult, addonTotals);
  const paidAt = preparedRecord?.paid_at || (zeroDue ? new Date().toISOString() : null);

  let poNumber = preparedRecord?.purchase_order_number || null;
  try {
    if (!zeroDue && !preparedRecord) {
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
  const { data: record, error: insertError } = preparedRecord ? { data: preparedRecord } : await supabase
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
      ...membershipIncentiveSnapshot(simResult),
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
      ...await resolveCronRollingFields(tenantId, { organizationId: orgId }, simResult, addonTotals),
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
  return processAnnualOwnerRows(tenantId, 'member', results);
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

async function processMemberRenewal(tenantId, memberId, simResult, mode, createInvoice, results, preparedRecord = null, preparedContext = null) {
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

  const zeroDue = preparedContext?.zeroDue ?? isZeroDueMembership(simResult);
  const paidAt = preparedRecord?.paid_at || (zeroDue ? new Date().toISOString() : null);

  let poNumber = preparedRecord?.purchase_order_number || null;
  try {
    if (!zeroDue && !preparedRecord) {
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

  const { data: record, error: insertError } = preparedRecord ? { data: preparedRecord } : await supabase
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
      ...await resolveCronRollingFields(tenantId, { memberId }, simResult),
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

async function invoiceExistingMemberRecord(tenantId, memberId, simResult, results, invoiceDue = true, prepared = null) {
  const existingRecord = simResult.existingRecord;
  if (!existingRecord) return;

  const member = simResult.member;
  if (!member) return;

  const memberName = member.name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown Member';

  const { data: record } = prepared?.record ? { data: prepared.record } : await supabase
    .from('member_membership_history')
    .select('*')
    .eq('id', existingRecord.id)
    .single();

  if (!record) return;

  if (!prepared && record.payment_status === 'paid' && !record.xero_invoice_id && !record.accounting_invoice_id
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
    if (!prepared && await shouldSuppressAnnualInvoice(record)) {
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
  const memberProvider2 = prepared?.provider || await getAccountingProvider(tenantId);
  const memberProviderLabel2 = memberProvider2?.name === 'quickbooks' ? 'QuickBooks' : 'Xero';
  try {
    const xeroReference = poNumber
      ? `Membership ${record.membership_year} - PO: ${poNumber}`
      : `Membership ${record.membership_year}`;
    const resolvedMemberAddr2 = await resolveMembershipInvoiceAddress({
      db: supabase, row: record, config: simResult.config, entityId: memberId, entityType: 'member',
    });
    xeroInvoice = prepared ? prepared.invoice : await memberProvider2.createMembershipInvoice({
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
