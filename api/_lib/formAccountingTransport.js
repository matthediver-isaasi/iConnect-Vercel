// Transport bounds used only by the paid form-membership accounting path.
// Do not use Promise.race for an accounting write: losing that race leaves the
// write live and makes a second worker able to repeat an ambiguous operation.

export const FORM_ACCOUNTING_TRANSPORT_TIMEOUT_MS = 10_000;
export const MIN_FORM_ACCOUNTING_TRANSPORT_TIMEOUT_MS = 25;

export function formAccountingTransport(options = {}) {
  const requested = Number(options.timeoutMs ?? options.transportTimeoutMs);
  const timeoutMs = Number.isFinite(requested)
    ? Math.max(
      MIN_FORM_ACCOUNTING_TRANSPORT_TIMEOUT_MS,
      Math.min(FORM_ACCOUNTING_TRANSPORT_TIMEOUT_MS, Math.floor(requested)),
    )
    : FORM_ACCOUNTING_TRANSPORT_TIMEOUT_MS;
  return {
    timeoutMs,
    deadlineAt: options.deadlineAt ?? null,
    signal: options.signal || null,
    fetch: options.fetch || null,
  };
}

function effectiveTimeoutMs(transport) {
  let timeoutMs = transport.timeoutMs;
  if (transport.deadlineAt != null) {
    const remaining = Number(transport.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      const error = new Error('Form accounting deadline expired before provider transport started');
      error.code = 'ACCOUNTING_TRANSPORT_TIMEOUT';
      throw error;
    }
    timeoutMs = Math.min(timeoutMs, Math.max(1, Math.floor(remaining)));
  }
  return timeoutMs;
}

/**
 * Run one provider HTTP request under a real abortable transport timeout.
 * The timeout is deliberately per request. Callers may additionally pass the
 * paid-completion deadline, which caps each later request by its remaining
 * budget. A timeout after a provider write remains ambiguous and is therefore
 * surfaced to the existing read-after-write/discovery reconciliation paths.
 */
export async function fetchFormAccountingTransport(fetchImpl, url, init = {}, transportOptions = {}) {
  const transport = formAccountingTransport(transportOptions);
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs(transport));
  const signal = transport.signal
    ? AbortSignal.any([transport.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (cause) {
    if (timeoutSignal.aborted) {
      const error = new Error('Form accounting provider transport timed out');
      error.code = 'ACCOUNTING_TRANSPORT_TIMEOUT';
      error.cause = cause;
      throw error;
    }
    throw cause;
  }
}