import { enqueueAccountingRequest, processAccountingRequest } from './accountingRequestQueue.js';
import { createAccountingRequestProviders, prepareAccountingRequestEnvelope } from './accountingRequestProviders.js';
import { linkAccountingProductSource } from './accountingQueueProductLinks.js';
import {
  GO_CARDLESS_ACCOUNTING_SOURCE, assertGoCardlessAccountingSource,
  linkGoCardlessAccountingSource, prepareGoCardlessSourceRequest,
} from './accountingQueueGoCardless.js';

export const accountingQueueEnabled = () => process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED === 'true';
export const accountingMembershipQueueEnabled = sourceType => accountingQueueEnabled()
  && ['member_membership_history', 'organisation_membership_history'].includes(sourceType)
  && (process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES || '').split(',').map(value => value.trim()).includes(sourceType);
const fail = code => { throw Object.assign(new Error(code), { code, permanent: true, definitelyNotWritten: true }); };
const memberTables = new Set(['member_membership_history', 'organisation_membership_history']);
async function one(query) {
  let pending = query.maybeSingle();
  if (typeof pending.abortSignal === 'function') pending = pending.abortSignal(AbortSignal.timeout(5000));
  const { data, error } = await pending;
  if (error || !data) fail('ACCOUNTING_QUEUE_SOURCE_OR_BINDING_UNAVAILABLE');
  return data;
}
function membershipQuery(db, row) {
  const link = row.snapshot?.linkage;
  const ownerColumn = row.source_type === 'member_membership_history' ? 'member_id' : 'organization_id';
  if (!memberTables.has(row.source_type) || link?.recordId !== row.source_id || !link.ownerId) {
    fail('ACCOUNTING_QUEUE_INVALID_MEMBERSHIP_AUTHORITY');
  }
  return db.from(row.source_type).select('*').eq('id', row.source_id)
    .eq('tenant_id', row.tenant_id).eq(ownerColumn, link.ownerId);
}
export async function assertAccountingSource({ db, row }) {
  if (row.source_type === GO_CARDLESS_ACCOUNTING_SOURCE) return assertGoCardlessAccountingSource({ db, row });
  if (memberTables.has(row.source_type)) {
    const source = await one(membershipQuery(db, row));
    // These have independent settlement/instalment ownership.
    if (source.form_submission_id || source.instalment_plan_id) fail('ACCOUNTING_QUEUE_EXISTING_SETTLEMENT_OWNER');
    const existing = source.accounting_invoice_id || source.xero_invoice_id;
    if (existing && (existing !== row.invoice_result?.id
      || (source.accounting_provider && source.accounting_provider !== row.provider))) {
      fail('ACCOUNTING_QUEUE_SOURCE_ALREADY_LINKED');
    }
    if (row.provider === 'xero' && source.xero_invoice_id && source.xero_invoice_id !== row.invoice_result?.id) {
      fail('ACCOUNTING_QUEUE_SOURCE_ALREADY_LINKED');
    }
    return source;
  }
  // Product handlers validate the accepted sale/purchase again on linkage.
  const link = row.snapshot?.linkage;
  if (row.source_type === 'training_fund_purchase' && link?.purchaseId === row.source_id && link.organizationId) {
    const purchase = await one(db.from('training_fund_purchase').select('*').eq('id', row.source_id)
      .eq('tenant_id', row.tenant_id).eq('organization_id', link.organizationId));
    const existing = purchase.accounting_invoice_id || purchase.xero_invoice_id;
    if (existing && (existing !== row.invoice_result?.id
      || (purchase.accounting_provider && purchase.accounting_provider !== row.provider))) {
      fail('ACCOUNTING_QUEUE_SOURCE_ALREADY_LINKED');
    }
    return purchase;
  }
  if (row.source_type === 'sales_commercial_sale' && link?.saleId === row.source_id && link.quoteVersionId
    && link.attemptId && link.actorId) {
    const sale = await one(db.from('sales_commercial_sale').select('*').eq('id', row.source_id)
      .eq('tenant_id', row.tenant_id).eq('quote_version_id', link.quoteVersionId));
    await one(db.from('sales_accounting_invoice_attempt').select('*').eq('tenant_id', row.tenant_id)
      .eq('id', link.attemptId).eq('sale_id', row.source_id).eq('provider', row.provider));
    const { data: existing, error } = await db.from('sales_accounting_invoice_link').select('*')
      .eq('tenant_id', row.tenant_id).eq('sale_id', row.source_id).eq('provider', row.provider).maybeSingle();
    if (error) fail('ACCOUNTING_QUEUE_SOURCE_LINK_LOOKUP_FAILED');
    if (existing && (existing.provider_invoice_id !== row.invoice_result?.id
      || existing.quote_version_id !== link.quoteVersionId)) fail('ACCOUNTING_QUEUE_SOURCE_ALREADY_LINKED');
    return sale;
  }
  fail('ACCOUNTING_QUEUE_UNSUPPORTED_SOURCE');
}
export async function linkAccountingMembershipSource({ db, row }) {
  const source = await assertAccountingSource({ db, row });
  const result = row.invoice_result;
  if (!memberTables.has(row.source_type) || !result?.id) fail('ACCOUNTING_QUEUE_INVALID_LINK_RESULT');
  const columns = {
    accounting_provider: row.provider, accounting_invoice_id: result.id,
    accounting_invoice_number: result.invoiceNumber || result.invoice_number || null,
    ...(row.provider === 'xero' ? { xero_invoice_id: result.id,
      xero_invoice_number: result.invoiceNumber || result.invoice_number || null } : {}),
  };
  if (Object.entries(columns).some(([key, value]) => (source[key] ?? null) !== value)) {
    const ownerColumn = row.source_type === 'member_membership_history' ? 'member_id' : 'organization_id';
    let query = db.from(row.source_type).update(columns).eq('id', row.source_id)
      .eq('tenant_id', row.tenant_id).eq(ownerColumn, row.snapshot.linkage.ownerId);
    query = source.accounting_invoice_id ? query.eq('accounting_invoice_id', source.accounting_invoice_id) : query.is('accounting_invoice_id', null);
    query = source.xero_invoice_id ? query.eq('xero_invoice_id', source.xero_invoice_id) : query.is('xero_invoice_id', null);
    const { error } = await query;
    if (error) fail('ACCOUNTING_QUEUE_SOURCE_LINK_FAILED');
  }
  const saved = await one(membershipQuery(db, row));
  if (Object.entries(columns).some(([key, value]) => (saved[key] ?? null) !== value)) {
    fail('ACCOUNTING_QUEUE_SOURCE_LINK_NOT_PERSISTED');
  }
  return { linked: true, recordId: row.source_id };
}

export async function resolveAccountingQueueBinding({ db, tenantId, provider }) {
  const settings = await one(db.from('tenant_accounting_settings').select('active_provider').eq('tenant_id', tenantId));
  if (settings.active_provider !== provider) fail('ACCOUNTING_QUEUE_PROVIDER_CHANGED');
  const token = await one(db.from(provider === 'xero' ? 'xero_token' : 'quickbooks_token')
    .select('*').eq('app_tenant_id', tenantId));
  const companyId = provider === 'xero' ? token.tenant_id : token.realm_id;
  if (!token.id || !companyId || companyId === 'PENDING_SELECTION') fail('ACCOUNTING_QUEUE_INVALID_BINDING');
  return { tenantId, provider, connectionId: String(token.id), companyId: String(companyId),
    environment: provider === 'quickbooks' ? token.environment || 'production' : null,
    accessToken: token.access_token, expiresAt: token.expires_at };
}

export async function getAccountingQueueAdapter(row, controls = {}, dependencies = {}) {
  const db = dependencies.db || (await import('./database.js')).supabase;
  if (typeof controls.beforeRequest !== 'function') fail('ACCOUNTING_QUEUE_MISSING_FENCE');
  const beforeRequest = async (candidate, stage) => {
    const budget = await controls.beforeRequest(candidate, stage);
    await assertAccountingSource({ db, row: candidate });
    return budget;
  };
  const resolveConnection = dependencies.resolveConnection || (async (candidate, transport) => {
    let binding = await resolveAccountingQueueBinding({ db, tenantId: candidate.tenant_id, provider: candidate.provider });
    if (binding.connectionId !== candidate.connection_id || binding.companyId !== candidate.company_id) {
      fail('ACCOUNTING_QUEUE_BINDING_CHANGED');
    }
    if (!binding.accessToken || !(Date.parse(binding.expiresAt) > Date.now() + 30000)) {
      const refresh = candidate.provider === 'xero'
        ? (await import('./xero.js')).getValidXeroAccessToken
        : (await import('./quickbooks.js')).getValidQuickBooksAccessToken;
      await refresh(candidate.tenant_id, { fetch: transport.fetch, timeoutMs: 10000, deadlineAt: controls.deadlineAt });
      binding = await resolveAccountingQueueBinding({ db, tenantId: candidate.tenant_id, provider: candidate.provider });
    }
    return binding;
  });
  const adapter = createAccountingRequestProviders({ resolveConnection, beforeRequest, deadlineAt: controls.deadlineAt,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}) });
  return { ...adapter,
    ...(row.source_type === GO_CARDLESS_ACCOUNTING_SOURCE ? {
      prepare: async candidate => {
        // Provider transport constrains preparation to bound reads/contacts;
        // financial writes cannot masquerade as an unfenced preparation call.
        const transport = adapter.preparationTransport(candidate);
        const scopedFetch = transport.fetch;
        let preparationFailure = null;
        transport.fetch = async (...args) => {
          if (preparationFailure) throw preparationFailure;
          try {
            const response = await scopedFetch(...args);
            if (!response.ok) throw Object.assign(new Error('ACCOUNTING_QUEUE_PREPARATION_PROVIDER_FAILED'), { status: response.status });
            return response;
          } catch (error) {
            preparationFailure = error;
            throw error;
          }
        };
        transport.resolveConnection = async () => {
          await adapter.assertBinding(candidate);
          return resolveAccountingQueueBinding({ db, tenantId: candidate.tenant_id, provider: candidate.provider });
        };
        let prepared;
        try {
          prepared = await prepareGoCardlessSourceRequest({ row: candidate, db, providers: adapter, transport },
            dependencies.preparation || {});
        } catch (error) { throw preparationFailure || error; }
        // Legacy contact/tax resolvers sometimes catch "non-fatal" reads. A
        // swallowed 429 must not lose its embargo or authorize further calls.
        if (preparationFailure) throw preparationFailure;
        return prepared;
      },
    } : {}),
    linkSource: async candidate => {
    await beforeRequest(candidate, { kind: 'link', method: 'PATCH' });
    if (candidate.source_type === GO_CARDLESS_ACCOUNTING_SOURCE) return linkGoCardlessAccountingSource({ db, row: candidate });
    return memberTables.has(candidate.source_type)
      ? linkAccountingMembershipSource({ db, row: candidate })
      : linkAccountingProductSource({ db, row: candidate });
  } };
}

export function accountingQueueFacadeResult(row) {
  if (!row?.id) fail('ACCOUNTING_QUEUE_REQUEST_UNAVAILABLE');
  const complete = row.state === 'complete' && row.invoice_status === 'done'
    && !!row.invoice_result?.id && row.link_status === 'done' && row.link_result?.linked === true
    && (row.snapshot?.payment ? row.payment_status === 'done' && !!row.payment_result?.id : row.payment_status === 'skipped');
  return { ...(row.invoice_result || {}), provider: row.provider,
    accounting_request_id: row.id, accounting_pending: !complete,
    accounting_state: row.state === 'complete' && !complete ? 'review' : row.state,
    payment_recorded: row.payment_status === 'done' && row.payment_result?.payment_recorded === true };
}

export async function submitPreparedAccountingRequest({
  db, tenantId, provider, connectionId, companyId, sourceType, sourceId,
  invoiceEnvelope, paymentEnvelope = null, linkage, adapters,
}) {
  if (!invoiceEnvelope || invoiceEnvelope.provider !== provider
    || (paymentEnvelope && paymentEnvelope.provider !== provider)) fail('ACCOUNTING_QUEUE_INVALID_ENVELOPE');
  let row;
  try {
    row = await enqueueAccountingRequest({ db, tenantId, provider, connectionId, companyId,
      sourceType, sourceId, snapshot: { version: 1, invoice: { envelope: invoiceEnvelope },
        payment: paymentEnvelope ? { envelope: paymentEnvelope } : null, linkage } });
  } catch (error) {
    // A lost enqueue response can hide a committed request. Preserve its source
    // for identity-based lookup; never interpret this as permission to delete
    // history or create via a second writer.
    error.accountingSourceRetained = true;
    throw error;
  }
  if (row.state === 'complete') return accountingQueueFacadeResult(row);
  // Once accepted, an unavailable worker must not make callers roll back the
  // genuine source or invoke a legacy writer.
  let processed = null;
  try { processed = await processAccountingRequest({ db, requestId: row.id, ...(adapters ? { adapters } : {}) }); }
  catch { return { ...accountingQueueFacadeResult(row), accounting_pending: true, accounting_state: 'pending' }; }
  return accountingQueueFacadeResult(processed || row);
}

// Resume FIRST, before any catalogue/contact/price preparation. In particular,
// admin retries cannot replace an accepted snapshot with reconstructed economics.
export async function resumeAccountingSource({ db, tenantId, sourceType, sourceId, adapters, allowMissingQueue = false }) {
  const { data, error } = await db.from('accounting_request_queue').select('*')
    .eq('tenant_id', tenantId).eq('source_type', sourceType).eq('source_id', sourceId)
    .eq('operation', 'invoice').maybeSingle();
  if (error) {
    // OFF installations without the migration retain legacy behaviour. Never
    // treat permission errors, timeouts or a broken RPC/schema as "no owner".
    const missingTable = error.code === '42P01'
      || (error.code === 'PGRST205' && String(error.message || '').includes('accounting_request_queue'));
    if (allowMissingQueue && missingTable) return null;
    fail('ACCOUNTING_QUEUE_LOOKUP_FAILED');
  }
  if (!data) return null;
  if (data.state === 'complete') return accountingQueueFacadeResult(data);
  let processed = null;
  try { processed = await processAccountingRequest({ db, requestId: data.id, ...(adapters ? { adapters } : {}) }); }
  catch { return { ...accountingQueueFacadeResult(data), accounting_pending: true,
    accounting_state: data.state === 'complete' ? 'review' : data.state }; }
  return accountingQueueFacadeResult(processed || data);
}

export async function prepareMembershipAccountingRequest({ db, provider, args, sourceType, sourceId, totalMinor, linkage }, dependencies = {}) {
  if (args.markAsPaid || args.deferStripeSettlement || args.ddAccountingMigration
    || args.stripePaymentIntentId || args.extraLineItems?.length) fail('ACCOUNTING_QUEUE_UNSUPPORTED_MEMBERSHIP_PAYMENT_OR_ADDONS');
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) fail('ACCOUNTING_QUEUE_EXACT_TOTAL_REQUIRED');
  const binding = await resolveAccountingQueueBinding({ db, tenantId: args.appTenantId, provider });
  const prepare = dependencies.prepare || (provider === 'xero'
    ? (await import('./xero.js')).createXeroMembershipInvoice
    : (await import('./quickbooks.js')).createQuickBooksMembershipInvoice);
  const prepared = await prepare(args, { ...dependencies, supabase: db, prepareOnly: true });
  if (prepared.companyId !== binding.companyId
    || (provider === 'quickbooks' && prepared.environment !== binding.environment)) fail('ACCOUNTING_QUEUE_PREPARATION_BINDING_CHANGED');
  const payload = prepared.payload;
  // Readbacks commonly normalize numeric Xero UnitAmount strings.
  if (provider === 'xero') payload.LineItems = payload.LineItems.map(line => ({ ...line, UnitAmount: Number(line.UnitAmount) }));
  const fields = provider === 'xero'
    ? { Type: payload.Type, Status: payload.Status, LineItems: payload.LineItems }
    : { CustomerRef: payload.CustomerRef, GlobalTaxCalculation: payload.GlobalTaxCalculation,
      Line: payload.Line };
  const operationKey = `${args.appTenantId}:${sourceType}:${sourceId}:invoice`;
  const invoiceEnvelope = prepareAccountingRequestEnvelope({ provider, operationKey,
    payload, expected: { contactId: prepared.contactId, currency: args.currency, totalMinor, fields },
    environment: prepared.environment });
  return { db, tenantId: args.appTenantId, provider, connectionId: binding.connectionId,
    companyId: binding.companyId, sourceType, sourceId, invoiceEnvelope, paymentEnvelope: null, linkage };
}

export async function queueMembershipInvoice({ db, provider, args }) {
  const { sourceType, sourceId, totalMinor, linkage } = args.accountingSource || {};
  if (!memberTables.has(sourceType) && sourceType !== 'training_fund_purchase') fail('ACCOUNTING_QUEUE_UNSUPPORTED_SOURCE');
  const enabled = accountingMembershipQueueEnabled(sourceType);
  const resumed = await resumeAccountingSource({ db, tenantId: args.appTenantId, sourceType, sourceId,
    allowMissingQueue: !enabled });
  if (resumed) return resumed;
  // This first rollout has no durable preparation/payment stage. Explicitly
  // retain the existing owners for paid, form, instalment and add-on work.
  // The resume above MUST precede this check so a queued identity never escapes.
  if (!enabled || !supportsPreparedMembershipSource(args)) return undefined;
  await assertAccountingSource({ db, row: { tenant_id: args.appTenantId, provider,
    source_type: sourceType, source_id: sourceId, snapshot: { linkage } } });
  return submitPreparedAccountingRequest(await prepareMembershipAccountingRequest({
    db, provider, args, sourceType, sourceId, totalMinor, linkage,
  }));
}

export function supportsPreparedMembershipSource(args) {
  return memberTables.has(args?.accountingSource?.sourceType)
    && !!args.accountingSource.sourceId && !!args.accountingSource.linkage?.ownerId
    && !args.markAsPaid && !args.deferStripeSettlement && !args.ddAccountingMigration
    && !args.stripePaymentIntentId && !args.extraLineItems?.length;
}