import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import {
  getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused, subscribeToViewerProtectedWork,
} from "@/lib/viewerProtectedWorkGate";

export function useMemberChangeSession() {
  const { memberInfo, authResolved, sessionValidated, sessionWorkPaused, sessionRoleSnapshot } = useLayoutContext();
  const generation = useSyncExternalStore(subscribeToViewerProtectedWork,
    getViewerProtectedWorkGeneration, getViewerProtectedWorkGeneration);
  const intent = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, getActiveTenantId);
  const ready = !!(authResolved && sessionValidated && memberInfo?.id && memberInfo?.tenant_id
    && sessionRoleSnapshot?.session_key && !sessionWorkPaused && !isViewerProtectedWorkPaused()
    && sessionRoleSnapshot.member_id === memberInfo.id && sessionRoleSnapshot.tenant_id === memberInfo.tenant_id
    && (!intent || intent === memberInfo.tenant_id));
  const scopeKey = JSON.stringify([memberInfo?.tenant_id, memberInfo?.id,
    sessionRoleSnapshot?.session_key, generation, intent, ready]);
  const live = useRef();
  live.current = { scopeKey, ready };
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return {
    scopeKey, status: !authResolved ? "loading" : ready ? "ready" : "error",
    assertCurrent() {
      if (!mounted.current || !ready || !live.current.ready || live.current.scopeKey !== scopeKey
        || getViewerProtectedWorkGeneration() !== generation || isViewerProtectedWorkPaused()
        || getActiveTenantId() !== intent) throw new Error("Your member session changed. Reload this page and sign in again.");
    },
  };
}
