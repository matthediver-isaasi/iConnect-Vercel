// Organisation membership year replacement.
//
// Retires the recorded current year ('replaced', dates and invoice kept) and
// creates a linked replacement for the identical period with new pricing. The
// original invoice is credited in full, a new invoice is raised, and any
// amount already paid on the original is applied to the new invoice as
// credit. Every accounting step is journalled on
// organisation_membership_replacement so a retry resumes, never duplicates.

import { buildInvoiceColumnUpdate } from './accountingProvider.js';
import { validateAddonLines, computeAddonTotals, buildExtraLineItems } from './membershipAddons.js';

export const REPLACEMENT_RETIRED_STATUSES = new Set(['cancelled', 'canceled', 'void', 'replaced', 'expired_checkout', 'cancelled_by_request']);
const LEASE_MS = 2 * 60 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export class ReplacementError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const near = (a, b) => Math.abs(round2(a) - round2(b)) < 0.005;

/**
 * A credit note created outside the app (typically by finance in Xero) may
 * be adopted as the replacement's credit only when it is unambiguous: it is
 * the one credit on the invoice, it fully credits the invoice gross, it is
 * not applied anywhere else, and no cash was ever paid. Anything else stays
 * an accounting-review block. Returns { note } or { reason }.
 */
export function evaluateExistingCreditNote(invoice, evidence) {
  const raw = invoice?.raw || {};
  const total = round2(invoice?.totalAmt ?? raw.Total);
  if (!(total > 0)) return { reason: 'no_total' };
  if (!near(raw.AmountCredited, total)) return { reason: 'partial_credit' };
  if (Number(raw.AmountPaid) > 0 || (raw.Payments || []).length) return { reason: 'payments_present' };
  if ((raw.Overpayments || []).length || (raw.Prepayments || []).length) return { reason: 'other_credits_present' };
  const linked = raw.CreditNotes || [];
  if (linked.length !== 1) return { reason: 'multiple_credit_notes' };
  const link = linked[0];
  if (!link?.CreditNoteID || !near(link.AppliedAmount, total)) return { reason: 'partial_credit' };
  const notes = (evidence?.notes || []).filter(note => note.providerId === link.CreditNoteID);
  if (notes.length !== 1) return { reason: 'credit_note_unverified' };
  const note = notes[0];
  if (!['AUTHORISED', 'PAID'].includes(String(note.status || '').toUpperCase())) return { reason: 'credit_note_status' };
  if (note.ambiguousAttribution || !near(note.amount, total)) return { reason: 'credit_note_shared' };
  if (raw.CurrencyCode && note.currency && note.currency !== raw.CurrencyCode) return { reason: 'currency_mismatch' };
  return { note: { id: link.CreditNoteID, number: link.CreditNoteNumber || null, amount: total,
    date: link.DateString ? String(link.DateString).slice(0, 10) : null, currency: note.currency || raw.CurrencyCode || null } };
}

/** True when a history row is a retired replacement original. */
export function isReplacedHistoryRow(row) {
  return row?.status === 'replaced';
}

/** Validate an admin-entered override. Returns null for "no override". */
export function normalizeReplacementOverride(input) {
  if (!input || !input.overrideType) return null;
  const type = input.overrideType;
  if (!['structure', 'price', 'discount'].includes(type)) {
    throw new ReplacementError('invalid_override', 'Override type must be structure, price or discount', 400);
  }
  if (type === 'structure') {
    if (!input.configId) throw new ReplacementError('invalid_override', 'Choose a membership structure', 400);
    return { override_type: 'structure', config_id: input.configId, band_id: input.bandId || null,
      manual_price: null, discount_type: null, discount_value: null };
  }
  if (type === 'price') {
    const price = Number.parseFloat(input.manualPrice);
    if (!Number.isFinite(price) || price < 0) throw new ReplacementError('invalid_override', 'Enter a valid manual price', 400);
    return { override_type: 'price', config_id: null, band_id: null, manual_price: price, discount_type: null, discount_value: null };
  }
  const value = Number.parseFloat(input.discountValue);
  if (!['percentage', 'fixed'].includes(input.discountType)) {
    throw new ReplacementError('invalid_override', 'Discount type must be percentage or fixed', 400);
  }
  if (!Number.isFinite(value) || value < 0 || (input.discountType === 'percentage' && value > 100)) {
    throw new ReplacementError('invalid_override', 'Enter a valid discount value', 400);
  }
  return { override_type: 'discount', config_id: null, band_id: null, manual_price: null,
    discount_type: input.discountType, discount_value: value };
}

/** Reject any client attempt to change the recorded period. */
export function assertPeriodUnchanged(original, requested) {
  if (!requested) return;
  const fields = [['membershipYear', 'membership_year'], ['termStartDate', 'term_start_date'], ['termEndDate', 'term_end_date']];
  for (const [key, column] of fields) {
    if (requested[key] !== undefined && String(requested[key] ?? '') !== String(original[column] ?? '')) {
      throw new ReplacementError('period_locked', 'The membership period cannot be changed when replacing a year', 400);
    }
  }
}

function invoiceIdOf(row) {
  return row?.accounting_invoice_id || row?.xero_invoice_id || null;
}

function invoiceNumberOf(row) {
  return row?.accounting_invoice_number || row?.xero_invoice_number || null;
}

/**
 * Pure eligibility check for the history row. `facts` carries values the
 * caller resolved from the database/provider. Returns the first blocker.
 */
export function evaluateReplacementEligibility(row, facts) {
  const block = (code, message) => ({ eligible: false, code, message });
  if (!row) return block('not_found', 'Membership year not found');
  if (row.status === 'replaced' || row.replaced_by_record_id) return block('already_replaced', 'This membership year has already been replaced');
  if (REPLACEMENT_RETIRED_STATUSES.has(row.status) || row.cancelled_for_switch_at) return block('cancelled', 'Cancelled membership years cannot be replaced');
  if (row.status !== 'active') return block('not_recorded', 'Only the recorded current membership year can be replaced');
  if (row.membership_year !== facts.currentYearLabel) return block('not_current_year', 'Only the current membership year can be replaced');
  if (row.term_key) return block('rolling_term', 'Rolling commitment terms cannot be replaced');
  if (row.membership_payment_quote_id || row.proposal_membership || row.funnel_membership) {
    return block('quote_backed', 'Years created from a proposal, payment quote or event funnel cannot be replaced');
  }
  if (row.billing_agreement_id || facts.activeCollectionPlan) {
    return block('collection_plan_active', 'A Direct Debit or card instalment plan is collecting for this organisation. Cancel or settle the plan before replacing the year.');
  }
  if (facts.hasTrainingFundAddons) return block('training_fund_addons', 'Years invoiced with Training Fund add-ons cannot be replaced');
  if (facts.existingOperation) return block('already_replaced', 'This membership year has already been replaced');
  if (row.accounting_credit_note_id) return block('already_credited', 'This year\'s invoice has already been credited');
  const total = round2(row.total_with_vat ?? row.final_cost ?? 0);
  const invoiceId = invoiceIdOf(row);
  if (row.accounting_sync_status === 'failed' || row.accounting_sync_status === 'retrying' || (!invoiceId && (total > 0 || facts.addonTotal > 0))) {
    return block('invoice_not_synced', 'The original invoice was never synced to the accounting package. Retry the original sync or void it first.');
  }
  if (invoiceId) {
    if ((row.accounting_provider || 'xero') !== facts.activeProvider) {
      return block('provider_mismatch', 'The original invoice belongs to a different accounting package than the one now connected');
    }
    const invoice = facts.originalInvoice;
    if (!invoice) return block('invoice_unavailable', 'The original invoice could not be read from the accounting package');
    if (invoice.voided || invoice.status === 'voided') return block('invoice_voided', 'The original invoice has been voided. Void it fully in membership history instead.');
    if (invoice.raw?.Status === 'DRAFT') return block('invoice_draft', 'The original invoice is still a draft in Xero. Approve or delete it first.');
    if (Number(invoice.raw?.AmountCredited) > 0) {
      const existing = facts.existingCreditNote;
      if (existing === 'unavailable') return block('credit_evidence_unavailable', 'The credit note on the original invoice could not be checked in the accounting package. Try again later.');
      if (existing === 'already_linked') return block('already_credited', 'The credit note on the original invoice is already linked to another membership record; accounting review required');
      if (!existing?.id) return block('already_credited', 'The original invoice has already been partly credited; accounting review required');
      if (facts.linkCreditNoteId !== existing.id) {
        return { ...block('existing_credit_note', `The original invoice has already been fully credited by credit note ${existing.number || existing.id}. Confirm that this credit note should be used for the replacement.`), details: { existingCreditNote: existing } };
      }
      return { eligible: true, linkedCreditNote: existing };
    }
    if (facts.priorCredits === 'unavailable') return block('credit_evidence_unavailable', 'Existing credits on the original invoice could not be checked in the accounting package. Try again later.');
    if (facts.priorCredits === 'present') return block('already_credited', 'The original invoice already has a credit applied; accounting review required');
    if (facts.activeProvider === 'quickbooks' && quickBooksTaxCodes(invoice.raw).size > 1) {
      return block('mixed_tax_invoice', 'The original QuickBooks invoice mixes VAT rates, so a single credit note cannot match it exactly. Credit it manually in QuickBooks.');
    }
  }
  return { eligible: true };
}

/**
 * Financial plan. Full original total credited; the unpaid part clears the
 * original; the paid part is applied to the new invoice; surplus stays.
 */
export function planReplacementAccounting({ originalTotal, originalPaid, replacementTotal, hasOriginalInvoice }) {
  const total = round2(originalTotal);
  const paid = Math.min(round2(originalPaid), total);
  const creditAmount = hasOriginalInvoice && total > 0 ? total : 0;
  const allocateToOriginal = creditAmount > 0 ? round2(total - paid) : 0;
  const allocateToReplacement = creditAmount > 0 ? Math.min(paid, round2(replacementTotal)) : 0;
  return {
    creditAmount,
    allocateToOriginal,
    allocateToReplacement,
    replacementInvoiceAmount: round2(replacementTotal),
    amountDue: round2(Math.max(0, replacementTotal - allocateToReplacement)),
    surplusCredit: creditAmount > 0 ? round2(Math.max(0, paid - allocateToReplacement)) : 0,
  };
}

/** Distinct tax codes on a QuickBooks invoice's sales lines. */
export function quickBooksTaxCodes(raw) {
  const codes = new Set();
  for (const line of raw?.Line || []) {
    if (line?.DetailType !== 'SalesItemLineDetail') continue;
    codes.add(String(line.SalesItemLineDetail?.TaxCodeRef?.value ?? ''));
  }
  return codes;
}

/** A provider credit note must equal the approved gross credit exactly. */
export function assertCreditMatchesApproved(creditNote, approvedTotal) {
  const amount = creditNote?.amount;
  if (amount == null || !Number.isFinite(Number(amount))) {
    throw new Error('The accounting package did not report the credit note total; accounting review required');
  }
  if (Math.abs(round2(amount) - round2(approvedTotal)) > 0.009) {
    throw new Error(`The credit note total (${round2(amount).toFixed(2)}) does not match the original invoice total (${round2(approvedTotal).toFixed(2)}); accounting review required`);
  }
}

/** Credit amount argument per provider: QBO adds tax on top of line amounts. */
export function providerCreditArgument(providerName, invoice) {
  const total = round2(invoice?.totalAmt);
  if (providerName !== 'quickbooks') return total;
  const raw = invoice?.raw || {};
  if (raw.GlobalTaxCalculation === 'TaxInclusive') return total;
  return round2(total - (Number(raw.TxnTaxDetail?.TotalTax) || 0));
}

export function replacementHistoryFields(sim, original, { zeroDue, paidAt, addonTotals = { subtotal: 0, vat: 0, total: 0 } }) {
  // Like ordinary organisation recording, stored totals include approved
  // add-on lines; the membership-only amount is kept in the invoice snapshot.
  return {
    config_id: sim.config?.id || original.config_id || null,
    band_id: sim.matchedBand?.id || null,
    tier_label: sim.tierLabel ?? null,
    field_value: sim.fieldValue ?? null,
    annual_cost: sim.annualCost ?? null,
    prorata_cost: sim.prorataCost ?? null,
    free_period_discount: sim.freeDiscount || 0,
    rollover_discount: sim.rolloverDiscount || 0,
    custom_discount_total: sim.customDiscountTotal || 0,
    custom_discount_details: sim.customDiscountDetails?.length ? sim.customDiscountDetails : null,
    final_cost: round2((Number(sim.finalCost) || 0) + addonTotals.subtotal),
    currency: sim.currency || original.currency || 'GBP',
    billing_period: sim.billingPeriod || original.billing_period || 'annual',
    vat_rate_percent: sim.vatRatePercent || null,
    vat_amount: round2((Number(sim.vatAmount) || 0) + addonTotals.vat),
    total_with_vat: round2((Number(sim.totalWithVat ?? sim.finalCost) || 0) + addonTotals.total),
    year_number: sim.yearNumber || original.year_number || null,
    prorata_days: sim.prorataDays || null,
    free_period_days_applied: sim.freePeriodDaysApplied || 0,
    override_applied: !!sim.overrideApplied,
    override_type: sim.overrideType || null,
    xero_project_code: sim.xeroProjectCode || original.xero_project_code || null,
    payment_status: zeroDue ? 'paid' : 'unpaid',
    ...(zeroDue ? { paid_at: paidAt } : {}),
  };
}

/**
 * Service factory. Dependencies are injectable for tests.
 */
export function createOrganisationMembershipReplacementService(deps) {
  const {
    db, simulate, getConfig, currentYearLabel, getActiveProvider, getProviderByName,
    hasActiveCollectionPlan, loadApprovedAddonLines, getAddonSettings, sendInvoiceEmail,
    resolveInvoiceAddress, resolveNominalCode, readInvoiceCreditEvidence = null, now = () => new Date(), randomUUID = () => crypto.randomUUID(),
  } = deps;

  async function loadOriginal(tenantId, organizationId, recordId) {
    const { data, error } = await db.from('organisation_membership_history').select('*')
      .eq('tenant_id', tenantId).eq('organization_id', organizationId).eq('id', recordId).maybeSingle();
    if (error) throw error;
    if (!data) throw new ReplacementError('not_found', 'Membership year not found', 404);
    return data;
  }

  async function loadOperationBySource(tenantId, recordId) {
    const { data, error } = await db.from('organisation_membership_replacement').select('*')
      .eq('tenant_id', tenantId).eq('source_record_id', recordId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function creditNoteLinkedElsewhere(tenantId, creditNoteId, recordId) {
    const [history, ops] = await Promise.all([
      db.from('organisation_membership_history').select('id').eq('tenant_id', tenantId).eq('accounting_credit_note_id', creditNoteId),
      db.from('organisation_membership_replacement').select('id').eq('tenant_id', tenantId).eq('credit_note_id', creditNoteId),
    ]);
    if (history.error) throw history.error;
    if (ops.error) throw ops.error;
    return (history.data || []).some(row => row.id !== recordId) || (ops.data || []).length > 0;
  }

  async function resolveFacts(tenantId, organizationId, original) {
    const config = await getConfig(tenantId, organizationId);
    if (!config) throw new ReplacementError('no_structure', 'No membership structure applies to this organisation', 400);
    const approvedLines = await loadApprovedAddonLines(tenantId, organizationId, original.membership_year);
    const activeProvider = await getActiveProvider(tenantId);
    const invoiceId = invoiceIdOf(original);
    let originalInvoice = null;
    let priorCredits = 'none';
    if (invoiceId && (original.accounting_provider || 'xero') === activeProvider.name) {
      originalInvoice = await activeProvider.fetchInvoiceStatus(invoiceId, tenantId).catch(() => null);
      // QuickBooks has no AmountCredited: credit memos applied via payments
      // must be discovered explicitly. Unknown evidence blocks, never passes.
      if (originalInvoice && activeProvider.name === 'quickbooks') {
        const linked = (originalInvoice.raw?.LinkedTxn || []).some(t => t?.TxnType === 'CreditMemo');
        if (linked) priorCredits = 'present';
        else if (!readInvoiceCreditEvidence) priorCredits = 'unavailable';
        else {
          try {
            const evidence = await readInvoiceCreditEvidence(activeProvider.name, tenantId, invoiceId);
            const live = (evidence?.notes || []).filter(note => !['VOIDED', 'DELETED'].includes(String(note.status || '').toUpperCase()));
            priorCredits = live.length ? 'present' : 'none';
          } catch {
            priorCredits = 'unavailable';
          }
        }
      }
    }
    // Xero: an invoice already credited outside the app can only proceed by
    // explicitly adopting that one credit note (see evaluateExistingCreditNote).
    let existingCreditNote = null;
    if (originalInvoice && activeProvider.name === 'xero' && Number(originalInvoice.raw?.AmountCredited) > 0 && readInvoiceCreditEvidence) {
      try {
        const evidence = await readInvoiceCreditEvidence(activeProvider.name, tenantId, invoiceId);
        existingCreditNote = evaluateExistingCreditNote(originalInvoice, evidence).note || null;
      } catch {
        existingCreditNote = 'unavailable';
      }
      if (existingCreditNote?.id && await creditNoteLinkedElsewhere(tenantId, existingCreditNote.id, original.id)) {
        existingCreditNote = 'already_linked';
      }
    }
    return {
      config,
      approvedLines,
      activeProvider,
      originalInvoice,
      facts: {
        existingCreditNote,
        currentYearLabel: currentYearLabel(config),
        activeCollectionPlan: await hasActiveCollectionPlan(tenantId, organizationId),
        hasTrainingFundAddons: approvedLines.some(line => line?.type === 'training_fund'),
        addonTotal: computeAddonTotals(approvedLines).total,
        existingOperation: !!(await loadOperationBySource(tenantId, original.id)),
        activeProvider: activeProvider.name,
        originalInvoice,
        priorCredits,
      },
    };
  }

  async function buildPreview({ tenantId, organizationId, recordId, override, addonLines, linkCreditNoteId = null }) {
    const original = await loadOriginal(tenantId, organizationId, recordId);
    const resolved = await resolveFacts(tenantId, organizationId, original);
    const eligibility = evaluateReplacementEligibility(original, { ...resolved.facts, linkCreditNoteId });
    if (!eligibility.eligible) throw new ReplacementError(eligibility.code, eligibility.message, 409, eligibility.details || null);
    const linkedCreditNote = eligibility.linkedCreditNote || null;

    let lines = resolved.approvedLines;
    if (Array.isArray(addonLines)) {
      const settings = await getAddonSettings(tenantId);
      const checked = validateAddonLines(addonLines, settings);
      if (!checked.valid) throw new ReplacementError('invalid_addons', checked.error, 400);
      lines = checked.lines;
      if (lines.some(line => line.type === 'training_fund')) {
        throw new ReplacementError('training_fund_addons', 'Training Fund add-ons cannot be added to a replacement year', 400);
      }
    }
    const addonTotals = computeAddonTotals(lines);

    const sim = await simulate(tenantId, organizationId, {
      source: 'manual', mode: 'manual', targetYear: original.membership_year, replacementOverride: override,
      replacementOfRecordId: original.id, replacementProrataDays: original.prorata_days ?? null,
    });
    if (!sim?.success) throw new ReplacementError(sim?.code || 'simulation_failed', sim?.error || 'Could not price the replacement', 400);
    if (sim.previewOnly === true) {
      throw new ReplacementError('prospective_membership_preview_only', 'Only a recorded membership year can be replaced', 400);
    }
    if (sim.membershipYear?.label !== original.membership_year) {
      throw new ReplacementError('membership_year_mismatch', 'The replacement could not be priced for the same membership year', 400);
    }
    if (sim.proposalMembership || sim.funnelMembership) {
      throw new ReplacementError('quote_backed', 'Proposal or funnel-covered pricing cannot be used for a replacement', 400);
    }
    const membershipTotal = round2(sim.totalWithVat ?? sim.finalCost);
    const replacementTotal = round2(membershipTotal + addonTotals.total);
    const invoice = resolved.originalInvoice;
    const hasOriginalInvoice = !!invoiceIdOf(original);
    const originalTotal = hasOriginalInvoice ? round2(invoice?.totalAmt) : 0;
    // An adopted credit note already cleared the original, and no cash was
    // paid (enforced when adopting), so nothing carries to the new invoice.
    const originalPaid = linkedCreditNote ? 0
      : hasOriginalInvoice ? round2(Math.max(0, (invoice?.totalAmt || 0) - (invoice?.balance || 0))) : 0;
    const plan = planReplacementAccounting({ originalTotal, originalPaid, replacementTotal, hasOriginalInvoice });
    return {
      original,
      sim,
      linkedCreditNote,
      addonLines: lines,
      addonTotals,
      provider: resolved.activeProvider,
      originalInvoice: invoice,
      summary: {
        original: {
          id: original.id,
          membershipYear: original.membership_year,
          termStartDate: original.term_start_date,
          termEndDate: original.term_end_date,
          configId: original.config_id,
          tierLabel: original.tier_label,
          finalCost: Number(original.final_cost),
          totalWithVat: Number(original.total_with_vat ?? original.final_cost),
          currency: original.currency,
          invoiceNumber: invoiceNumberOf(original),
          invoiceStatus: invoice?.status || (hasOriginalInvoice ? 'unknown' : null),
          invoiceTotal: originalTotal,
          amountPaid: originalPaid,
          purchaseOrderNumber: original.purchase_order_number || null,
        },
        replacement: {
          membershipYear: original.membership_year,
          termStartDate: original.term_start_date,
          termEndDate: original.term_end_date,
          tierLabel: sim.tierLabel,
          configId: sim.config?.id || null,
          annualCost: sim.annualCost,
          prorataCost: sim.prorataCost,
          freePeriodDiscount: sim.freeDiscount || 0,
          rolloverDiscount: sim.rolloverDiscount || 0,
          customDiscountTotal: sim.customDiscountTotal || 0,
          customDiscountDetails: sim.customDiscountDetails || [],
          finalCost: round2(sim.finalCost),
          vatAmount: round2(sim.vatAmount || 0),
          membershipTotal,
          addonLines: lines,
          addonTotals,
          total: replacementTotal,
          currency: sim.currency || original.currency,
        },
        accounting: {
          provider: resolved.activeProvider.name,
          creditNoteAmount: plan.creditAmount,
          creditAppliedToOriginal: plan.allocateToOriginal,
          paidCreditToApply: plan.allocateToReplacement,
          newInvoiceAmount: plan.replacementInvoiceAmount,
          amountDue: plan.amountDue,
          surplusCredit: plan.surplusCredit,
          originalPaid,
          existingCreditNote: linkedCreditNote,
        },
      },
    };
  }

  async function preview(args) {
    return (await buildPreview(args)).summary;
  }

  async function execute({ tenantId, organizationId, recordId, override, addonLines, reason, actorId, idempotencyKey, period, linkCreditNoteId = null }) {
    if (!reason || !String(reason).trim()) throw new ReplacementError('reason_required', 'A reason is required', 400);
    if (!actorId) throw new ReplacementError('actor_required', 'Your user could not be identified', 403);
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{8,64}$/.test(idempotencyKey)) {
      throw new ReplacementError('idempotency_required', 'A valid request key is required', 400);
    }
    // Replay of an already-applied request: resume, never re-apply.
    const { data: prior, error: priorError } = await db.from('organisation_membership_replacement').select('*')
      .eq('tenant_id', tenantId).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (priorError) throw priorError;
    if (prior) {
      if (prior.source_record_id !== recordId) throw new ReplacementError('already_replaced', 'This request was already used for another year');
      return { operation: await runSync({ tenantId, operationId: prior.id }), replayed: true };
    }

    const originalForPeriod = await loadOriginal(tenantId, organizationId, recordId);
    assertPeriodUnchanged(originalForPeriod, period);
    const built = await buildPreview({ tenantId, organizationId, recordId, override, addonLines, linkCreditNoteId });
    const { original, sim, summary, linkedCreditNote } = built;
    const zeroDue = summary.replacement.total === 0;
    const paidAt = now().toISOString();
    const history = replacementHistoryFields(sim, original, { zeroDue, paidAt, addonTotals: built.addonTotals });
    history.notes = `Replacement for ${original.membership_year} (replaces ${invoiceNumberOf(original) || original.id}). Reason: ${String(reason).trim()}`;
    const hasCredit = summary.accounting.creditNoteAmount > 0;
    const linkedSnapshot = linkedCreditNote ? { linkedCreditNote: { id: linkedCreditNote.id, number: linkedCreditNote.number, amount: linkedCreditNote.amount } } : null;
    const payload = {
      history,
      period: { membership_year: original.membership_year, term_start_date: original.term_start_date, term_end_date: original.term_end_date },
      override,
      addon_lines: built.addonLines,
      invoice_snapshot: zeroDue ? linkedSnapshot : {
        ...(linkedSnapshot || {}),
        membershipFinalCost: round2(sim.finalCost),
        membershipVatAmount: round2(sim.vatAmount || 0),
        reference: original.purchase_order_number
          ? `Membership ${original.membership_year} - PO: ${original.purchase_order_number}`
          : `Membership ${original.membership_year}`,
        vatRate: sim.taxType || sim.matchedBand?.vat_rate || null,
        nominalCode: await resolveNominalCode(tenantId, sim),
        invoiceDescription: sim.config?.invoice_description || null,
        invoicingAddress: await resolveInvoiceAddress(sim.config, organizationId),
      },
      accounting_provider: built.provider.name,
      original_total: summary.accounting.creditNoteAmount > 0 ? summary.original.invoiceTotal : 0,
      original_paid: summary.accounting.originalPaid,
      replacement_total: summary.replacement.total,
      credit_note_state: hasCredit ? 'pending' : 'not_required',
      invoice_state: zeroDue ? 'not_required' : 'pending',
      // An adopted credit note is already fully applied to the original.
      allocation_state: !linkedCreditNote && hasCredit && (summary.accounting.creditAppliedToOriginal > 0 || summary.accounting.paidCreditToApply > 0) ? 'pending' : 'not_required',
      email_state: zeroDue ? 'not_required' : 'pending',
    };
    const { data: applied, error } = await db.rpc('apply_organisation_membership_replacement', {
      p_tenant_id: tenantId, p_source_record_id: original.id, p_actor_id: actorId,
      p_reason: String(reason).trim(), p_idempotency_key: idempotencyKey, p_payload: payload,
    });
    if (error) {
      if (error.code === 'PT409') throw new ReplacementError('already_replaced', error.message);
      if (error.code === '22023') throw new ReplacementError('invalid_request', error.message, 400);
      if (error.code === '23505') throw new ReplacementError('duplicate_year', 'Another live record already exists for this year');
      throw error;
    }

    if (!applied?.replayed) {
      await persistOverride({ tenantId, organizationId, membershipYear: original.membership_year, override, reason, addonLines: built.addonLines });
      await writeNote({ tenantId, organizationId, actorId,
        content: `[Membership Replacement] ${original.membership_year} membership replaced. Reason: ${String(reason).trim()}. `
          + `Original ${invoiceNumberOf(original) ? `invoice ${invoiceNumberOf(original)}` : 'record'} (${summary.original.currency || ''} ${summary.original.totalWithVat.toFixed(2)}) `
          + `retired; replacement ${summary.replacement.tierLabel || ''} ${summary.replacement.currency || ''} ${summary.replacement.total.toFixed(2)}.`
          + (linkedCreditNote ? ` Existing credit note ${linkedCreditNote.number || linkedCreditNote.id} (${summary.accounting.creditNoteAmount.toFixed(2)}) linked as the credit for the original invoice.`
            : hasCredit ? ` Credit note of ${summary.accounting.creditNoteAmount.toFixed(2)} to be raised.` : ''),
      });
    }
    return { operation: await runSync({ tenantId, operationId: applied.operation_id }), replayed: !!applied?.replayed };
  }

  async function persistOverride({ tenantId, organizationId, membershipYear, override, reason, addonLines }) {
    // The stored year-scoped override mirrors what priced the replacement so
    // the tab shows the same terms. Errors are logged; the record is the
    // source of truth for the recorded year.
    try {
      const { data: existing } = await db.from('organisation_membership_override').select('id')
        .eq('tenant_id', tenantId).eq('organization_id', organizationId).eq('membership_year', membershipYear).maybeSingle();
      if (override) {
        const row = { tenant_id: tenantId, organization_id: organizationId, membership_year: membershipYear,
          ...override, note: `Replacement: ${String(reason).trim()}`, updated_at: now().toISOString() };
        const result = existing
          ? await db.from('organisation_membership_override').update(row).eq('id', existing.id)
          : await db.from('organisation_membership_override').insert(row);
        if (result.error) console.error('[Replacement] Could not store override:', result.error.message);
      } else if (existing) {
        const { error } = await db.from('organisation_membership_override').delete().eq('id', existing.id);
        if (error) console.error('[Replacement] Could not clear override:', error.message);
      }
      const { data: invoicing } = await db.from('organisation_membership_invoicing').select('id')
        .eq('tenant_id', tenantId).eq('organization_id', organizationId).eq('membership_year', membershipYear).maybeSingle();
      if (invoicing) {
        const { error } = await db.from('organisation_membership_invoicing').update({ addon_lines: addonLines, fees_approved: true }).eq('id', invoicing.id);
        if (error) console.error('[Replacement] Could not store add-on lines:', error.message);
      } else if (addonLines.length) {
        const { error } = await db.from('organisation_membership_invoicing').insert({ tenant_id: tenantId, organization_id: organizationId,
          membership_year: membershipYear, addon_lines: addonLines, fees_approved: true });
        if (error) console.error('[Replacement] Could not store add-on lines:', error.message);
      }
    } catch (err) {
      console.error('[Replacement] Override persistence failed (non-fatal):', err.message);
    }
  }

  async function writeNote({ organizationId, actorId, content }) {
    const { error } = await db.from('organization_note').insert({ organization_id: organizationId, member_id: actorId || null, content, attachments: [] });
    if (error) console.error('[Replacement] Could not write organisation note:', error.message);
  }

  async function updateOperation(op, fields) {
    const { error } = await db.from('organisation_membership_replacement')
      .update({ ...fields, updated_at: now().toISOString() }).eq('id', op.id).eq('lease_token', op.lease_token);
    if (error) throw new Error(`Could not record replacement progress: ${error.message}`);
    Object.assign(op, fields);
  }

  async function acquireLease(tenantId, operationId) {
    const token = randomUUID();
    const at = now();
    const { data, error } = await db.from('organisation_membership_replacement')
      .update({ lease_token: token, lease_expires_at: new Date(at.getTime() + LEASE_MS).toISOString(), sync_state: 'in_progress', updated_at: at.toISOString() })
      .eq('tenant_id', tenantId).eq('id', operationId).neq('sync_state', 'complete')
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${at.toISOString()}`)
      .select('*').maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function loadOperation(tenantId, operationId) {
    const { data, error } = await db.from('organisation_membership_replacement').select('*')
      .eq('tenant_id', tenantId).eq('id', operationId).maybeSingle();
    if (error) throw error;
    if (!data) throw new ReplacementError('not_found', 'Replacement not found', 404);
    return data;
  }

  /**
   * Drive the remaining accounting steps. Each provider document is created
   * with a stable reference/idempotency key and persisted before the next
   * step, so a retry after any failure resumes without duplicates.
   */
  async function runSync({ tenantId, operationId }) {
    const current = await loadOperation(tenantId, operationId);
    if (current.sync_state === 'complete') return current;
    const op = await acquireLease(tenantId, operationId);
    if (!op) return loadOperation(tenantId, operationId);

    const failures = [];
    const { data: original } = await db.from('organisation_membership_history').select('*').eq('id', op.source_record_id).single();
    const { data: target } = await db.from('organisation_membership_history').select('*').eq('id', op.target_record_id).single();
    const provider = getProviderByName(op.accounting_provider || 'xero');

    // 1. Credit note against the original invoice (full total).
    if (['pending', 'failed'].includes(op.credit_note_state)) {
      try {
        let creditNote = null;
        const linked = op.invoice_snapshot?.linkedCreditNote;
        if (op.credit_note_id) {
          creditNote = { creditNoteId: op.credit_note_id, creditNoteNumber: op.credit_note_number, amount: op.credit_note_amount };
        } else if (linked?.id) {
          // Adopted credit note: re-verify it still fully credits the original
          // invoice; never create a second one.
          const invoice = await provider.fetchInvoiceStatus(op.original_invoice_id, tenantId);
          if (!invoice) throw new Error('Original invoice could not be read from the accounting package');
          const applied = (invoice.raw?.CreditNotes || []).find(note => note?.CreditNoteID === linked.id);
          if (!applied || !near(applied.AppliedAmount, op.original_total) || !near(invoice.raw?.AmountCredited, op.original_total)) {
            throw new Error(`Credit note ${linked.number || linked.id} no longer fully credits the original invoice; accounting review required`);
          }
          creditNote = { creditNoteId: linked.id, creditNoteNumber: linked.number || applied.CreditNoteNumber || null, amount: round2(op.original_total) };
        } else {
          // Re-verify on every attempt: a credit note created by an earlier
          // attempt is rediscovered by reference and must still match.
          const invoice = await provider.fetchInvoiceStatus(op.original_invoice_id, tenantId);
          if (!invoice) throw new Error('Original invoice could not be read from the accounting package');
          if (round2(invoice.totalAmt) !== round2(op.original_total)) {
            throw new Error('The original invoice total changed since the replacement was confirmed; accounting review required');
          }
          creditNote = await provider.createCreditNote({
            appTenantId: tenantId,
            invoiceId: op.original_invoice_id,
            creditAmount: providerCreditArgument(provider.name, invoice),
            description: `Credit for ${op.membership_year} membership (replaced)`,
            reference: `Membership replacement ${op.id}`,
            ...(provider.name === 'xero' ? { recoveryKey: `omr-cn-${op.id}` } : {}),
          });
          if (!creditNote || creditNote.skipped || !creditNote.creditNoteId) {
            throw new Error(creditNote?.reason || 'The accounting package did not create the credit note');
          }
          try {
            assertCreditMatchesApproved(creditNote, op.original_total);
          } catch (mismatch) {
            // Keep the provider number so finance can find it, but never mark
            // the step done or allocate a wrong-value credit.
            await updateOperation(op, { credit_note_number: creditNote.creditNoteNumber || null, credit_note_amount: creditNote.amount ?? null });
            throw mismatch;
          }
        }
        await updateOperation(op, { credit_note_state: 'done', credit_note_id: creditNote.creditNoteId,
          credit_note_number: creditNote.creditNoteNumber || null, credit_note_amount: creditNote.amount ?? op.original_total, last_error: null });
        const { error } = await db.from('organisation_membership_history').update({
          accounting_credit_note_id: creditNote.creditNoteId, accounting_credit_note_number: creditNote.creditNoteNumber || null,
        }).eq('id', op.source_record_id);
        if (error) throw new Error(`Credit note created but not linked to the original year: ${error.message}`);
      } catch (err) {
        failures.push(`Credit note: ${err.message}`);
        await updateOperation(op, { credit_note_state: 'failed' });
      }
    }

    // 2. Replacement invoice (same lines/contact/PO logic as manual invoicing).
    if (['pending', 'failed'].includes(op.invoice_state) && op.credit_note_state !== 'failed') {
      try {
        let invoice;
        if (op.invoice_id) {
          invoice = { invoiceId: op.invoice_id, invoiceNumber: op.invoice_number, onlineInvoiceUrl: op.online_invoice_url, provider: provider.name };
        } else {
          const snap = op.invoice_snapshot || {};
          const { data: org } = await db.from('organization').select('id, name, invoicing_email')
            .eq('tenant_id', tenantId).eq('id', op.organization_id).single();
          const created = await provider.createMembershipInvoice({
            appTenantId: tenantId,
            organizationName: org?.name,
            invoicingEmail: org?.invoicing_email || null,
            invoicingAddress: snap.invoicingAddress || null,
            membershipYear: op.membership_year,
            tierLabel: target.tier_label,
            finalCost: snap.membershipFinalCost != null ? Number(snap.membershipFinalCost)
              : round2(Number(target.final_cost) - computeAddonTotals(op.addon_lines || []).subtotal),
            currency: target.currency,
            reference: snap.reference || `Membership ${op.membership_year}`,
            vatRate: snap.vatRate || null,
            nominalCode: snap.nominalCode || null,
            xeroProjectCode: target.xero_project_code || null,
            invoiceDescription: snap.invoiceDescription || null,
            extraLineItems: buildExtraLineItems(op.addon_lines || []),
            idempotencyKey: `omr-inv-${op.id}`,
            authorizeWithoutPayment: true,
          });
          if (!created || !(created.invoiceId || created.invoice_id)) throw new Error('The accounting package did not create the invoice');
          invoice = { ...created, provider: created.provider || provider.name };
        }
        const columns = buildInvoiceColumnUpdate(invoice);
        await updateOperation(op, { invoice_state: 'done', invoice_id: columns.accounting_invoice_id,
          invoice_number: columns.accounting_invoice_number, online_invoice_url: invoice.onlineInvoiceUrl || invoice.online_invoice_url || null, last_error: null });
        const { error } = await db.from('organisation_membership_history').update(columns).eq('id', op.target_record_id);
        if (error) throw new Error(`Invoice created but not linked to the replacement year: ${error.message}`);
      } catch (err) {
        failures.push(`Invoice: ${err.message}`);
        await updateOperation(op, { invoice_state: 'failed' });
      }
    }

    // 3. Allocations: clear the unpaid part of the original, then apply the
    // paid part to the new invoice. Each call tops up to a target, so a
    // retry never allocates twice.
    if (['pending', 'failed'].includes(op.allocation_state) && op.credit_note_state === 'done'
        && ['done', 'not_required'].includes(op.invoice_state)) {
      try {
        const plan = planReplacementAccounting({ originalTotal: op.original_total, originalPaid: op.original_paid,
          replacementTotal: op.replacement_total, hasOriginalInvoice: true });
        if (plan.allocateToOriginal > 0) {
          await provider.allocateCreditNoteToInvoice({ appTenantId: tenantId, creditNoteId: op.credit_note_id,
            invoiceId: op.original_invoice_id, amount: plan.allocateToOriginal, idempotencyKey: `omr-ao-${op.id}` });
        }
        let applied = 0;
        if (plan.allocateToReplacement > 0 && op.invoice_id) {
          const result = await provider.allocateCreditNoteToInvoice({ appTenantId: tenantId, creditNoteId: op.credit_note_id,
            invoiceId: op.invoice_id, amount: plan.allocateToReplacement, idempotencyKey: `omr-ar-${op.id}` });
          applied = round2(result?.amount);
        }
        await updateOperation(op, { allocation_state: 'done', allocation_amount: applied, last_error: null });
        if (applied > 0) {
          const paidInFull = applied >= round2(op.replacement_total);
          const { error } = await db.from('organisation_membership_history').update(paidInFull
            ? { payment_status: 'paid', paid_at: now().toISOString() } : { payment_status: 'partial' }).eq('id', op.target_record_id);
          if (error) console.error('[Replacement] Could not record applied credit on the replacement year:', error.message);
        }
      } catch (err) {
        failures.push(`Credit allocation: ${err.message}`);
        await updateOperation(op, { allocation_state: 'failed' });
      }
    }

    // 4. Email the replacement invoice with the existing template.
    if (['pending', 'failed'].includes(op.email_state) && op.invoice_state === 'done') {
      try {
        const { data: org } = await db.from('organization').select('id, name').eq('id', op.organization_id).single();
        const result = await sendInvoiceEmail({
          tenantId, organizationId: op.organization_id, organizationName: org?.name,
          membershipYear: op.membership_year, finalCost: Number(target.final_cost), currency: target.currency,
          tierLabel: target.tier_label, xeroInvoiceNumber: op.invoice_number, xeroInvoiceId: op.invoice_id,
          historyRecordId: op.target_record_id, vatAmount: Number(target.vat_amount || 0),
          totalWithVat: Number(op.replacement_total), onlineInvoiceUrl: op.online_invoice_url || null,
          tierConfig: await getConfig(tenantId, op.organization_id),
        });
        if (result && result.success === false) throw new Error(result.error || 'Invoice email could not be sent');
        await updateOperation(op, { email_state: 'done' });
      } catch (err) {
        failures.push(`Email: ${err.message}`);
        await updateOperation(op, { email_state: 'failed' });
      }
    }

    const finished = ['credit_note_state', 'invoice_state', 'allocation_state', 'email_state']
      .every(key => ['done', 'not_required'].includes(op[key]));
    await updateOperation(op, {
      sync_state: finished ? 'complete' : 'failed',
      attempts: (op.attempts || 0) + 1,
      last_error: failures.length ? failures.join(' | ').slice(0, 2000) : null,
      completed_at: finished ? now().toISOString() : null,
      lease_token: null,
      lease_expires_at: null,
    });
    if (finished && original) {
      await writeNote({ organizationId: op.organization_id, actorId: op.actor_id,
        content: `[Membership Replacement] Accounting complete for ${op.membership_year}.`
          + (op.credit_note_number ? ` Credit note ${op.credit_note_number} against invoice ${op.original_invoice_number || op.original_invoice_id}.` : '')
          + (op.invoice_number ? ` New invoice ${op.invoice_number} issued.` : '') });
    }
    return op;
  }

  async function retry({ tenantId, organizationId, operationId }) {
    const op = await loadOperation(tenantId, operationId);
    if (op.organization_id !== organizationId) throw new ReplacementError('not_found', 'Replacement not found', 404);
    return runSync({ tenantId, operationId });
  }

  return { preview, execute, retry, runSync };
}

/**
 * Attach replacement operation status to history rows (for Fee History).
 * Tolerates databases where the replacement migration is not yet applied.
 */
export async function attachReplacementOperations(db, tenantId, rows) {
  const ids = (rows || []).filter(row => row.replaced_by_record_id || row.replaces_record_id).map(row => row.id);
  if (!ids.length) return rows;
  const { data, error } = await db.from('organisation_membership_replacement')
    .select('id, source_record_id, target_record_id, reason, actor_id, created_at, sync_state, lease_expires_at, last_error, attempts, credit_note_state, credit_note_number, credit_note_amount, invoice_state, invoice_number, allocation_state, allocation_amount, email_state, original_total, original_paid, replacement_total')
    .eq('tenant_id', tenantId)
    .or(`source_record_id.in.(${ids.join(',')}),target_record_id.in.(${ids.join(',')})`);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return rows;
    throw error;
  }
  const byRow = new Map();
  const nowMs = Date.now();
  for (const op of data || []) {
    // An interrupted worker leaves in_progress behind; once its lease has
    // expired the admin may resume it (the server re-acquires the lease).
    const leaseLive = op.lease_expires_at && new Date(op.lease_expires_at).getTime() > nowMs;
    op.resumable = op.sync_state !== 'complete' && !leaseLive;
    op.stalled = op.sync_state === 'in_progress' && !leaseLive;
    delete op.lease_expires_at;
    byRow.set(op.source_record_id, op);
    byRow.set(op.target_record_id, op);
  }
  const byId = new Map((rows || []).map(row => [row.id, row]));
  for (const row of rows) {
    const op = byRow.get(row.id);
    if (op) row.replacement_operation = op;
    if (row.replaces_record_id) {
      const source = byId.get(row.replaces_record_id);
      row.replaces_label = source ? (source.accounting_invoice_number || source.xero_invoice_number || source.membership_year) : null;
    }
    if (row.replaced_by_record_id) {
      const target = byId.get(row.replaced_by_record_id);
      row.replaced_by_label = target ? (target.accounting_invoice_number || target.xero_invoice_number || target.membership_year) : null;
    }
  }
  return rows;
}
