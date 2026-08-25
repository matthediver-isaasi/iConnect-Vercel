export const HEARTBEAT_ENV_VARS = Object.freeze({
  membershipRenewals: 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_RENEWALS_URL',
  membershipPaymentReconciliation: 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_PAYMENT_RECONCILIATION_URL',
  gocardlessReconciliation: 'BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL',
  stripeCardPlanReconciliation: 'BETTERSTACK_HEARTBEAT_STRIPE_CARD_PLAN_RECONCILIATION_URL',
  scheduledWorkflows: 'BETTERSTACK_HEARTBEAT_SCHEDULED_WORKFLOWS_URL',
  scheduledCampaigns: 'BETTERSTACK_HEARTBEAT_SCHEDULED_CAMPAIGNS_URL',
});

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 2_000;

function failureUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/fail`;
  return url.toString();
}

function safeFailureReason(error) {
  if (error?.name === 'AbortError') return 'timeout';
  return 'request-failed';
}

function safeWarn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch {
    // Monitoring diagnostics must never change the caller's job outcome.
  }
}

/**
 * Send one best-effort Better Stack heartbeat. A missing URL is a deliberate
 * no-op, and every delivery error is swallowed so monitoring cannot change a
 * job's business outcome.
 */
export async function sendHeartbeat({
  envVar,
  success,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  logger = console,
} = {}) {
  const url = envVar ? env[envVar] : '';
  if (!url || typeof fetchImpl !== 'function') return { sent: false };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), Math.max(1, timeoutMs));
  try {
    const target = success ? url : failureUrl(url);
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { 'User-Agent': 'iConnect-betterstack-heartbeat' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok) {
      safeWarn(logger, `[monitoring] Better Stack heartbeat failed (${envVar}): http-${response?.status || 'unknown'}`);
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    safeWarn(logger, `[monitoring] Better Stack heartbeat failed (${envVar}): ${safeFailureReason(error)}`);
    return { sent: false };
  } finally {
    clearTimeout(timer);
  }
}

export function createHeartbeatReporter({ envVar, ...options } = {}) {
  let reported = false;
  return async (success) => {
    if (reported) return { sent: false, duplicate: true };
    reported = true;
    return sendHeartbeat({ ...options, envVar, success });
  };
}