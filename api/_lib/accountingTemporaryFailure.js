// Only transport/provider availability failures are exempt. Ambiguous invoices,
// identity mismatches and validation rejections retain their existing guards.
export function isTemporaryAccountingFailure(error) {
  const status = Number(error?.statusCode || error?.status || error?.response?.status);
  if (status) return status === 408 || status === 429 || status >= 500 && status <= 599;
  return ['ACCOUNTING_TRANSPORT_TIMEOUT', 'FORM_ACCOUNTING_DEADLINE_EXPIRED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
    'ECONNREFUSED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']
    .includes(error?.code || error?.cause?.code)
    || ['TimeoutError', 'AbortError'].includes(error?.name)
    || error instanceof TypeError && error.message === 'fetch failed';
}
