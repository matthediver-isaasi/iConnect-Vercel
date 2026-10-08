import { prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';

const fail = code => { throw Object.assign(new Error(code), { permanent: true, code }); };
const settingsKeys = [
  'membership_nominal_ledger', 'xero_sales_account_code', 'xero_invoice_status',
  'quickbooks_membership_item_id', 'accounting_membership_item_id', 'quickbooks_default_tax_code_id',
];

// Only configuration used by the invoice builder, never tokens or other secrets.
export async function freezeMembershipPreparation({ db, args, totalMinor }) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) fail('ACCOUNTING_QUEUE_EXACT_TOTAL_REQUIRED');
  const { data, error } = await db.from('system_settings').select('setting_key,setting_value')
    .eq('tenant_id', args.appTenantId).in('setting_key', settingsKeys);
  if (error) throw error;
  const settings = Object.fromEntries((data || []).map(row => [row.setting_key, row.setting_value]));
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  // Explicit allowlist: caller contexts may contain objects not suitable for persistence.
  const frozenArgs = {};
  for (const key of ['appTenantId', 'organizationName', 'invoicingEmail', 'invoicingAddress',
    'membershipYear', 'tierLabel', 'finalCost', 'currency', 'reference', 'vatRate',
    'invoiceDescription', 'nominalCode']) {
    if (args[key] !== undefined) frozenArgs[key] = structuredClone(args[key]);
  }
  return { args: frozenArgs, totalMinor, settings, dueDate, invoiceDate };
}

function frozenSettingsDb(settings, tenantId) {
  return { from(table) {
    if (table !== 'system_settings') fail('ACCOUNTING_PREPARATION_UNFROZEN_READ');
    let key; let tenant;
    return {
      select() { return this; },
      eq(column, value) {
        if (column === 'setting_key') key = value;
        else if (column === 'tenant_id') tenant = value;
        else fail('ACCOUNTING_PREPARATION_UNFROZEN_READ');
        return this;
      },
      async maybeSingle() {
        if (tenant !== tenantId || !settingsKeys.includes(key)) fail('ACCOUNTING_PREPARATION_UNFROZEN_READ');
        return { data: settings[key] == null ? null : { setting_value: settings[key] }, error: null };
      },
    };
  } };
}

export function preparationTokenDependencies(transport) {
  return {
    getValidXeroAccessToken: async () => {
      const c = await transport.resolveConnection();
      return { accessToken: c.accessToken, tenantId: c.companyId };
    },
    getValidQuickBooksAccessToken: async () => {
      const c = await transport.resolveConnection();
      return { accessToken: c.accessToken, realmId: c.companyId, environment: c.environment };
    },
  };
}

export async function prepareMembershipSourceRequest({ row, transport }, dependencies = {}) {
  const snapshot = structuredClone(row.snapshot);
  const { args, totalMinor, settings, dueDate, invoiceDate } = snapshot.invoice;
  if (snapshot.preparation !== true || args?.appTenantId !== row.tenant_id || !settings
    || !Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    fail('ACCOUNTING_MEMBERSHIP_FROZEN_INPUTS_REQUIRED');
  }
  const prepare = dependencies.prepare || (row.provider === 'xero'
    ? (await import('./xero.js')).createXeroMembershipInvoice
    : (await import('./quickbooks.js')).createQuickBooksMembershipInvoice);
  const prepared = await prepare({ ...args, markAsPaid: false,
    transportTimeoutMs: transport.timeoutMs, deadlineAt: transport.deadlineAt,
    expectedProviderContext: row.provider === 'xero' ? { xero_tenant_id: row.company_id }
      : { quickbooks_realm_id: row.company_id, environment: snapshot.environment },
  }, { ...transport, ...preparationTokenDependencies(transport), prepareOnly: true,
    supabase: frozenSettingsDb(settings, row.tenant_id) });
  if (prepared.companyId !== row.company_id
    || (row.provider === 'quickbooks' && prepared.environment !== snapshot.environment)) {
    fail('ACCOUNTING_QUEUE_PREPARATION_BINDING_CHANGED');
  }
  const payload = structuredClone(prepared.payload);
  payload.DueDate = dueDate;
  payload[row.provider === 'xero' ? 'Date' : 'TxnDate'] = invoiceDate;
  if (row.provider === 'xero') payload.LineItems = payload.LineItems.map(line => ({ ...line, UnitAmount: Number(line.UnitAmount) }));
  const fields = row.provider === 'xero'
    // Xero returns dates in /Date(...)/ form; retain the frozen date in the
    // outbound payload, not the literal structural readback comparison.
    ? { Type: payload.Type, Status: payload.Status, LineItems: payload.LineItems }
    : { CustomerRef: payload.CustomerRef, GlobalTaxCalculation: payload.GlobalTaxCalculation, Line: payload.Line, DueDate: dueDate };
  snapshot.invoice = { envelope: prepareAccountingRequestEnvelope({
    provider: row.provider, environment: snapshot.environment,
    operationKey: `${row.tenant_id}:${row.source_type}:${row.source_id}:invoice`,
    payload, expected: { contactId: prepared.contactId, currency: args.currency, totalMinor, fields },
  }) };
  delete snapshot.preparation;
  return snapshot;
}
