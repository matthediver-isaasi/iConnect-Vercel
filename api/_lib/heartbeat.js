export const HEARTBEAT_ENV_VARS = Object.freeze({
  membershipRenewals: 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_RENEWALS_URL',
  membershipPaymentReconciliation: 'BETTERSTACK_HEARTBEAT_MEMBERSHIP_PAYMENT_RECONCILIATION_URL',
  gocardlessReconciliation: 'BETTERSTACK_HEARTBEAT_GOCARDLESS_RECONCILIATION_URL',
  stripeCardPlanReconciliation: 'BETTERSTACK_HEARTBEAT_STRIPE_CARD_PLAN_RECONCILIATION_URL',
  scheduledWorkflows: 'BETTERSTACK_HEARTBEAT_SCHEDULED_WORKFLOWS_URL',
  scheduledCampaigns: 'BETTERSTACK_HEARTBEAT_SCHEDULED_CAMPAIGNS_URL',
  databaseBackup: 'BETTERSTACK_HEARTBEAT_DATABASE_BACKUP_URL',
  storageBackup: 'BETTERSTACK_HEARTBEAT_STORAGE_BACKUP_URL',
  formPaymentReconciliation: 'BETTERSTACK_HEARTBEAT_FORM_PAYMENT_RECONCILIATION_URL',
  automaticMembershipProcessing: 'BETTERSTACK_HEARTBEAT_AUTOMATIC_MEMBERSHIP_PROCESSING_URL',
});

/**
 * The ten independently monitored production schedules. Keep this list
 * intentionally explicit: the remaining Vercel crons are not individually
 * monitored under the current Better Stack plan.
 */
export const HEARTBEAT_MONITOR_REGISTRY = Object.freeze([
  Object.freeze({ key: 'membershipRenewals', envVar: HEARTBEAT_ENV_VARS.membershipRenewals, path: '/api/cron/process-membership-renewals' }),
  Object.freeze({ key: 'membershipPaymentReconciliation', envVar: HEARTBEAT_ENV_VARS.membershipPaymentReconciliation, path: '/api/cron/reconcile-membership-invoice-payments' }),
  Object.freeze({ key: 'gocardlessReconciliation', envVar: HEARTBEAT_ENV_VARS.gocardlessReconciliation, path: '/api/cron/reconcile-gocardless' }),
  Object.freeze({ key: 'stripeCardPlanReconciliation', envVar: HEARTBEAT_ENV_VARS.stripeCardPlanReconciliation, path: '/api/cron/reconcile-stripe-card-plans' }),
  Object.freeze({ key: 'scheduledWorkflows', envVar: HEARTBEAT_ENV_VARS.scheduledWorkflows, path: '/api/cron/run-scheduled-workflows' }),
  Object.freeze({ key: 'scheduledCampaigns', envVar: HEARTBEAT_ENV_VARS.scheduledCampaigns, path: '/api/email-campaigns/process-scheduled' }),
  Object.freeze({ key: 'databaseBackup', envVar: HEARTBEAT_ENV_VARS.databaseBackup, path: '/api/cron/backup-database-to-r2' }),
  Object.freeze({ key: 'storageBackup', envVar: HEARTBEAT_ENV_VARS.storageBackup, path: '/api/cron/backup-storage-to-r2' }),
  Object.freeze({ key: 'formPaymentReconciliation', envVar: HEARTBEAT_ENV_VARS.formPaymentReconciliation, path: '/api/cron/reconcile-form-payments' }),
  Object.freeze({ key: 'automaticMembershipProcessing', envVar: HEARTBEAT_ENV_VARS.automaticMembershipProcessing, path: '/api/cron/process-automatic-memberships' }),
]);

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