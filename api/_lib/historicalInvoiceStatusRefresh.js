import { getValidXeroAccessToken } from './xero.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error = (message, rateLimited = false) => Object.assign(new Error(message), { rateLimited });
export const HISTORICAL_STATUS_RUN_LIMIT = 1000;
export const HISTORICAL_STATUS_BATCH_SIZE = 99;
const MAX_BATCHES = 12;

function invoiceDate(value) {
  if (typeof value !== 'string') return null;
  const xero = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
  if (xero) return new Date(Number(xero[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? value.slice(0, 10) : null;
}

// Exact signed minor units; never use the PDF resolver's absolute-value credit matching.
function minor(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.00001 ? rounded : null;
}

export function verifyHistoricalInvoice(row, invoice) {
  if (row.record_kind !== 'invoice' || (row.xero_document_type && row.xero_document_type !== 'Invoices')) {
    throw error('Unsupported historical document type');
  }
  if (!invoice || !UUID.test(invoice.InvoiceID || '') || invoice.Type !== 'ACCREC' ||
      invoice.InvoiceNumber !== row.invoice_number ||
      (row.xero_document_id && invoice.InvoiceID.toLowerCase() !== row.xero_document_id.toLowerCase()) ||
      invoiceDate(invoice.DateString || invoice.Date) !== row.invoice_date ||
      !Number.isSafeInteger(Number(row.amount_minor)) ||
      minor(invoice.Total) !== Number(row.amount_minor) ||
      (row.currency && invoice.CurrencyCode !== row.currency)) {
    throw error('Historical invoice identity mismatch; administrator review required');
  }
  const due = minor(invoice.AmountDue);
  const paid = minor(invoice.AmountPaid);
  const credited = minor(invoice.AmountCredited ?? 0);
  if (!['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'].includes(invoice.Status) ||
      due === null || paid === null || credited === null || due < 0 || paid < 0 || credited < 0 ||
      (invoice.Status === 'PAID' && due !== 0) ||
      (['AUTHORISED', 'PAID'].includes(invoice.Status) && due + paid + credited !== minor(invoice.Total))) {
    throw error('Unsupported or inconsistent Xero payment status');
  }
  const paymentStatus = ['VOIDED', 'DELETED'].includes(invoice.Status) ? 'voided'
    : invoice.Status === 'PAID' ? 'paid' : paid > 0 || credited > 0 ? 'partial' : 'unpaid';
  return { xero_document_id: invoice.InvoiceID, xero_document_type: 'Invoices',
    accounting_status: invoice.Status, accounting_payment_status: paymentStatus };
}

function validateBinding(row) {
  if (row.record_kind !== 'invoice' || (row.xero_document_type && row.xero_document_type !== 'Invoices')) {
    throw error('Unsupported historical document type');
  }
  if (!row.xero_company_id || (!!row.xero_document_id !== !!row.xero_document_type) ||
      (row.xero_document_id && !UUID.test(row.xero_document_id)) ||
      (!row.xero_document_id && (typeof row.invoice_number !== 'string' ||
        !row.invoice_number.length || row.invoice_number.length > 255 || /[,\r\n]/.test(row.invoice_number)))) {
    throw error('Invalid historical provider binding');
  }
}

// Xero's public OpenAPI GET /Invoices specifies IDs and InvoiceNumbers CSV
// filters, page and pageSize (verified against XeroAPI/Xero-OpenAPI). Use 99
// identities with pageSize=100 so a full/truncated response is never mistaken
// for a complete unique lookup on servers omitting pagination metadata.
export async function observeHistoricalInvoiceBatch(rows, dependencies = {}) {
  if (!rows.length || rows.length > HISTORICAL_STATUS_BATCH_SIZE) throw error('Invalid historical provider batch size');
  const row = rows[0];
  rows.forEach(validateBinding);
  if (rows.some(candidate => candidate.tenant_id !== row.tenant_id ||
      candidate.xero_company_id !== row.xero_company_id ||
      Boolean(candidate.xero_document_id) !== Boolean(row.xero_document_id))) {
    throw error('Mixed historical provider batch binding');
  }
  const key = JSON.stringify([row.tenant_id, row.xero_company_id]);
  let token = dependencies.tokenCache?.get(key);
  if (!token) {
    token = await (dependencies.getToken || getValidXeroAccessToken)(
      row.tenant_id, { timeoutMs: 4000, deadlineAt: dependencies.deadlineAt, fetch: dependencies.fetch },
    );
    dependencies.tokenCache?.set(key, token);
  }
  const { accessToken, tenantId } = token;
  if (tenantId !== row.xero_company_id) throw error('Connected Xero organisation differs from historical import');
  const field = row.xero_document_id ? 'IDs' : 'InvoiceNumbers';
  const params = new URLSearchParams({
    [field]: [...new Set(rows.map(candidate => candidate.xero_document_id || candidate.invoice_number))].join(','),
    where: 'Type=="ACCREC"', page: '1', pageSize: '100',
  });
  const response = await (dependencies.fetch || fetch)(`https://api.xero.com/api.xro/2.0/Invoices?${params}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, Accept: 'application/json' },
    signal: AbortSignal.timeout(dependencies.deadlineAt == null ? 4000
      : Math.max(1, Math.min(4000, Math.floor(dependencies.deadlineAt - Date.now())))),
  });
  if (response.status === 429) throw error('Xero rate limited; refresh deferred', true);
  if (!response.ok) throw error(`Xero historical status read failed (${response.status})`);
  const { Invoices, pagination } = await response.json();
  if (!Array.isArray(Invoices) || Invoices.length >= 100 ||
      (pagination && (Number(pagination.pageCount) > 1 || Number(pagination.itemCount) !== Invoices.length))) {
    throw error('Historical invoice response incomplete or ambiguous');
  }
  return rows.map(candidate => {
    const documents = Invoices.filter(doc => candidate.xero_document_id
      ? String(doc.InvoiceID).toLowerCase() === candidate.xero_document_id.toLowerCase()
      : doc.InvoiceNumber === candidate.invoice_number);
    try {
      if (documents.length !== 1) throw error('Historical invoice missing or ambiguous in Xero');
      return { row: candidate, patch: verifyHistoricalInvoice(candidate, documents[0]) };
    } catch (err) {
      return { row: candidate, error: err };
    }
  });
}

export async function observeHistoricalInvoice(row, dependencies = {}) {
  const [result] = await observeHistoricalInvoiceBatch([row], dependencies);
  if (result.error) throw result.error;
  return result.patch;
}

function expectedIdentity(row) {
  return Object.fromEntries(['id', 'tenant_id', 'xero_company_id', 'invoice_number', 'invoice_date',
    'amount_minor', 'currency', 'xero_document_id', 'xero_document_type', 'accounting_status_next_check_at']
    .map(field => [field, row[field] ?? null]));
}

export function historicalStatusBatches(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.tenant_id, row.xero_company_id, Boolean(row.xero_document_id)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const tenantQueues = new Map();
  for (const group of groups.values()) {
    const tenant = group[0].tenant_id;
    if (!tenantQueues.has(tenant)) tenantQueues.set(tenant, []);
    let chunk = [];
    let bytes = 0;
    for (const row of group) {
      const size = encodeURIComponent(row.xero_document_id || row.invoice_number || '').length + 3;
      if (chunk.length && (chunk.length >= HISTORICAL_STATUS_BATCH_SIZE || bytes + size > 5500)) {
        tenantQueues.get(tenant).push(chunk); chunk = []; bytes = 0;
      }
      chunk.push(row); bytes += size;
    }
    if (chunk.length) tenantQueues.get(tenant).push(chunk);
  }
  const batches = [];
  while ([...tenantQueues.values()].some(queue => queue.length)) {
    for (const queue of tenantQueues.values()) if (queue.length) batches.push(queue.shift());
  }
  return batches;
}

function boundedRpc(db, name, args, timeoutMs) {
  const request = db.rpc(name, args);
  return typeof request.abortSignal === 'function'
    ? request.abortSignal(AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))) : request;
}

// Intentionally does not import any reconciliation, membership, payment, workflow
// or email code. Only this archive table can be mutated.
export async function refreshHistoricalInvoiceStatuses(db, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  const summary = { checked: 0, refreshed: 0, errors: 0, deferred: 0, conflicts: 0 };
  const { data: rows, error: claimError } = await boundedRpc(db,
    'claim_historical_invoice_status_refresh', { p_limit: HISTORICAL_STATUS_RUN_LIMIT }, 4000);
  if (claimError) throw new Error(`Historical status queue unavailable: ${claimError.message}`);
  const lastCall = new Map();
  const blocked = new Set();
  const tokenCache = new Map();
  let attempts = 0;
  for (const batch of historicalStatusBatches(rows || [])) {
    const tenantId = batch[0].tenant_id;
    // Reserve two transports (OAuth + GET) at 4s each and leave the legacy
    // operational cron ~32s of its original 50s window.
    const tokenKey = JSON.stringify([tenantId, batch[0].xero_company_id]);
    const latestStart = tokenCache.has(tokenKey) ? 14000 : 10000;
    if (now() - started > latestStart || attempts >= MAX_BATCHES || blocked.has(tenantId)) {
      summary.deferred += batch.length; continue;
    }
    const wait = (lastCall.get(tenantId) ?? -Infinity) + 1200 - now();
    if (wait > 0) await sleep(wait);
    if (now() - started > latestStart) { summary.deferred += batch.length; continue; }
    lastCall.set(tenantId, now());
    attempts++;
    const invalid = [];
    const valid = [];
    for (const row of batch) {
      try { validateBinding(row); valid.push(row); }
      catch (err) { invalid.push({ row, error: err }); }
    }
    let observations = invalid;
    try {
      if (valid.length) observations = [...invalid,
        ...await observeHistoricalInvoiceBatch(valid, { ...dependencies, tokenCache,
          deadlineAt: Date.now() + Math.max(1, 17500 - (now() - started)),
        })];
    } catch (err) {
      if (err.rateLimited) blocked.add(tenantId);
      observations = [...invalid, ...valid.map(row => ({ row, error: err }))];
    }
    summary.checked += batch.length;
    const updates = observations.map(({ row, patch, error: err }) => {
      if (err) {
        summary.errors++;
        const failures = Math.min((row.accounting_status_failures || 0) + 1, 10);
        return { expected: expectedIdentity(row), patch: {
          accounting_status_error: String(err.message || 'Historical status refresh failed').slice(0, 500),
          accounting_status_failures: failures,
          accounting_status_next_check_at: new Date(now() + Math.min(24, 2 ** failures) * 3600000).toISOString(),
        } };
      }
      return { expected: expectedIdentity(row), patch: { ...patch,
        accounting_status_checked_at: new Date(now()).toISOString(),
        // Reserve 3h slack for the 3-hour cron: settled rows become sweep-due
        // after 21h. Active rows can use spare capacity at 3h, but SQL puts
        // unverified/21h-old observations first so hot retries cannot starve
        // the full sweep. 1000 * 8 ticks/day covers 7086 normal identities.
        accounting_status_next_check_at: new Date(now() +
          (['paid', 'voided'].includes(patch.accounting_payment_status) ? 21 : 3) * 3600000).toISOString(),
        accounting_status_error: null, accounting_status_failures: 0,
      } };
    });
    const { data: affected, error: writeError } = await boundedRpc(db,
      'apply_historical_invoice_status_batch', { p_updates: updates }, Math.min(2000, 18000 - (now() - started)));
    if (writeError) throw new Error(`Historical status metadata update failed: ${writeError.message}`);
    if (!Number.isInteger(affected) || affected < 0 || affected > updates.length) {
      throw new Error('Historical status metadata update returned an invalid affected-row count');
    }
    const conflicts = updates.length - Number(affected);
    summary.conflicts += conflicts;
    summary.refreshed += Math.max(0, updates.filter(update => !update.patch.accounting_status_error).length - conflicts);
  }
  return summary;
}
