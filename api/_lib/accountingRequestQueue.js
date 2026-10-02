// No provider writes are permitted outside a persisted, fenced stage.
export class AccountingRequestQueueError extends Error {
  constructor(code) {
    super(code); this.code = code;
    if (code.endsWith('BUDGET_EXHAUSTED')) this.retry = true;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => object(value) && Object.keys(value).length > 0;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function validAccountingRequestSnapshot(snapshot) {
  try {
    return object(snapshot) && snapshot.version === 1 && nonempty(snapshot.invoice)
      && nonempty(snapshot.linkage) && (snapshot.payment === null || nonempty(snapshot.payment))
      && Buffer.byteLength(JSON.stringify(snapshot)) <= 262144;
  } catch { return false; }
}

export function accountingRetryAfterSeconds(value, now = Date.now()) {
  if (value == null || value === '') return 60;
  const number = Number(value);
  const seconds = Number.isFinite(number) ? number : (Date.parse(value) - now) / 1000;
  // -1 is a fail-closed, indefinite shared embargo when PostgreSQL's integer
  // seconds cannot represent the provider's delay. Never shorten Retry-After.
  if (seconds > 2147483647 || (!Number.isFinite(number) && /^\+?\d+(?:\.\d+)?$/.test(String(value)))) return -1;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
}

async function rpc(db, name, args = {}) {
  if (!db?.rpc) throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_UNAVAILABLE');
  const query = db.rpc(`accounting_request_${name}`, args);
  const { data, error } = await (typeof query.abortSignal === 'function'
    ? query.abortSignal(AbortSignal.timeout(5000)) : query);
  if (error) throw new AccountingRequestQueueError(`ACCOUNTING_QUEUE_PERSISTENCE_${name.toUpperCase()}`);
  return data;
}

export async function enqueueAccountingRequest({
  db, tenantId, provider, connectionId, companyId, sourceType, sourceId, operation = 'invoice', snapshot,
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId || '')
    || !['xero', 'quickbooks'].includes(provider) || !text(connectionId, 200) || connectionId === 'PENDING_SELECTION' || !text(companyId, 200)
    || companyId === 'PENDING_SELECTION' || !text(sourceType, 100) || !text(sourceId, 200)
    || operation !== 'invoice' || !validAccountingRequestSnapshot(snapshot)) {
    throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_INVALID_AUTHORITY');
  }
  return rpc(db, 'enqueue', {
    p_tenant_id: tenantId, p_provider: provider, p_connection_id: connectionId, p_company_id: companyId,
    p_source_type: sourceType, p_source_id: sourceId, p_operation: operation,
    p_snapshot: JSON.parse(JSON.stringify(snapshot)),
  });
}

async function defaultAdapters(row, controls) {
  const { getAccountingQueueAdapter } = await import('./accountingQueueIntegration.js');
  return getAccountingQueueAdapter(row, controls);
}

async function advance({ db, row, adapters, deadlineAt }) {
  let requests = 0;
  const beforeRequest = async (candidate, { kind, method } = {}) => {
    if (Date.now() >= deadlineAt || ++requests > 40) {
      throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_REQUEST_BUDGET_EXHAUSTED');
    }
    for (const key of ['id', 'tenant_id', 'provider', 'connection_id', 'company_id', 'source_type', 'source_id', 'lease_token']) {
      if (candidate?.[key] !== row[key]) throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_BINDING_CHANGED');
    }
    for (const key of ['snapshot', 'invoice_result', 'payment_result']) {
      if (JSON.stringify(candidate?.[key]) !== JSON.stringify(row[key])) {
        throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_AUTHORITY_CHANGED');
      }
    }
    const permitted = await rpc(db, 'guard', { p_id: row.id, p_lease_token: row.lease_token,
      p_stage: ['invoice', 'payment'].includes(kind) && method === 'POST' ? kind : null });
    if (permitted !== true) throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_GUARD_FAILED');
    const timeoutMs = Math.min(30000, deadlineAt - Date.now());
    if (timeoutMs <= 0) throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_REQUEST_BUDGET_EXHAUSTED');
    return { deadlineAt, timeoutMs };
  };
  const checkpoint = async (stage, status, result = null) => {
    row = await rpc(db, 'checkpoint', {
      p_id: row.id, p_lease_token: row.lease_token, p_stage: stage, p_status: status, p_result: result,
    });
  };
  const finish = (state, error = null, retry = 60, cooldown = 0) => rpc(db, 'finish', {
    p_id: row.id, p_lease_token: row.lease_token, p_state: state, p_error: error,
    // Retry scheduling may be earlier than the embargo, but claim always also
    // checks shared cooldown. The embargo itself is NEVER capped.
    p_retry_seconds: Math.max(1, Math.min(604800, retry)), p_cooldown_seconds: cooldown,
  });
  const bindingFailure = error => {
    const cooldown = Number(error?.status ?? error?.statusCode) === 429
      ? accountingRetryAfterSeconds(error.retryAfter) : 0;
    const unknown = row.invoice_status === 'unknown' || row.payment_status === 'unknown';
    const retryable = cooldown !== 0 || error?.retry === true;
    return finish(error?.permanent || !retryable ? 'review' : unknown ? 'unknown' : 'retry',
      'ACCOUNTING_BINDING_OR_ADAPTER_UNAVAILABLE', Math.max(60, cooldown), cooldown);
  };
  let adapter;
  try {
    adapter = await adapters(structuredClone(row), { beforeRequest, deadlineAt });
    if (!adapter?.assertBinding || !adapter?.linkSource || !adapter?.createInvoice
      || (row.snapshot.payment && !adapter.createPayment)) throw new Error('Missing adapter');
    await adapter.assertBinding(structuredClone(row));
  } catch (error) {
    return bindingFailure(error);
  }
  for (const [stage, method, discovery] of [
    ['invoice', 'createInvoice', 'discoverInvoice'],
    ['payment', 'createPayment', 'discoverPayment'],
    ['link', 'linkSource', null],
  ]) {
    const status = row[`${stage}_status`];
    if (status === 'done' || status === 'skipped') continue;
    if (Date.now() >= deadlineAt) {
      const unknown = row.invoice_status === 'unknown' || row.payment_status === 'unknown';
      return finish(unknown ? 'unknown' : 'retry', 'ACCOUNTING_QUEUE_BATCH_BUDGET_EXHAUSTED');
    }
    if (status === 'unknown') {
      // Absence is NOT proof of no write: provider indexing may be delayed.
      let found;
      try { found = await adapter[discovery]?.(structuredClone(row)); } catch (error) {
        const cooldown = Number(error.status ?? error.statusCode) === 429
          ? accountingRetryAfterSeconds(error.retryAfter) : 0;
        return finish('unknown', 'ACCOUNTING_DISCOVERY_UNAVAILABLE', Math.max(300, cooldown), cooldown);
      }
      if (found?.outcome !== 'found' || !text(found.result?.id, 500)) {
        return finish('unknown', 'ACCOUNTING_WRITE_REQUIRES_DISCOVERY', 300);
      }
      await checkpoint(stage, 'done', found.result);
      continue;
    }
    // Each individual write rechecks binding. No mutable snapshot reaches the adapter.
    try { await adapter.assertBinding(structuredClone(row)); } catch (error) {
      return bindingFailure(error);
    }
    await checkpoint(stage, 'writing');
    let result;
    try {
      result = await adapter[method](structuredClone(row));
      if (stage === 'link' ? result?.linked !== true : !text(result?.id, 500)) {
        throw new Error('Provider returned no durable evidence');
      }
    } catch (error) {
      const safe = stage === 'link' || error.definitelyNotWritten === true;
      await checkpoint(stage, safe ? 'pending' : 'unknown');
      const cooldown = Number(error.status ?? error.statusCode) === 429
        ? accountingRetryAfterSeconds(error.retryAfter) : 0;
      const delay = Math.max(cooldown, Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7)));
      return finish(error.permanent ? 'review' : safe ? 'retry' : 'unknown',
        safe ? 'ACCOUNTING_STAGE_NOT_COMPLETED' : 'ACCOUNTING_WRITE_OUTCOME_UNKNOWN', delay, cooldown);
    }
    // Persistence failure after provider success deliberately leaves "writing";
    // an expired worker must discover, never repeat that financial write.
    await checkpoint(stage, 'done', result);
  }
  return finish('complete');
}

export async function processAccountingRequest({ db, requestId, adapters = defaultAdapters, deadlineAt = Date.now() + 45_000 }) {
  if (!requestId) throw new AccountingRequestQueueError('ACCOUNTING_QUEUE_REQUEST_ID_REQUIRED');
  const row = await rpc(db, 'claim', { p_request_id: requestId });
  return row?.id ? advance({ db, row, adapters, deadlineAt: Math.min(deadlineAt, Date.now() + 45_000) }) : null;
}

export async function reconcileAccountingRequests({ db, adapters = defaultAdapters, limit = 10 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid accounting queue batch size');
  const results = [];
  // One deadline for the entire batch, not a fresh per-row allowance. Stop
  // provider work at 40s, reserving 15s for checkpoint + finish and cron response.
  const deadline = Date.now() + 40_000;
  for (let index = 0; index < limit && Date.now() < deadline - 5000; index++) {
    const row = await rpc(db, 'claim');
    if (!row?.id) break;
    const result = await advance({ db, row, adapters, deadlineAt: deadline });
    results.push({ id: result.id, state: result.state });
  }
  return results;
}