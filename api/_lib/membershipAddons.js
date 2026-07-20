// Membership invoice add-on line items.
//
// Admins can attach extra line items ("add-ons") to an organisation's
// membership invoice at fee-approval time. Two types:
//   - training_fund : a Training Fund top-up (pre-filled nominal code + VAT
//                     from tenant defaults) wired into the existing
//                     pending-balance flow so the reconciliation cron credits
//                     the fund when the invoice is paid.
//   - freeform      : arbitrary description / nominal code / VAT / unit cost /
//                     quantity.
//
// Lines are stored on organisation_membership_invoicing.addon_lines (JSONB)
// per org/year, written by the fee-approval PATCH, and appended to the
// accounting invoice (Xero/QBO) by every org invoice-creation path.

import { supabase } from './database.js';

export const ADDON_SETTING_KEYS = [
  'membership_addons_enabled',
  'membership_addon_training_fund_enabled',
  'membership_addon_freeform_enabled',
  'membership_training_fund_nominal_code',
  'membership_training_fund_vat_rate',
];

const ADDON_TYPES = ['training_fund', 'freeform'];
const MAX_ADDON_LINES = 20;

/**
 * Load the tenant's add-on settings from system_settings.
 */
export async function getMembershipAddonSettings(tenantId) {
  const defaults = {
    enabled: false,
    trainingFundEnabled: false,
    freeformEnabled: false,
    trainingFundNominalCode: '',
    trainingFundVatRate: null, // { taxType, name, effectiveRate } | null
  };
  if (!supabase || !tenantId) return defaults;

  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_key, setting_value')
    .eq('tenant_id', tenantId)
    .in('setting_key', ADDON_SETTING_KEYS);

  if (error) {
    console.error('[membershipAddons] Failed to load settings:', error.message);
    return defaults;
  }

  const map = {};
  for (const row of data || []) map[row.setting_key] = row.setting_value;

  let vatRate = null;
  if (map.membership_training_fund_vat_rate && map.membership_training_fund_vat_rate !== 'none') {
    try {
      const parsed = JSON.parse(map.membership_training_fund_vat_rate);
      if (parsed && parsed.taxType) vatRate = parsed;
    } catch {
      vatRate = { taxType: map.membership_training_fund_vat_rate, name: null, effectiveRate: null };
    }
  }

  return {
    enabled: map.membership_addons_enabled === 'true',
    trainingFundEnabled: map.membership_addon_training_fund_enabled === 'true',
    freeformEnabled: map.membership_addon_freeform_enabled === 'true',
    trainingFundNominalCode: map.membership_training_fund_nominal_code || '',
    trainingFundVatRate: vatRate,
  };
}

function normaliseVatRate(vatRate) {
  if (!vatRate) return null;
  if (typeof vatRate === 'string') {
    try {
      const parsed = JSON.parse(vatRate);
      if (parsed && typeof parsed === 'object') vatRate = parsed;
      else return { taxType: vatRate, name: null, effectiveRate: null };
    } catch {
      return { taxType: vatRate, name: null, effectiveRate: null };
    }
  }
  if (!vatRate.taxType) return null;
  return {
    taxType: String(vatRate.taxType),
    name: vatRate.name || null,
    effectiveRate: vatRate.effectiveRate != null && !Number.isNaN(Number(vatRate.effectiveRate))
      ? Number(vatRate.effectiveRate)
      : null,
  };
}

/**
 * Validate + normalise add-on lines submitted with a fee approval.
 * Returns { valid: true, lines } or { valid: false, error }.
 * Training fund lines are forced to the tenant defaults (nominal + VAT).
 */
export function validateAddonLines(rawLines, settings) {
  if (rawLines == null) return { valid: true, lines: [] };
  if (!Array.isArray(rawLines)) return { valid: false, error: 'addonLines must be an array' };
  if (rawLines.length === 0) return { valid: true, lines: [] };
  if (!settings?.enabled) return { valid: false, error: 'Add-ons are not enabled in Membership Settings' };
  if (rawLines.length > MAX_ADDON_LINES) return { valid: false, error: `A maximum of ${MAX_ADDON_LINES} add-on lines is allowed` };

  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] || {};
    const label = `Add-on line ${i + 1}`;
    const type = raw.type;
    if (!ADDON_TYPES.includes(type)) {
      return { valid: false, error: `${label}: unknown type` };
    }
    if (type === 'training_fund' && !settings.trainingFundEnabled) {
      return { valid: false, error: `${label}: training fund add-ons are not enabled` };
    }
    if (type === 'freeform' && !settings.freeformEnabled) {
      return { valid: false, error: `${label}: free-form add-ons are not enabled` };
    }

    const unitCost = Number(raw.unitCost ?? raw.unit_cost);
    const quantity = Number(raw.quantity);
    if (!Number.isFinite(unitCost) || unitCost <= 0) {
      return { valid: false, error: `${label}: unit cost must be greater than zero` };
    }
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
      return { valid: false, error: `${label}: quantity must be a whole number greater than zero` };
    }

    let description, nominalCode, vatRate;
    if (type === 'training_fund') {
      description = String(raw.description || 'Training Fund top-up').trim() || 'Training Fund top-up';
      nominalCode = settings.trainingFundNominalCode || '';
      vatRate = normaliseVatRate(settings.trainingFundVatRate);
    } else {
      description = String(raw.description || '').trim();
      if (!description) return { valid: false, error: `${label}: description is required` };
      if (description.length > 500) return { valid: false, error: `${label}: description is too long` };
      nominalCode = String(raw.nominalCode ?? raw.nominal_code ?? '').trim();
      if (!nominalCode) return { valid: false, error: `${label}: nominal code is required` };
      vatRate = normaliseVatRate(raw.vatRate ?? raw.vat_rate);
    }

    const roundedUnitCost = Math.round(unitCost * 100) / 100;
    lines.push({
      type,
      description,
      nominal_code: nominalCode,
      vat_rate: vatRate,
      unit_cost: roundedUnitCost,
      quantity,
      line_total: Math.round(roundedUnitCost * quantity * 100) / 100,
    });
  }
  return { valid: true, lines };
}

/**
 * Load stored, approved add-on lines for an org/year. Returns [] when none.
 */
export async function loadAddonLines(tenantId, organizationId, membershipYear) {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('organisation_membership_invoicing')
      .select('addon_lines, fees_approved')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYear)
      .maybeSingle();
    if (!data || !Array.isArray(data.addon_lines)) return [];
    return data.addon_lines;
  } catch (err) {
    console.error('[membershipAddons] Failed to load addon lines (non-fatal):', err.message);
    return [];
  }
}

/**
 * Ex-VAT subtotal + VAT + total for a set of stored lines. VAT is computed
 * from each line's effectiveRate when known (0 otherwise — the accounting
 * package remains the source of truth for the invoiced VAT).
 */
export function computeAddonTotals(lines) {
  let subtotal = 0;
  let vat = 0;
  for (const line of lines || []) {
    const lineTotal = Number(line.line_total) || 0;
    subtotal += lineTotal;
    const rate = Number(line.vat_rate?.effectiveRate);
    if (Number.isFinite(rate) && rate > 0) vat += lineTotal * (rate / 100);
  }
  subtotal = Math.round(subtotal * 100) / 100;
  vat = Math.round(vat * 100) / 100;
  return { subtotal, vat, total: Math.round((subtotal + vat) * 100) / 100 };
}

/**
 * Map stored lines to the provider-agnostic extraLineItems shape accepted by
 * createMembershipInvoice (Xero + QBO).
 */
export function buildExtraLineItems(lines) {
  return (lines || []).map((line) => ({
    description: line.description,
    nominalCode: line.nominal_code || null,
    vatRate: line.vat_rate || null,
    unitCost: Number(line.unit_cost) || 0,
    quantity: Number(line.quantity) || 1,
  }));
}

/**
 * After an org membership invoice containing training-fund add-on line(s)
 * was created: create the pending training_fund_purchase row (payment_method
 * 'invoice') referencing that invoice and increment the org's pending
 * balance, mirroring the standalone top-up flow so the existing
 * reconciliation cron credits the available balance when the invoice is paid.
 *
 * Idempotent per invoice: if a purchase row already references this invoice
 * id, nothing is created or incremented (retries never double-credit).
 */
export async function processTrainingFundAddons({ tenantId, organizationId, invoice, addonLines, createdBy = null }) {
  if (!supabase || !invoice) return { created: false };
  const tfLines = (addonLines || []).filter((l) => l.type === 'training_fund');
  if (tfLines.length === 0) return { created: false };

  const invoiceId = invoice.invoiceId || invoice.invoice_id || null;
  if (!invoiceId) {
    console.error('[membershipAddons] Training fund add-on present but invoice has no id — cannot create purchase');
    return { created: false };
  }

  const amount = Math.round(tfLines.reduce((sum, l) => sum + (Number(l.line_total) || 0), 0) * 100) / 100;
  if (amount <= 0) return { created: false };

  // Idempotency guard — one purchase per membership invoice.
  const { data: existing, error: existErr } = await supabase
    .from('training_fund_purchase')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .eq('accounting_invoice_id', String(invoiceId))
    .limit(1);
  if (existErr) {
    console.error('[membershipAddons] Idempotency check failed — skipping purchase creation to avoid double-credit:', existErr.message);
    return { created: false, error: existErr.message };
  }
  if (existing && existing.length > 0) {
    console.log(`[membershipAddons] training_fund_purchase already exists for invoice ${invoiceId} — skipping`);
    return { created: false, alreadyExists: true };
  }

  const provider = invoice.provider || 'xero';
  const invoiceNumber = invoice.invoiceNumber || invoice.invoice_number || null;
  const insertPayload = {
    tenant_id: tenantId,
    organization_id: organizationId,
    amount,
    payment_method: 'invoice',
    status: 'pending',
    created_by: createdBy || null,
    created_date: new Date().toISOString(),
    accounting_provider: provider,
    accounting_invoice_id: String(invoiceId),
    accounting_invoice_number: invoiceNumber,
    online_invoice_url: invoice.onlineInvoiceUrl || invoice.online_invoice_url || null,
  };
  if (provider === 'xero') {
    insertPayload.xero_invoice_id = String(invoiceId);
    insertPayload.xero_invoice_number = invoiceNumber;
  }

  const { data: purchase, error: insertErr } = await supabase
    .from('training_fund_purchase')
    .insert(insertPayload)
    .select('id')
    .single();
  if (insertErr || !purchase) {
    console.error('[membershipAddons] Failed to create training_fund_purchase:', insertErr?.message);
    return { created: false, error: insertErr?.message };
  }

  const { error: pendingErr } = await supabase.rpc('increment_org_training_fund_pending', {
    p_org_id: organizationId,
    p_delta: amount,
  });
  if (pendingErr) {
    console.error('[membershipAddons] Failed to increment pending balance:', pendingErr.message);
    return { created: true, purchaseId: purchase.id, amount, error: pendingErr.message };
  }

  console.log(`[membershipAddons] training_fund_purchase ${purchase.id} created (+${amount} pending) for invoice ${invoiceId}`);
  return { created: true, purchaseId: purchase.id, amount };
}
