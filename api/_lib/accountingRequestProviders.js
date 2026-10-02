import { accountingOperationIdentity } from './accountingOperationIdentity.js';

// This boundary deliberately does not import the legacy invoice helpers: those
// combine preparation, invoice creation, payment and best-effort linkage. Queue
// integration must resolve contacts/tax/accounts and run the source's existing
// form/event/BNMS guards BEFORE persisting this envelope. No catalogue lookup or
// customer creation is allowed while replaying it.
export class AccountingRequestProviderError extends Error {
  constructor(code, properties = {}) {
    super(`Accounting provider request failed: ${code}`);
    this.name = 'AccountingRequestProviderError';
    this.code = code;
    Object.assign(this, properties);
  }
}

const fail = (code, properties = {}) => { throw new AccountingRequestProviderError(code, properties); };
const permanent = (code) => fail(code, { permanent: true, definitelyNotWritten: true });
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const markerFor = (key, kind) => `[aq:${accountingOperationIdentity(key, kind === 'invoice' ? 'inv' : 'pay', 50)}]`;
function minor(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return NaN;
  const scaled = Number(value) * 100;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) < 1e-7
    ? Math.round(scaled) : NaN;
}
function appendMarker(original, marker, limit) {
  const result = original ? `${original}\n${marker}` : marker;
  if (result.length > limit) permanent('MARKER_FIELD_TOO_LONG');
  return result;
}

/**
 * Store this result at snapshot.invoice.envelope / snapshot.payment.envelope.
 * payload is already-resolved provider JSON, never helper arguments.
 * expected is {contactId,currency,totalMinor, invoiceId?,accountId?, fields}.
 * fields is a provider-shaped subset covering source-specific line, tax,
 * reference, status and account invariants, checked again on provider readback.
 */
export function prepareAccountingRequestEnvelope({ provider, operationKey, kind = 'invoice', payload, expected, environment }) {
  if (!['xero', 'quickbooks'].includes(provider) || !['invoice', 'payment'].includes(kind)
      || !nonempty(operationKey) || !payload || !expected
      || !nonempty(expected.contactId) || !/^[A-Z]{3}$/.test(expected.currency || '')
      || !Number.isSafeInteger(expected.totalMinor) || expected.totalMinor < 0
      || !expected.fields || !Object.keys(expected.fields).length) permanent('INVALID_ENVELOPE');
  if (provider === 'quickbooks' && !['production', 'sandbox'].includes(environment)) permanent('INVALID_ENVIRONMENT');
  if (kind === 'payment' && (!nonempty(expected.invoiceId) || !nonempty(expected.accountId)
      || expected.totalMinor <= 0)) permanent('INVALID_PAYMENT_ENVELOPE');
  const body = clone(payload);
  if (body.Id || body.InvoiceID || body.PaymentID || body.SyncToken || body.sparse) permanent('CREATE_PAYLOAD_HAS_ID');
  const marker = markerFor(operationKey, kind);
  const field = provider === 'quickbooks' ? 'PrivateNote' : 'Reference';
  body[field] = appendMarker(body[field], marker, provider === 'quickbooks' ? 4000 : 255);
  return freeze({ version: 1, provider, operationKey, kind, environment: environment || null,
    payload: body, expected: clone(expected), marker });
}

function subset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, i) => subset(actual[i], value));
  if (expected && typeof expected === 'object') return !!actual
    && Object.entries(expected).every(([key, value]) => subset(actual[key], value));
  return actual === expected;
}

function envelope(row, kind) {
  const value = (row?.resolved_snapshot || row?.snapshot)?.[kind]?.envelope;
  if (!value || value.version !== 1 || value.provider !== row.provider || value.kind !== kind
      || value.marker !== markerFor(value.operationKey, kind)) permanent('MISSING_OR_INVALID_FROZEN_ENVELOPE');
  // Revalidate without re-appending the marker. Never mutate the stored JSON.
  const field = row.provider === 'quickbooks' ? 'PrivateNote' : 'Reference';
  if (!String(value.payload?.[field] || '').split('\n').includes(value.marker)
      || !value.expected?.fields || !nonempty(value.expected.contactId)
      || !/^[A-Z]{3}$/.test(value.expected.currency || '')
      || !Number.isSafeInteger(value.expected.totalMinor)) permanent('INVALID_FROZEN_ENVELOPE');
  const copy = clone(value);
  if (kind === 'payment') {
    // The sole late-bound value is the durable, validated invoice result.
    // Integrators use this literal for InvoiceID / TxnId / expected.invoiceId.
    const replace = (item) => {
      if (item === '$invoice') {
        if (!nonempty(row.invoice_result?.id)) permanent('MISSING_INVOICE_RESULT');
        return row.invoice_result.id;
      }
      if (Array.isArray(item)) return item.map(replace);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, replace(entry)]));
      return item;
    };
    copy.payload = replace(copy.payload);
    copy.expected = replace(copy.expected);
  }
  return freeze(copy);
}

export function validateAccountingRequestResult(row, kind, record) {
  const e = envelope(row, kind), xero = row.provider === 'xero', payment = kind === 'payment';
  const id = record?.[xero ? (payment ? 'PaymentID' : 'InvoiceID') : 'Id'];
  const markerField = xero ? 'Reference' : 'PrivateNote';
  const contact = xero
    ? (payment ? record?.Invoice?.Contact?.ContactID : record?.Contact?.ContactID)
    : record?.CustomerRef?.value;
  const currency = xero
    ? (payment ? record?.Invoice?.CurrencyCode : record?.CurrencyCode)
    : record?.CurrencyRef?.value;
  const amount = xero ? record?.[payment ? 'Amount' : 'Total'] : record?.TotalAmt;
  // QBO adds SubTotalLineDetail rows to invoice responses. They are display
  // summaries, not additional accepted financial lines. Ignore only those rows:
  // unexpected discounts, groups or other financial line types must still fail
  // the exact count/order/item/tax/amount comparison below.
  const actualFields = !xero && !payment && Array.isArray(e.expected.fields.Line)
    && e.expected.fields.Line.every(line => line.DetailType === 'SalesItemLineDetail')
    ? { ...record, Line: Array.isArray(record?.Line)
      ? record.Line.filter(line => line?.DetailType !== 'SubTotalLineDetail') : record?.Line }
    : record;
  if (!nonempty(id) || !String(record?.[markerField] || '').split('\n').includes(e.marker)
      || contact !== e.expected.contactId || currency !== e.expected.currency
      || minor(amount) !== e.expected.totalMinor || !subset(actualFields, e.expected.fields)
      || record?.HasErrors || record?.ValidationErrors?.length
      || ['VOIDED', 'DELETED'].includes(record?.Status)) {
    fail('PROVIDER_RESULT_MISMATCH', { permanent: true });
  }
  if (xero && !payment && record.Type !== 'ACCREC') fail('WRONG_INVOICE_TYPE', { permanent: true });
  if (payment) {
    if (e.expected.date) {
      const raw = xero ? record.Date : record.TxnDate;
      const match = typeof raw === 'string' && raw.match(/^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/);
      const date = match ? new Date(Number(match[1])).toISOString().slice(0, 10) : String(raw || '').slice(0, 10);
      if (date !== e.expected.date) fail('PAYMENT_DATE_MISMATCH', { permanent: true });
    }
    const invoiceId = row.invoice_result?.id;
    if (invoiceId !== e.expected.invoiceId) fail('PAYMENT_INVOICE_MISMATCH', { permanent: true });
    if (xero) {
      if (record.Invoice?.InvoiceID !== invoiceId || record.Account?.AccountID !== e.expected.accountId
          || record.Status !== 'AUTHORISED') fail('PAYMENT_BINDING_MISMATCH', { permanent: true });
    } else {
      const lines = record.Line || [];
      if (record.DepositToAccountRef?.value !== e.expected.accountId || minor(record.UnappliedAmt) !== 0
          || lines.length !== 1 || minor(lines[0].Amount) !== e.expected.totalMinor
          || lines[0].LinkedTxn?.length !== 1 || lines[0].LinkedTxn[0].TxnId !== invoiceId
          || lines[0].LinkedTxn[0].TxnType !== 'Invoice') fail('PAYMENT_BINDING_MISMATCH', { permanent: true });
    }
  }
  return { id, provider: row.provider, ...(payment ? { paymentId: id, payment_recorded: true } : {
    invoiceId: id, invoice_id: id, invoiceNumber: record.InvoiceNumber || record.DocNumber || null,
    invoice_number: record.InvoiceNumber || record.DocNumber || null,
  }) };
}

/**
 * resolveConnection(row, transport) must return a freshly resolved binding:
 * {tenantId,provider,connectionId,companyId,environment,accessToken}.
 * It must verify active-provider selection and use transport for token refresh.
 * beforeRequest(row,{kind,method}) is mandatory and checks the live lease,
 * source-specific authority and budget immediately before EVERY provider call.
 * The factory never retries internally. A received provider 429 permits the
 * queue to retry the identical frozen operation/key after the shared cooldown.
 */
export function createAccountingRequestProviders({
  resolveConnection, beforeRequest, fetchImpl = globalThis.fetch,
  timeoutMs = 15000, maxPages = 10, maxResponseBytes = 2 * 1024 * 1024, deadlineAt = Infinity,
} = {}) {
  if (typeof resolveConnection !== 'function' || typeof beforeRequest !== 'function'
      || typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50
      || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
      || (deadlineAt !== Infinity && !Number.isFinite(deadlineAt))) throw new Error('Invalid accounting adapter dependencies');

  async function boundedFetch(url, init, budget = {}) {
    const requestTimeoutMs = Math.min(timeoutMs, budget?.timeoutMs ?? Infinity,
      (budget?.deadlineAt ?? Infinity) - Date.now(), deadlineAt - Date.now());
    if (requestTimeoutMs <= 0) fail('REQUEST_BUDGET_EXHAUSTED', { retry: true, definitelyNotWritten: true });
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
          const reader = response.body?.getReader();
          let text = '';
          if (reader) {
            const decoder = new TextDecoder();
            let bytes = 0;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > maxResponseBytes) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
          } else {
            text = await response.text();
            if (Buffer.byteLength(text) > maxResponseBytes) fail('RESPONSE_TOO_LARGE');
          }
          // Return a buffered Response so timeout covers consuming the body too.
          return new Response(text || null, { status: response.status, headers: response.headers });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new AccountingRequestProviderError('TIMEOUT'));
        }, requestTimeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof AccountingRequestProviderError) throw error;
      fail('TRANSPORT_FAILURE'); // Never leak request URLs, tokens or raw provider text.
    } finally { clearTimeout(timer); }
  }

  async function binding(row) {
    if (!['xero', 'quickbooks'].includes(row?.provider)
        || !['tenant_id', 'connection_id', 'company_id'].every(key => nonempty(row[key]))
        || row.company_id === 'PENDING_SELECTION') permanent('INVALID_BINDING');
    await beforeRequest(row, { kind: 'binding', method: 'GET' });
    const connection = await resolveConnection(row, { fetch: async (url, init) => {
      const budget = await beforeRequest(row, { kind: 'authentication', method: init?.method || 'GET' });
      return boundedFetch(url, init, budget);
    }, timeoutMs });
    if (connection?.tenantId !== row.tenant_id || connection?.provider !== row.provider
        || connection?.connectionId !== row.connection_id || connection?.companyId !== row.company_id
        || !nonempty(connection.accessToken)) permanent('CONNECTION_CHANGED');
    const snapshot = row.resolved_snapshot || row.snapshot;
    const environment = snapshot?.invoice?.envelope?.environment || snapshot?.payment?.envelope?.environment
      || row.snapshot?.environment;
    if (row.provider === 'quickbooks' && connection.environment !== environment) permanent('ENVIRONMENT_CHANGED');
    return connection;
  }

  async function request(row, kind, method, path, body, e) {
    const c = await binding(row);
    const budget = await beforeRequest(row, { kind, method });
    const xero = row.provider === 'xero';
    const base = xero ? 'https://api.xero.com/api.xro/2.0'
      : `https://${c.environment === 'sandbox' ? 'sandbox-' : ''}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(c.companyId)}`;
    const headers = { Authorization: `Bearer ${c.accessToken}`, Accept: 'application/json' };
    if (xero) headers['Xero-tenant-id'] = c.companyId;
    if (body) headers['Content-Type'] = 'application/json';
    if (method === 'POST') {
      const identity = accountingOperationIdentity(e.operationKey, kind === 'invoice' ? 'inv' : 'pay', xero ? 128 : 50);
      if (xero) headers['Idempotency-Key'] = identity;
      else path += `${path.includes('?') ? '&' : '?'}requestid=${encodeURIComponent(identity)}`;
    }
    if (!xero) path += `${path.includes('?') ? '&' : '?'}minorversion=75`;
    // Xero otherwise rounds unit prices to two decimal places on both writes
    // and reads, which can change or falsely reject accepted sales economics.
    if (xero && kind === 'invoice') path += `${path.includes('?') ? '&' : '?'}unitdp=4`;
    const response = await boundedFetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }, budget);
    const retryAfter = response.headers.get('retry-after')
      || (response.status === 429 && !xero ? '60' : null);
    // Provider-documented throttle rejection, not a transport timeout:
    // Xero applies rate limits BEFORE idempotency/processing:
    // https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/#limitations
    // Intuit instructs retrying 429 with the SAME requestId:
    // https://help.developer.intuit.com/s/question/0D5TR00000RKcOS0A1/api-returning-429-error
    // This only certifies this POST attempt. create() explicitly removes this
    // flag if a later readback fails after a successful POST. Unknown historical
    // writes never reach this path: they remain discovery-only.
    if (response.status === 429) fail('RATE_LIMITED', {
      status: 429, retryAfter, definitelyNotWritten: method === 'POST', ambiguous: false,
    });
    let data;
    try { data = await response.json(); } catch { fail('INVALID_RESPONSE', { status: response.status }); }
    // Intuit documents Fault on HTTP 200, and code 600 means duplicate request,
    // NOT proof of a replayed invoice. Never infer success from HTTP alone.
    const providerCodes = (data?.Fault?.Error || []).map(error => String(error.code)).filter(code => /^\d+$/.test(code));
    if (!response.ok || data?.Fault || data?.ErrorNumber || data?.Elements?.some(item => item.HasErrors)) {
      fail(providerCodes.includes('600') ? 'DUPLICATE_REQUEST' : 'PROVIDER_REJECTED', {
        status: response.status, retryAfter, providerCodes, ambiguous: method === 'POST',
      });
    }
    return data;
  }

  async function read(row, kind, id) {
    const xero = row.provider === 'xero';
    const entity = kind === 'invoice' ? 'Invoice' : 'Payment';
    const data = await request(row, kind, 'GET', `/${xero ? `${entity}s` : entity.toLowerCase()}/${encodeURIComponent(id)}`);
    const record = xero ? data?.[`${entity}s`]?.[0] : data?.[entity];
    if (record?.[xero ? `${entity}ID` : 'Id'] !== id) fail('READBACK_ID_MISMATCH', { permanent: true });
    return { record, result: validateAccountingRequestResult(row, kind, record) };
  }

  async function create(row, kind) {
    const e = envelope(row, kind), xero = row.provider === 'xero';
    if (row[`${kind}_status`] === 'unknown' || row[`${kind}_result`]?.id) permanent('RECREATION_FORBIDDEN');
    if (kind === 'payment' && row.invoice_result?.id !== e.expected.invoiceId) permanent('PAYMENT_INVOICE_MISMATCH');
    if (kind === 'payment' && row.source_type === 'gocardless_payment') {
      const data = await request(row, 'invoice', 'GET',
        `/${xero ? 'Invoices' : 'invoice'}/${encodeURIComponent(e.expected.invoiceId)}`);
      const invoice = xero ? data?.Invoices?.[0] : data?.Invoice;
      const remaining = minor(xero ? invoice?.AmountDue : invoice?.Balance);
      if (invoice?.[xero ? 'InvoiceID' : 'Id'] !== e.expected.invoiceId
        || (xero ? invoice?.Contact?.ContactID : invoice?.CustomerRef?.value) !== e.expected.contactId
        || (xero ? invoice?.CurrencyCode : invoice?.CurrencyRef?.value) !== e.expected.currency
        || (xero && (invoice?.Type !== 'ACCREC' || invoice?.Status !== 'AUTHORISED'))
        || !Number.isSafeInteger(remaining) || remaining < e.expected.totalMinor) permanent('PAYMENT_INVOICE_REMAINING_MISMATCH');
    }
    const entity = kind === 'invoice' ? 'Invoice' : 'Payment';
    const data = await request(row, kind, 'POST', `/${xero ? `${entity}s` : entity.toLowerCase()}`,
      xero ? { [`${entity}s`]: [e.payload] } : e.payload, e);
    const id = (xero ? data?.[`${entity}s`]?.[0] : data?.[entity])?.[xero ? `${entity}ID` : 'Id'];
    if (!nonempty(id)) fail('MISSING_RESULT_ID');
    try {
      return (await read(row, kind, id)).result;
    } catch (error) {
      // A readback/lease/binding failure after POST cannot certify that the
      // invoice was not written. Preserve cooldown metadata, never safe-retry.
      error.definitelyNotWritten = false;
      error.ambiguous = true;
      throw error;
    }
  }

  async function discover(row, kind) {
    const e = envelope(row, kind), xero = row.provider === 'xero';
    const entity = kind === 'invoice' ? 'Invoice' : 'Payment';
    const candidates = new Set();
    let exhausted = false;
    for (let page = 1; page <= maxPages; page++) {
      let path;
      if (xero) {
        const where = `Reference==${JSON.stringify(e.payload.Reference)}`;
        path = `/${entity}s?where=${encodeURIComponent(where)}&page=${page}&pageSize=100`;
      } else {
        const contact = e.expected.contactId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const query = `SELECT * FROM ${entity} WHERE CustomerRef = '${contact}' STARTPOSITION ${(page - 1) * 100 + 1} MAXRESULTS 100`;
        path = `/query?query=${encodeURIComponent(query)}`;
      }
      const data = await request(row, kind, 'GET', path);
      const records = xero ? data?.[`${entity}s`] : data?.QueryResponse?.[entity] || [];
      if (!Array.isArray(records)) fail('INVALID_DISCOVERY_RESPONSE');
      for (const record of records) {
        if (String(record?.[xero ? 'Reference' : 'PrivateNote'] || '').split('\n').includes(e.marker)) {
          const id = record[xero ? `${entity}ID` : 'Id'];
          if (!nonempty(id)) fail('INVALID_DISCOVERY_ID');
          candidates.add(id);
        }
      }
      if (candidates.size > 1) return { outcome: 'ambiguous' };
      if (records.length < 100) { exhausted = true; break; }
    }
    // An incomplete scan cannot prove uniqueness, even with one candidate.
    if (!exhausted) return { outcome: 'incomplete' };
    if (!candidates.size) return { outcome: 'missing' };
    return { outcome: 'found', result: (await read(row, kind, [...candidates][0])).result };
  }

  return Object.freeze({
    // Preparation has no authority to create invoices/payments. Every read and
    // contact write remains connection-bound and fenced on the ORIGINAL row.
    preparationTransport: row => ({
      resolveConnection: () => binding(row),
      fetch: async (url, init = {}) => {
        const c = await binding(row);
        const parsed = new URL(url);
        const xero = row.provider === 'xero';
        const base = xero ? 'https://api.xero.com/api.xro/2.0/'
          : `https://${c.environment === 'sandbox' ? 'sandbox-' : ''}quickbooks.api.intuit.com/v3/company/${encodeURIComponent(c.companyId)}/`;
        const method = (init.method || 'GET').toUpperCase();
        if (!parsed.href.startsWith(base) || !['GET', 'POST', 'PUT'].includes(method)
          || (method !== 'GET' && !(xero ? /\/Contacts\/?$/.test(parsed.pathname)
            : /\/customer\/?$/.test(parsed.pathname)))) permanent('PREPARATION_ENDPOINT_FORBIDDEN');
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${c.accessToken}`);
        if (xero) headers.set('Xero-tenant-id', c.companyId);
        const budget = await beforeRequest(row, { kind: 'preparation', method });
        const response = await boundedFetch(parsed.href, { ...init, method, headers }, budget);
        if (response.status === 429) fail('RATE_LIMITED', { status: 429,
          retryAfter: response.headers.get('retry-after') || (!xero ? '60' : null),
          definitelyNotWritten: true });
        return response;
      }, timeoutMs, deadlineAt,
    }),
    readExistingInvoice: async (row, id) => {
      if (!nonempty(id)) permanent('INVALID_EXISTING_INVOICE_ID');
      const xero = row.provider === 'xero';
      const data = await request(row, 'invoice', 'GET', `/${xero ? 'Invoices' : 'invoice'}/${encodeURIComponent(id)}`);
      const record = xero ? data?.Invoices?.[0] : data?.Invoice;
      if (record?.[xero ? 'InvoiceID' : 'Id'] !== id) permanent('READBACK_ID_MISMATCH');
      return record;
    },
    assertBinding: async row => {
      await binding(row);
      return { provider: row.provider, connectionId: row.connection_id, companyId: row.company_id };
    },
    createInvoice: row => create(row, 'invoice'),
    createPayment: row => create(row, 'payment'),
    discoverInvoice: row => discover(row, 'invoice'),
    discoverPayment: row => discover(row, 'payment'),
    readInvoice: (row, id) => read(row, 'invoice', id),
    readPayment: (row, id) => read(row, 'payment', id),
  });
}