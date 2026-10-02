import { useEffect } from 'react';
import { normalizeSessionRoleSnapshot } from './memberSessionRole';
import {
  isViewerSessionRevalidationDue,
  VIEWER_SESSION_REVALIDATE_MS,
} from './viewerSessionPreload';

export const VIEWER_SESSION_RETENTION_MS = 10_000;
export const VIEWER_SESSION_ATTEMPT_MS = 2_500;
export const VIEWER_SESSION_RECOVERY_COOLDOWN_MS = 5_000;
export const VIEWER_SESSION_RETRY_DELAYS = [500, 1_000];

export function viewerSessionCanRecover() {
  return document.visibilityState !== 'hidden' && window.navigator.onLine !== false;
}

export function mayStartViewerSessionRecovery({ inFlight, cooldownUntil, now = Date.now(), available = viewerSessionCanRecover() }) {
  return !inFlight && available && now >= cooldownUntil;
}

export function isTransientViewerSessionError(error) {
  return !error?.authoritative && (error?.status === undefined
    || error.status >= 500 || error.status === 408);
}

// Wake the *current* bounded generation, not a fresh check. Events share one
// completion latch and do not move the deadline or consume retry attempts.
export function waitForViewerSessionAvailability({
  deadline, isAvailable, isCurrent, now = Date.now,
}) {
  if (!isCurrent() || now() >= deadline) return Promise.resolve(false);
  if (isAvailable()) return Promise.resolve(true);
  return new Promise(resolve => {
    let finished = false;
    let timeout;
    const finish = available => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      resolve(available);
    };
    const wake = () => {
      if (!isCurrent() || now() >= deadline) finish(false);
      else if (isAvailable()) finish(true);
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    timeout = setTimeout(() => finish(false), Math.max(1, deadline - now()));
    wake();
  });
}

// Each attempt owns a fresh request and an independent response fence. The
// retention deadline is supplied by the caller and is never moved by retries.
export async function recoverViewerSession({
  request, isCurrent, onTransient = () => {}, onDeadline = () => {},
  retentionDeadline, isAvailable = viewerSessionCanRecover,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  waitForAvailability = waitForViewerSessionAvailability,
  attemptMs = VIEWER_SESSION_ATTEMPT_MS,
}) {
  const recoveryDeadline = now() + VIEWER_SESSION_RETENTION_MS;
  const availabilityDeadline = retentionDeadline > now()
    ? Math.min(retentionDeadline, recoveryDeadline) : recoveryDeadline;
  const awaitAvailability = async () => isAvailable() || await waitForAvailability({
    deadline: availabilityDeadline, isAvailable, isCurrent, now,
  });
  let lastError;
  for (let attempt = 0; attempt <= VIEWER_SESSION_RETRY_DELAYS.length; attempt += 1) {
    if (!isCurrent()) return { cancelled: true };
    if (now() >= retentionDeadline) onDeadline();
    if (!await awaitAvailability()) break;
    if (!isCurrent()) return { cancelled: true };
    if (now() >= recoveryDeadline) break;
    if (attempt) {
      await sleep(VIEWER_SESSION_RETRY_DELAYS[attempt - 1]);
      if (!isCurrent()) return { cancelled: true };
      if (now() >= retentionDeadline) onDeadline();
      if (!await awaitAvailability() || now() >= recoveryDeadline) break;
      if (!isCurrent()) return { cancelled: true };
    }
    let timeout;
    let active = true;
    try {
      const value = await Promise.race([
        request(() => active && isCurrent()),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Session validation timed out.')),
            Math.max(1, Math.min(attemptMs, recoveryDeadline - now())));
        }),
      ]);
      if (!isCurrent()) return { cancelled: true };
      if (now() >= retentionDeadline) onDeadline();
      return { value };
    } catch (error) {
      if (!isCurrent()) return { cancelled: true };
      if (!isTransientViewerSessionError(error)) return { error, authoritative: true };
      lastError = error;
      onTransient(error);
    } finally {
      active = false;
      clearTimeout(timeout);
    }
  }
  if (isCurrent() && now() < retentionDeadline) {
    await sleep(retentionDeadline - now());
  }
  if (!isCurrent()) return { cancelled: true };
  onDeadline();
  return { error: lastError || new Error('Session verification paused while offline or hidden.') };
}

export async function resolveRoutineSessionRole(member, getRole, timeoutMs) {
  if (member?.sessionRole !== undefined) {
    const snapshot = normalizeSessionRoleSnapshot(member.sessionRole, member, 'validation');
    if (snapshot?.status === 'error') {
      const error = new Error(snapshot.error);
      // A server-declared role lookup failure is transient; a malformed or
      // foreign permission projection is not safe to retain.
      error.authoritative = snapshot.error === 'The navigation role response was invalid.';
      throw error;
    }
    return member.sessionRole;
  }
  const identity = {
    member_id: member?.id || null,
    tenant_id: member?.tenant_id || null,
    role_id: member?.role_id || null,
  };
  if (!identity.role_id) return { status: 'missing', ...identity };
  if (!(timeoutMs > 0)) throw new Error('Session validation timed out.');

  let timeout;
  try {
    const role = await Promise.race([
      getRole(identity.role_id),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Session validation timed out.')), timeoutMs);
      }),
    ]);
    if (!role) return { status: 'missing', ...identity };
    if (role.id !== identity.role_id
      || (role.tenant_id && role.tenant_id !== identity.tenant_id)) {
      const error = new Error('The navigation role response was invalid.');
      error.authoritative = true;
      throw error;
    }
    return { status: 'ready', ...identity, role };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Schedules one routine check for a validated session epoch. Timer, focus and
 * visibility events share the same latch, so an overdue tab cannot start
 * concurrent generations. A successful check publishes a new validatedAt and
 * therefore arms the next epoch.
 */
export function useViewerSessionRevalidation({
  enabled,
  validatedAt,
  onRevalidate,
}) {
  useEffect(() => {
    if (!enabled || !validatedAt) return undefined;

    let revalidationStarted = false;
    const revalidateIfDue = () => {
      if (revalidationStarted
        || document.visibilityState === 'hidden'
        || !isViewerSessionRevalidationDue(validatedAt)) return;
      revalidationStarted = true;
      onRevalidate();
    };
    const remaining = Math.max(
      0,
      VIEWER_SESSION_REVALIDATE_MS - (Date.now() - validatedAt),
    );
    const timeout = window.setTimeout(revalidateIfDue, remaining);
    window.addEventListener('focus', revalidateIfDue);
    window.addEventListener('online', revalidateIfDue);
    document.addEventListener('visibilitychange', revalidateIfDue);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', revalidateIfDue);
      window.removeEventListener('online', revalidateIfDue);
      document.removeEventListener('visibilitychange', revalidateIfDue);
    };
  }, [enabled, validatedAt, onRevalidate]);
}