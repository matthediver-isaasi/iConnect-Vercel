import { useEffect } from 'react';
import {
  isViewerSessionRevalidationDue,
  VIEWER_SESSION_REVALIDATE_MS,
} from './viewerSessionPreload';

export async function resolveRoutineSessionRole(member, getRole, timeoutMs) {
  if (member?.sessionRole !== undefined) return member.sessionRole;
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
      throw new Error('The navigation role response was invalid.');
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
    document.addEventListener('visibilitychange', revalidateIfDue);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener('focus', revalidateIfDue);
      document.removeEventListener('visibilitychange', revalidateIfDue);
    };
  }, [enabled, validatedAt, onRevalidate]);
}