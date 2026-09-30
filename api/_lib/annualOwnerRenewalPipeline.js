import { createMembershipSimulator } from './membershipSimulationCore.js';
import { membershipIncentiveSnapshot } from './membershipIncentiveSnapshot.js';
import { loadApprovedAddonLines, computeAddonTotals, readPausedOwners } from './membershipOwnerReadHelpers.js';
import { annualRecordSchedule, resolveEntityAnnualRenewalEligibility } from './annualRenewalPolicy.js';
import { upfrontRollingCommitment } from './upfrontRollingRenewal.js';
import { resolveMembershipNominalCode } from './membershipNominalCode.js';
import { resolveInvoiceAddress } from './invoiceAddressResolver.js';
import { stripeInvoiceAddressFromMetadata } from './stripeInvoiceAddress.js';

export const selectAnnualOwnerSettings = (db, tenantId, scope) => db
  .from(scope === 'member' ? 'member_membership_invoicing' : 'organisation_membership_invoicing')
  .select('*').eq('tenant_id', tenantId).in('invoicing_mode', ['automatic', 'scheduled']);

export async function runAnnualOwnerRow({ db, tenantId, scope, setting, now, effects, trace = () => {}, simulator = createMembershipSimulator(db, () => now) }) {
  const memberScope = scope === 'member', stage = `${scope}-annual-renewal`;
  const column = memberScope ? 'member_id' : 'organization_id', ownerId = setting[column];
  const table = memberScope ? 'member_membership_history' : 'organisation_membership_history';
  const mode = setting.invoicing_mode;
  const skip = reason => { trace({ stage, status: 'skipped', reason }); return { skipped: true, reason }; };
  if (memberScope && (await readPausedOwners(db, tenantId, [ownerId])).has(ownerId)) return skip('Membership paused');
  const sim = await (memberScope ? simulator.simulateMembershipForMember : simulator.simulateMembershipForOrg)(
    tenantId, ownerId, { source: 'cron', mode, targetYear: setting.membership_year || null });
  if (!sim.success) {
    const reason = sim.error || 'Simulation failed';
    trace({ stage, status: 'skipped', reason, code: sim.code });
    return { skipped: true, reason, code: sim.code };
  }
  const owner = memberScope ? sim.member : sim.org;
  if (!owner) return skip(`${scope} not found`);
  if (!memberScope && !sim.goLiveDate) return skip('No Go Live date set - organisation cannot be auto-renewed without a go-live date');
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = new Date(sim.membershipYear.start); start.setHours(0, 0, 0, 0);
  const { data: approval, error: approvalError } = await db.from('system_settings').select('setting_value')
    .eq('setting_key', 'membership_require_approval').eq('tenant_id', tenantId).maybeSingle();
  if (approvalError) throw new Error(`Could not check fee approval: ${approvalError.message}`);
  if (approval?.setting_value === 'true') {
    let query = db.from(memberScope ? 'member_membership_invoicing' : 'organisation_membership_invoicing')
      .select('fees_approved, membership_year').eq('tenant_id', tenantId).eq(column, ownerId);
    query = memberScope ? query.or(`membership_year.eq.${sim.membershipYear.label},membership_year.is.null`)
      : query.eq('membership_year', sim.membershipYear.label);
    const { data, error } = await query;
    if (error) throw new Error(`Could not check approved fees: ${error.message}`);
    const approved = data?.find(r => r.membership_year === sim.membershipYear.label) || data?.find(r => !r.membership_year);
    if (!approved?.fees_approved) return skip('Fees not yet approved');
  }
  if (mode === 'automatic' && sim.existingRecord) return skip(`Record for ${sim.membershipYear.label} already exists`);
  if (!sim.existingRecord && today < start) return skip('Renewal start date has not arrived');
  const invoiceDate = setting.invoice_date ? new Date(setting.invoice_date) : null;
  invoiceDate?.setHours(0, 0, 0, 0);
  const invoiceDue = mode === 'automatic' || !!(invoiceDate && today >= invoiceDate);
  if (sim.existingRecord && (sim.existingRecord.xero_invoice_id || (!memberScope && sim.existingRecord.accounting_invoice_id))) {
    return skip(`Record for ${sim.membershipYear.label} already exists with invoice`);
  }
  const addonLines = memberScope ? [] : await loadApprovedAddonLines(db, tenantId, ownerId, sim.membershipYear.label);
  const addons = computeAddonTotals(addonLines);
  const ownerName = memberScope ? owner.name || `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'Unknown Member' : owner.name;
  const operation = (type, description, payload, amountMinor, currency) => effects.perform({
    type, stage, description, payload, amountMinor, currency,
    conditional: 'Invoice linkage, payment emails, paid workflows and notes depend on this operation succeeding; no successful response is simulated.',
  });
  if (!sim.existingRecord) {
    const zeroDue = Math.round((Number(sim.totalWithVat ?? sim.finalCost ?? 0) + addons.total) * 100) === 0;
    let poNumber = null;
    if (!zeroDue) {
      const loaded = await db.from(memberScope ? 'member_membership_invoicing' : 'organisation_membership_invoicing')
        .select('purchase_order_number').eq('tenant_id', tenantId).eq(column, ownerId)
        .eq('membership_year', sim.membershipYear.label).maybeSingle();
      if (loaded.error) throw new Error(`Could not load purchase order: ${loaded.error.message}`);
      poNumber = loaded.data?.purchase_order_number || null;
    }
    let rolling = {};
    if (sim.config?.start_mode === 'immediate') {
      const eligibility = await resolveEntityAnnualRenewalEligibility(db, { tenantId,
        ...(memberScope ? { memberId: ownerId } : { organizationId: ownerId }), config: sim.config, membershipYear: sim.membershipYear, now });
      if (!eligibility.eligible) throw new Error(eligibility.message || 'Rolling renewal is not eligible.');
      rolling = { ...annualRecordSchedule(eligibility), ...upfrontRollingCommitment(sim, { addonTotals: addons }) };
    }
    const values = {
      ...membershipIncentiveSnapshot(sim),
      tenant_id: tenantId, [column]: ownerId, membership_year: sim.membershipYear.label,
      config_id: sim.config.id, band_id: sim.matchedBand?.id || null, tier_label: sim.tierLabel,
      field_value: sim.fieldValue, annual_cost: sim.annualCost, prorata_cost: sim.prorataCost,
      free_period_discount: sim.freeDiscount || 0, rollover_discount: sim.rolloverDiscount || 0,
      custom_discount_total: sim.customDiscountTotal || 0,
      custom_discount_details: sim.customDiscountDetails?.length ? sim.customDiscountDetails : null,
      final_cost: Math.round((sim.finalCost + addons.subtotal) * 100) / 100,
      currency: sim.currency, billing_period: sim.billingPeriod || 'annual', purchase_order_number: poNumber,
      vat_rate_percent: sim.vatRatePercent || null,
      vat_amount: Math.round(((sim.vatAmount || 0) + addons.vat) * 100) / 100,
      total_with_vat: Math.round(((sim.totalWithVat || sim.finalCost) + addons.total) * 100) / 100,
      year_number: sim.yearNumber, prorata_days: sim.prorataDays || null,
      free_period_days_applied: sim.freePeriodDaysApplied || 0,
      override_applied: sim.overrideApplied || false, override_type: sim.overrideType || null, status: 'active',
      notes: `${mode === 'automatic' ? 'Automatic' : 'Scheduled'} renewal via cron job (year ${sim.yearNumber}, ${memberScope ? `member: ${ownerName}` : `go-live: ${sim.goLiveDate}`})${!memberScope && addonLines.length ? `. ${addonLines.length} add-on line(s) included.` : ''}`,
      ...rolling, ...(zeroDue ? { payment_status: 'paid', paid_at: now.toISOString(), payment_method: null, stripe_payment_intent_id: null } : {}),
    };
    return operation('owner.annual_history_insert', `Create ${scope} renewal history for ${sim.membershipYear.label}${invoiceDue ? '; invoicing follows successful insertion' : '; invoice deferred'}.`,
      { table, values, scope, ownerId, sim, mode, invoiceDue, addonLines, addons, zeroDue }, Math.round(values.total_with_vat * 100), sim.currency);
  }
  const loaded = await db.from(table).select('*').eq('tenant_id', tenantId).eq('id', sim.existingRecord.id).single();
  if (loaded.error) throw new Error(loaded.error.message);
  const record = loaded.data;
  if (!record) return skip('Existing membership history no longer exists');
  const total = record.total_with_vat ?? record.final_cost;
  if (record.payment_status === 'paid' && !record.xero_invoice_id && !record.accounting_invoice_id
    && total != null && Math.round(Number(total) * 100) === 0) {
    return operation('owner.annual_zero_workflow', 'Retry durable paid workflow for existing zero-due membership.',
      { table, row: record, paidAt: record.paid_at, source: memberScope ? 'cron_member_membership_zero_due' : 'cron_org_membership_zero_due' });
  }
  if (!invoiceDue) return skip('Scheduled invoice date has not arrived');
  let agreement = null;
  if (record.billing_agreement_id) {
    const result = await db.from('membership_billing_agreements').select('*').eq('tenant_id', tenantId).eq('id', record.billing_agreement_id).maybeSingle();
    if (result.error) throw new Error(`Annual invoice withheld: ${result.error.message}`);
    agreement = result.data;
    if (!agreement) throw new Error('Annual invoice withheld: billing agreement not found');
    if ((agreement.metadata?.dd || agreement.metadata?.card)?.invoicing_mode === 'per_instalment') return skip('Annual invoice suppressed: membership uses per-instalment monthly invoices');
  }
  let vatRate = sim.taxType || record.vat_rate || null;
  if (!vatRate && record.band_id) {
    const band = await db.from('membership_tier_band').select('vat_rate').eq('tenant_id', tenantId).eq('id', record.band_id).maybeSingle();
    if (band.error) throw new Error(band.error.message);
    vatRate = band.data?.vat_rate || null;
  }
  let poNumber = record.purchase_order_number;
  if (!poNumber) {
    const po = await db.from(memberScope ? 'member_membership_invoicing' : 'organisation_membership_invoicing')
      .select('purchase_order_number').eq('tenant_id', tenantId).eq(column, ownerId).eq('membership_year', record.membership_year).maybeSingle();
    if (po.error) throw new Error(po.error.message);
    poNumber = po.data?.purchase_order_number || null;
  }
  const fee = !memberScope && /add-on line\(s\) included/.test(record.notes || '')
    ? Math.max(0, Math.round((parseFloat(record.final_cost) - addons.subtotal) * 100) / 100) : parseFloat(record.final_cost);
  const address = agreement?.provider === 'stripe' ? stripeInvoiceAddressFromMetadata(agreement.metadata) : null;
  const invoice = {
    appTenantId: tenantId, organizationName: ownerName,
    invoicingEmail: memberScope ? owner.email || null : owner.invoicing_email || null,
    invoicingAddress: address || await resolveInvoiceAddress(db, sim.config, ownerId, memberScope ? 'member' : 'organization'),
    membershipYear: record.membership_year, tierLabel: record.tier_label, finalCost: fee,
    currency: record.currency || 'GBP', reference: `Membership ${record.membership_year}${poNumber ? ` - PO: ${poNumber}` : ''}`,
    vatRate, nominalCode: await resolveMembershipNominalCode(db, tenantId, sim),
    invoiceDescription: sim.config?.invoice_description || null,
    ...(!memberScope ? { extraLineItems: addonLines.map(line => ({ description: line.description, nominalCode: line.nominal_code || null,
      vatRate: line.vat_rate || null, unitCost: Number(line.unit_cost) || 0, quantity: Number(line.quantity) || 1 })) } : {}),
  };
  return operation('owner.annual_invoice', `Create invoice for ${scope} membership ${record.membership_year}.`,
    { tenantId, scope, ownerId, sim, invoiceDue, invoice, record }, Math.round((Number(total) || fee) * 100), invoice.currency);
}

export async function runOwnerAnnualRenewals({ db, plan, agreement, now, effects, trace }) {
  const memberId = agreement.member_id || plan.member_id;
  const scope = memberId ? 'member' : 'organisation';
  const ownerId = memberId || agreement.organization_id || plan.organization_id;
  const result = await selectAnnualOwnerSettings(db, plan.tenant_id, scope)
    .eq(memberId ? 'member_id' : 'organization_id', ownerId).order('membership_year');
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.length) return trace({ stage: `${scope}-annual-renewal`, status: 'skipped', reason: 'Owner has no automatic or scheduled annual invoicing setting.' });
  for (const setting of result.data) await runAnnualOwnerRow({ db, tenantId: plan.tenant_id, scope, setting, now, effects, trace });
}