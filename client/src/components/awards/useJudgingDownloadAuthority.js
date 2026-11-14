import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { getTenantSlugFromLocation } from '@/api/publicClient';
import { getActiveTenantId } from '@/api/base44Client';
import { useMemberChangeSession as useVerifiedMemberSession } from '@/hooks/useMemberChangeSession';
import { getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused } from '@/lib/viewerProtectedWorkGate';
import { readJudgingCsrf, subscribeJudgingSession } from './judgingClient';

const unavailableTenant = Symbol('unavailable-judging-tenant');
function tenantSnapshot() {
  try { return getTenantSlugFromLocation(); } catch { return unavailableTenant; }
}

// A read guard, not an access grant. Restricted identity comes from the real
// session response; the attachment endpoint checks the HttpOnly cookie again.
export function useJudgingDownloadAuthority({
  scope, memberInfo, authResolved, restrictedSession, restricted, signedOut, signingOut, isSigningOut,
}) {
  const memberSession = useVerifiedMemberSession();
  const csrf = useSyncExternalStore(subscribeJudgingSession, readJudgingCsrf, () => null);
  const credentials = useRef({ csrf, epoch: 0 });
  if (credentials.current.csrf !== csrf) credentials.current = { csrf, epoch: credentials.current.epoch + 1 };
  const tenant = useSyncExternalStore(subscribeJudgingSession, tenantSnapshot, () => null);
  const tenantReady = tenant !== unavailableTenant;
  const tenantSlug = tenantReady ? tenant : null;
  const generation = getViewerProtectedWorkGeneration();
  const tenantIntent = getActiveTenantId();
  const session = restrictedSession.data;
  const ready = !!(tenantReady && authResolved && !signedOut && !signingOut
    && !isViewerProtectedWorkPaused() && (memberInfo ? memberSession.status === 'ready'
      : restricted && session?.appointmentId && session?.roundId
        && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > Date.now()));
  // Never put CSRF credentials in a URL, query key, or public scope string.
  const scopeKey = JSON.stringify([scope, memberSession.scopeKey, memberInfo?.id, tenantSlug, tenantIntent, authResolved,
    session?.appointmentId, session?.roundId, session?.expiresAt, credentials.current.epoch, ready]);
  const live = useRef(null);
  live.current = { scopeKey, ready, isSigningOut };
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return {
    scopeKey, tenantSlug, ready,
    assertCurrent() {
      if (!mounted.current || !ready || !live.current.ready || live.current.scopeKey !== scopeKey
        || live.current.isSigningOut?.() || isViewerProtectedWorkPaused()
        || getViewerProtectedWorkGeneration() !== generation || readJudgingCsrf() !== csrf
        || getActiveTenantId() !== tenantIntent
        || getTenantSlugFromLocation() !== tenantSlug) {
        throw new Error('Your judging access context changed. Reopen the current assignment before downloading.');
      }
      if (memberInfo) memberSession.assertCurrent();
      else if (!restricted || Date.parse(session.expiresAt) <= Date.now()) {
        throw new Error('Your restricted judging session expired. Open a current invitation before downloading.');
      }
    },
  };
}
