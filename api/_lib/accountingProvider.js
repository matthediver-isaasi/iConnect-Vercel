// Accounting provider facade (Task #996 — QuickBooks Phase 1).
//
// Single seam between application code and an accounting package. The
// facade resolves the tenant's active provider (xero | quickbooks | none)
// from `tenant_accounting_settings` and dispatches to the matching
// implementation. Phase 1 only has Xero wired up — the QuickBooks impl is
// a stub that throws a clear "not yet configured" error.
//
// Callers should:
//   const provider = await getAccountingProvider(tenantId);
//   const invoice  = await provider.createMembershipInvoice({ ... });
//
// All write helpers return a normalized shape that includes both the
// generic accounting_* fields AND the legacy xero_* fields (when the
// active provider is Xero), so callers can spread the result straight
// into a Supabase update/insert and dual-populate both column sets:
//
//   await supabase.from('booking').update(
//     buildInvoiceColumnUpdate(invoice)
//   ).eq('id', bookingId);

import { supabase } from './database.js';
import * as xero from './xero.js';
import * as qbo from './quickbooks.js';

export const PROVIDER_XERO = 'xero';
export const PROVIDER_QUICKBOOKS = 'quickbooks';
export const PROVIDER_NONE = 'none';
const VALID_PROVIDERS = new Set([PROVIDER_XERO, PROVIDER_QUICKBOOKS, PROVIDER_NONE]);

// ---------------------------------------------------------------------------
// Active-provider resolution + provider-switching guardrail
// ---------------------------------------------------------------------------

/**
 * Look up the active accounting provider for a tenant.
 * Returns one of 'xero' | 'quickbooks' | 'none'. Defaults to 'none'.
 */
export async function getActiveAccountingProvider(appTenantId) {
  if (!appTenantId || !supabase) return PROVIDER_NONE;
  try {
    const { data, error } = await supabase
      .from('tenant_accounting_settings')
      .select('active_provider')
      .eq('tenant_id', appTenantId)
      .maybeSingle();

    if (error) {
      // If the table doesn't exist yet (migration not applied) fall back
      // to deriving from xero_token rows so behavior remains unchanged.
      if (error.code === '42P01') {
        return await deriveActiveProviderFromTokens(appTenantId);
      }
      console.warn('[accountingProvider] settings lookup failed:', error.message);
      return await deriveActiveProviderFromTokens(appTenantId);
    }
    if (data?.active_provider && VALID_PROVIDERS.has(data.active_provider)) {
      return data.active_provider;
    }
    return await deriveActiveProviderFromTokens(appTenantId);
  } catch (err) {
    console.warn('[accountingProvider] settings lookup error:', err.message);
    return await deriveActiveProviderFromTokens(appTenantId);
  }
}

async function deriveActiveProviderFromTokens(appTenantId) {
  try {
    const { data } = await supabase
      .from('xero_token')
      .select('id, tenant_id')
      .eq('app_tenant_id', appTenantId)
      .neq('tenant_id', 'PENDING_SELECTION')
      .limit(1);
    if (data && data.length > 0) return PROVIDER_XERO;
  } catch {}
  return PROVIDER_NONE;
}

/**
 * Connect a provider for a tenant. Atomically:
 *   (a) marks the chosen provider active
 *   (b) clears tokens for the other provider
 *
 * Used by xero/callback.js (and the future quickbooks/callback.js). The
 * tokens themselves are written by the connect flow before/after calling
 * this helper — this function only handles the active-provider flag and
 * tear-down of the OTHER provider's tokens.
 *
 * Historical invoice/credit-note references on existing bookings or
 * membership history rows are intentionally NOT touched.
 */
export async function setActiveAccountingProvider(appTenantId, provider) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(`Invalid accounting provider: ${provider}`);
  }
  if (!supabase) throw new Error('Database not configured');

  // Upsert the active-provider flag.
  const { error: upsertErr } = await supabase
    .from('tenant_accounting_settings')
    .upsert(
      { tenant_id: appTenantId, active_provider: provider, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id' },
    );
  if (upsertErr && upsertErr.code !== '42P01') {
    throw new Error(`Failed to set active accounting provider: ${upsertErr.message}`);
  }

  // Tear down tokens for whichever provider is NOT the new active one.
  // Phase 1 only has the xero_token table populated; quickbooks_token
  // exists but no code path writes to it yet.
  if (provider !== PROVIDER_XERO) {
    try {
      await supabase.from('xero_token').delete().eq('app_tenant_id', appTenantId);
    } catch (err) {
      console.warn('[accountingProvider] failed to clear xero_token:', err.message);
    }
  }
  if (provider !== PROVIDER_QUICKBOOKS) {
    try {
      await supabase.from('quickbooks_token').delete().eq('app_tenant_id', appTenantId);
    } catch (err) {
      // 42P01 = table doesn't exist yet; harmless before migration applied.
      if (err?.code !== '42P01') {
        console.warn('[accountingProvider] failed to clear quickbooks_token:', err.message);
      }
    }
  }
}

/**
 * Disconnect the currently-active provider for a tenant. Clears the
 * provider tokens and resets the active flag to 'none'. Historical
 * invoice references on bookings/history rows are preserved.
 */
export async function disconnectActiveAccountingProvider(appTenantId) {
  if (!appTenantId) throw new Error('appTenantId is required');
  if (!supabase) throw new Error('Database not configured');

  const active = await getActiveAccountingProvider(appTenantId);
  if (active === PROVIDER_XERO) {
    await supabase.from('xero_token').delete().eq('app_tenant_id', appTenantId);
  } else if (active === PROVIDER_QUICKBOOKS) {
    try {
      await supabase.from('quickbooks_token').delete().eq('app_tenant_id', appTenantId);
    } catch (err) {
      if (err?.code !== '42P01') throw err;
    }
  }

  try {
    await supabase
      .from('tenant_accounting_settings')
      .upsert(
        { tenant_id: appTenantId, active_provider: PROVIDER_NONE, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id' },
      );
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  }
}

// ---------------------------------------------------------------------------
// Connection / status surface
// ---------------------------------------------------------------------------

/**
 * Returns { provider, connected, details } describing the tenant's
 * current accounting connection. Suitable for surfacing in the admin
 * status endpoint.
 */
export async function getAccountingConnectionStatus(appTenantId) {
  const provider = await getActiveAccountingProvider(appTenantId);
  if (provider === PROVIDER_XERO) {
    const tokens = await getXeroTokenSummaries(appTenantId);
    return {
      provider,
      connected: tokens.some((t) => t.tenant_id && t.tenant_id !== 'PENDING_SELECTION'),
      tokens,
    };
  }
  if (provider === PROVIDER_QUICKBOOKS) {
    const quickbooks = await getQuickBooksStatusSummary(appTenantId);
    return {
      provider,
      connected: !!quickbooks.connected,
      tokens: [],
      quickbooks,
    };
  }
  // Even when 'none' is active, fall through and report any latent
  // xero_token rows so the admin UI can show "previously connected".
  const tokens = await getXeroTokenSummaries(appTenantId);
  const quickbooks = await getQuickBooksStatusSummary(appTenantId);
  return { provider: PROVIDER_NONE, connected: false, tokens, quickbooks };
}

async function getQuickBooksTokenSummary(appTenantId) {
  try {
    const { data, error } = await supabase
      .from('quickbooks_token')
      .select('id, realm_id, company_name, environment, expires_at, updated_at, created_at')
      .eq('app_tenant_id', appTenantId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
      console.warn('[accountingProvider] qbo token lookup failed:', error.message);
    }
    return data || null;
  } catch {
    return null;
  }
}

async function hasQuickBooksCredentials(appTenantId) {
  try {
    const { data, error } = await supabase
      .from('tenant_integrations')
      .select('id, is_enabled')
      .eq('tenant_id', appTenantId)
      .eq('integration_type', 'quickbooks')
      .maybeSingle();
    if (error && error.code !== 'PGRST116' && error.code !== '42P01') {
      console.warn('[accountingProvider] qbo integration lookup failed:', error.message);
    }
    return { has_credentials: !!data, is_enabled: !!(data && data.is_enabled) };
  } catch {
    return { has_credentials: false, is_enabled: false };
  }
}

async function getQuickBooksStatusSummary(appTenantId) {
  const [token, creds] = await Promise.all([
    getQuickBooksTokenSummary(appTenantId),
    hasQuickBooksCredentials(appTenantId),
  ]);
  const connected = !!(token && token.realm_id);
  return {
    ...(token || {}),
    has_credentials: creds.has_credentials,
    is_enabled: creds.is_enabled,
    connected,
    needs_connection: creds.has_credentials && !connected,
  };
}

async function getXeroTokenSummaries(appTenantId) {
  try {
    const { data } = await supabase
      .from('xero_token')
      .select('id, tenant_id, tenant_name, expires_at, app_tenant_id')
      .eq('app_tenant_id', appTenantId);
    return data || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Column-write helpers — dual-write generic + legacy xero_* columns
// ---------------------------------------------------------------------------

/**
 * Build a Supabase update/insert payload for an invoice reference.
 * `invoice` is the normalized shape returned by createMembershipInvoice
 * (or applyStripePaymentToInvoice). Returns both generic and legacy
 * columns so the same payload works on tables that have either column
 * set (the legacy columns are ignored if absent on the table).
 */
export function buildInvoiceColumnUpdate(invoice) {
  if (!invoice) return {};
  const provider = invoice.provider || PROVIDER_XERO;
  const id = invoice.invoiceId || invoice.invoice_id || null;
  const number = invoice.invoiceNumber || invoice.invoice_number || null;
  const out = {
    accounting_provider: provider,
    accounting_invoice_id: id,
    accounting_invoice_number: number,
  };
  if (provider === PROVIDER_XERO) {
    out.xero_invoice_id = id;
    out.xero_invoice_number = number;
  }
  return out;
}

/**
 * Build a Supabase update payload for a credit-note reference.
 */
export function buildCreditNoteColumnUpdate(creditNote) {
  if (!creditNote) return {};
  const provider = creditNote.provider || PROVIDER_XERO;
  const id = creditNote.creditNoteId || creditNote.credit_note_id || null;
  const number = creditNote.creditNoteNumber || creditNote.credit_note_number || null;
  const out = {
    accounting_provider: provider,
    accounting_credit_note_id: id,
    accounting_credit_note_number: number,
  };
  if (provider === PROVIDER_XERO) {
    out.xero_credit_note_id = id;
    out.xero_credit_note_number = number;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

function makeXeroProvider() {
  return {
    name: PROVIDER_XERO,

    async getRawAccessToken(appTenantId) {
      // Escape hatch for the few callers that talk to Xero's raw HTTP
      // surface (e.g. fetching OnlineInvoice URL, checking invoice
      // status, listing tax rates). These are intentionally not part of
      // the provider-agnostic API — when QBO is added in Phase 2 each
      // raw caller will be migrated to a dedicated facade method.
      return xero.getValidXeroAccessToken(appTenantId);
    },

    async resolveOrCreateContact({ appTenantId, contactInfo }) {
      const { accessToken, tenantId } = await xero.getValidXeroAccessToken(appTenantId);
      const contactId = await xero.findOrCreateXeroContact(accessToken, tenantId, contactInfo);
      return { provider: PROVIDER_XERO, contactId };
    },

    async createMembershipInvoice(args) {
      const result = await xero.createXeroMembershipInvoice(args);
      if (!result) return null;
      return {
        provider: PROVIDER_XERO,
        invoiceId: result.invoice_id,
        invoiceNumber: result.invoice_number,
        onlineInvoiceUrl: result.online_invoice_url || null,
        raw: result,
        // legacy aliases for callers that still read them directly
        invoice_id: result.invoice_id,
        invoice_number: result.invoice_number,
        online_invoice_url: result.online_invoice_url || null,
      };
    },

    async applyStripePaymentToInvoice(args) {
      const result = await xero.applyStripePaymentToXeroInvoice(args);
      if (!result) return null;
      return {
        provider: PROVIDER_XERO,
        invoiceId: result.invoice_id,
        invoiceNumber: result.invoice_number,
        onlineInvoiceUrl: result.online_invoice_url || null,
        raw: result,
        invoice_id: result.invoice_id,
        invoice_number: result.invoice_number,
        online_invoice_url: result.online_invoice_url || null,
      };
    },

    async createCreditNote(args) {
      const result = await xero.createXeroCreditNote(args);
      if (!result) return null;
      return {
        provider: PROVIDER_XERO,
        creditNoteId: result.creditNoteId,
        creditNoteNumber: result.creditNoteNumber,
        amount: result.amount,
        allocated: result.allocated,
        invoiceNumber: result.invoiceNumber,
        alreadyExisted: !!result.alreadyExisted,
        skipped: !!result.skipped,
        reason: result.reason || null,
        // pass-through originals for callers still using legacy field names
        ...result,
      };
    },

    async emailCreditNote(args) {
      return xero.emailXeroCreditNote(args);
    },

    async pushPurchaseOrder(args) {
      return xero.pushPurchaseOrderToXero(args);
    },

    async fetchInvoicePdf(invoiceId, appTenantId) {
      return xero.fetchXeroInvoicePdf(invoiceId, appTenantId);
    },

    async fetchCreditNotePdf(creditNoteId, appTenantId) {
      return xero.fetchXeroCreditNotePdf(creditNoteId, appTenantId);
    },

    async updateInvoiceReference(appTenantId, invoiceId, reference) {
      return xero.updateXeroInvoiceReference(appTenantId, invoiceId, reference);
    },
  };
}

function makeQuickBooksProvider() {
  return {
    name: PROVIDER_QUICKBOOKS,

    async getRawAccessToken(appTenantId) {
      const { accessToken, realmId, environment } = await qbo.getValidQuickBooksAccessToken(appTenantId);
      // tenantId is aliased to realmId so callers using the Xero-shaped
      // { accessToken, tenantId } pair still work (e.g. raw HTTP probes).
      return { accessToken, tenantId: realmId, realmId, environment };
    },

    async resolveOrCreateContact({ appTenantId, contactInfo }) {
      const contactId = await qbo.findOrCreateQuickBooksCustomer(appTenantId, contactInfo);
      return { provider: PROVIDER_QUICKBOOKS, contactId };
    },

    async createMembershipInvoice(args) {
      const result = await qbo.createQuickBooksMembershipInvoice(args);
      if (!result) return null;
      return {
        provider: PROVIDER_QUICKBOOKS,
        invoiceId: result.invoice_id,
        invoiceNumber: result.invoice_number,
        onlineInvoiceUrl: result.online_invoice_url || null,
        raw: result,
        invoice_id: result.invoice_id,
        invoice_number: result.invoice_number,
        online_invoice_url: result.online_invoice_url || null,
      };
    },

    async applyStripePaymentToInvoice(args) {
      const result = await qbo.applyStripePaymentToQuickBooksInvoice(args);
      if (!result) return null;
      return {
        provider: PROVIDER_QUICKBOOKS,
        invoiceId: result.invoice_id,
        invoiceNumber: result.invoice_number,
        onlineInvoiceUrl: result.online_invoice_url || null,
        raw: result,
        invoice_id: result.invoice_id,
        invoice_number: result.invoice_number,
        online_invoice_url: result.online_invoice_url || null,
      };
    },

    async createCreditNote(args) {
      const result = await qbo.createQuickBooksCreditNote(args);
      if (!result) return null;
      return {
        provider: PROVIDER_QUICKBOOKS,
        creditNoteId: result.creditNoteId,
        creditNoteNumber: result.creditNoteNumber,
        amount: result.amount,
        allocated: result.allocated,
        invoiceNumber: result.invoiceNumber,
        alreadyExisted: !!result.alreadyExisted,
        skipped: !!result.skipped,
        reason: result.reason || null,
        ...result,
      };
    },

    async emailCreditNote(args) {
      return qbo.emailQuickBooksCreditNote(args);
    },

    async pushPurchaseOrder(args) {
      return qbo.pushPurchaseOrderToQuickBooksInvoice(args);
    },

    async fetchInvoicePdf(invoiceId, appTenantId) {
      return qbo.fetchQuickBooksInvoicePdf(appTenantId, invoiceId);
    },

    async fetchCreditNotePdf(creditNoteId, appTenantId) {
      return qbo.fetchQuickBooksCreditNotePdf(appTenantId, creditNoteId);
    },

    async updateInvoiceReference(appTenantId, invoiceId, reference) {
      return qbo.updateQuickBooksInvoiceReference(appTenantId, invoiceId, reference);
    },
  };
}

function makeNoneProvider() {
  const notConnected = (op) => {
    const err = new Error(
      `No accounting provider is configured for this tenant (operation: ${op}). ` +
      `Connect Xero (or QuickBooks, once available) in Admin Settings.`,
    );
    err.code = 'ACCOUNTING_PROVIDER_NONE';
    err.provider = PROVIDER_NONE;
    return err;
  };
  return {
    name: PROVIDER_NONE,
    async getRawAccessToken()          { throw notConnected('getRawAccessToken'); },
    async resolveOrCreateContact()     { throw notConnected('resolveOrCreateContact'); },
    async createMembershipInvoice()    { throw notConnected('createMembershipInvoice'); },
    async applyStripePaymentToInvoice(){ throw notConnected('applyStripePaymentToInvoice'); },
    async createCreditNote()           { throw notConnected('createCreditNote'); },
    async emailCreditNote()            { throw notConnected('emailCreditNote'); },
    async pushPurchaseOrder()          { throw notConnected('pushPurchaseOrder'); },
    async fetchInvoicePdf()            { throw notConnected('fetchInvoicePdf'); },
    async fetchCreditNotePdf()         { throw notConnected('fetchCreditNotePdf'); },
    async updateInvoiceReference()     { throw notConnected('updateInvoiceReference'); },
  };
}

/**
 * Resolve and return a provider implementation for a tenant.
 * Always returns an object (never null) — for tenants with no provider
 * configured, the returned object throws a clear error from every
 * operation.
 */
export async function getAccountingProvider(appTenantId) {
  const active = await getActiveAccountingProvider(appTenantId);
  if (active === PROVIDER_XERO) return makeXeroProvider();
  if (active === PROVIDER_QUICKBOOKS) return makeQuickBooksProvider();
  return makeNoneProvider();
}
