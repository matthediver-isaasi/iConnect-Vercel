import crypto from 'node:crypto';

// A conservative credential-set identity, not an access token. Rotation requires
// review rather than assuming that a replacement token owns old resources.
export function gocardlessProviderContext(creds) {
  if (!creds?.accessToken) return null;
  return {
    version: 1,
    environment: creds.environment,
    source: creds.source,
    tenant_id: creds.tenantId || null,
    account_fingerprint: crypto.createHash('sha256')
      .update(`gocardless-origin-v1\0${creds.accessToken}`).digest('hex'),
  };
}

export function validateGocardlessProviderContext(origin, current, agreement = null) {
  if (agreement?.environment && agreement.environment !== current?.environment) {
    return 'agreement_environment_mismatch';
  }
  if (!origin || origin.version !== 1 || !origin.account_fingerprint) return 'origin_context_unknown';
  if (!current) return 'current_context_unavailable';
  if (origin.environment !== current.environment) return 'origin_environment_mismatch';
  if (origin.source !== current.source || origin.tenant_id !== current.tenant_id
      || origin.account_fingerprint !== current.account_fingerprint) return 'origin_account_mismatch';
  return null;
}

export const GC_FORM_MAX_ATTEMPTS = 5;

export function gocardlessLookupFailure(previous, error, now = Date.now()) {
  const attempts = (Number(previous?.attempts) || 0) + 1;
  const status = Number(error?.status || error?.statusCode) || null;
  const retryable = !status || status === 404 || status === 408 || status === 429 || status >= 500;
  const blocked = !retryable || attempts >= GC_FORM_MAX_ATTEMPTS;
  return {
    status: blocked ? 'blocked' : 'retry',
    reason: status === 404 ? 'provider_resource_not_found' : 'provider_lookup_unavailable',
    attempts,
    http_status: status,
    requires_review: blocked,
    last_checked_at: new Date(now).toISOString(),
    next_attempt_at: blocked ? null : new Date(now + Math.min(24 * 60, 5 * 2 ** (attempts - 1)) * 60_000).toISOString(),
  };
}

// JSON predicates must run before LIMIT: blocked/temporarily deferred rows
// must not monopolize the oldest-first pending sweep.
export function filterGocardlessPendingSelection(query, now = Date.now()) {
  return query
    .or('payment_meta->gc_reconciliation->>status.is.null,payment_meta->gc_reconciliation->>status.neq.blocked')
    .or(`payment_meta->gc_reconciliation->>next_attempt_at.is.null,payment_meta->gc_reconciliation->>next_attempt_at.lte.${new Date(now).toISOString()}`);
}

export async function persistGocardlessReconciliation(db, row, diagnostic) {
  const { error } = await db.rpc('record_form_gocardless_reconciliation', {
    p_tenant_id: row.tenant_id, p_submission_id: row.id, p_diagnostic: diagnostic,
  });
  if (error) throw error;
}

export async function retrieveFormGocardlessBillingRequest({
  db, row, gc, reference, agreement, timeoutMs, refreshWaiting = false,
}) {
  const previous = row.payment_meta?.gc_reconciliation;
  if (previous?.status === 'blocked'
      || (previous?.next_attempt_at && Date.parse(previous.next_attempt_at) > Date.now()
        && !(refreshWaiting && previous.status === 'waiting'))) return null;
  const reason = validateGocardlessProviderContext(
    row.payment_meta?.gc_provider_context, gc.providerContext, agreement,
  );
  if (reason) {
    await persistGocardlessReconciliation(db, row, {
      status: 'blocked', reason, requires_review: true,
      attempts: Number(previous?.attempts) || 0, next_attempt_at: null,
      last_checked_at: new Date().toISOString(),
    });
    return null;
  }
  let result;
  try {
    result = await gc.getBillingRequest(reference, { timeoutMs });
  } catch (error) {
    const diagnostic = gocardlessLookupFailure(previous, error);
    await persistGocardlessReconciliation(db, row, diagnostic);
    // Local response hint only, after durable persistence. The RPC remains
    // authoritative and cannot clear a concurrent blocked decision.
    row.payment_meta = { ...row.payment_meta, gc_reconciliation: diagnostic };
    return null;
  }
  // A diagnostic outage must not hide a provider-confirmed paid/terminal result.
  // The caller owns the authoritative payment transition and its own retries.
  if (['fulfilled', 'failed', 'cancelled'].includes(result?.status)) return result;
  await persistGocardlessReconciliation(db, row, {
    status: 'waiting', reason: 'provider_lookup_succeeded', attempts: 0,
    requires_review: false, last_checked_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  return result;
}