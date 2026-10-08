import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { adminFetch } from "@/lib/adminFetch";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused,
  subscribeToViewerProtectedWork,
} from "@/lib/viewerProtectedWorkGate";

export function useFormAlertTenant() {
  const { memberInfo, authResolved, sessionValidated, sessionWorkPaused, sessionRoleSnapshot } = useLayoutContext();
  const { roleStatus, isFeatureExcluded } = useMemberAccess();
  const generation = useSyncExternalStore(subscribeToViewerProtectedWork,
    getViewerProtectedWorkGeneration, getViewerProtectedWorkGeneration);
  const paused = sessionWorkPaused || isViewerProtectedWorkPaused();
  const [intent, setIntent] = useState(() => ({ id: getActiveTenantId(), epoch: 0 }));
  const liveIntent = useRef(intent);
  useEffect(() => {
    const update = id => {
      if (id === liveIntent.current.id) return;
      liveIntent.current = { id, epoch: liveIntent.current.epoch + 1 };
      setIntent(liveIntent.current);
    };
    const unsubscribe = subscribeToActiveTenantId(update);
    update(getActiveTenantId());
    return unsubscribe;
  }, []);
  // Dashboard intent is not identity. Verify it independently if this session
  // has no portal member projection. Never resolve from form data or storage.
  const dashboard = useQuery({
    queryKey: ["form-alert-dashboard-session", intent.id, intent.epoch, generation, authResolved],
    enabled: authResolved && !memberInfo && !paused && !(intent.epoch > 0 && !intent.id),
    retry: false,
    // The session owner invalidates the generation on real auth boundaries.
    // A routine focus event must not discard a dashboard's unsaved draft.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 9000);
      try {
        const response = await fetch("/api/auth/tenant-user-me", {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || !data?.authenticated || !data?.tenant?.id) {
          throw new Error("Your session could not be verified. Sign in again or reload this page.");
        }
        return data;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
  const tenantId = memberInfo ? memberInfo.tenant_id : dashboard.data?.tenant?.id;
  const mismatch = (!!intent.id && intent.id !== tenantId) || (!intent.id && intent.epoch > 0);
  const memberReady = sessionValidated && roleStatus === "ready"
    && !!sessionRoleSnapshot?.session_key && !isFeatureExcluded("page_FormBuilder");
  const ready = authResolved && !paused && !!tenantId && !mismatch
    && (memberInfo ? memberReady : dashboard.isSuccess);
  const status = ready ? "ready" : mismatch || paused ? "error"
    : !authResolved || (memberInfo && roleStatus === "loading")
      || (!memberInfo && dashboard.isFetching) ? "loading" : "error";
  const scopeKey = JSON.stringify([tenantId, memberInfo?.id, memberInfo?.role_id,
    sessionRoleSnapshot?.session_key, intent.epoch, generation, dashboard.data?.user?.id, ready]);
  const current = useRef();
  current.current = { scopeKey, ready };
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useMemo(() => ({
    tenantId: ready ? tenantId : null,
    scopeKey,
    status,
    error: mismatch ? "The active tenant changed. Reload this page before continuing."
      : "Your session or FormBuilder access could not be verified. Sign in again or reload this page.",
    assertCurrent() {
      if (!mounted.current || !ready || !current.current?.ready || current.current.scopeKey !== scopeKey
        || liveIntent.current !== intent || getActiveTenantId() !== intent.id
        || getViewerProtectedWorkGeneration() !== generation || isViewerProtectedWorkPaused()) {
        throw new Error("Your tenant or session changed. Reopen this form before continuing.");
      }
    },
  }), [ready, tenantId, scopeKey, status, mismatch, intent, generation]);
}

async function alertRequest(context, url, options = {}) {
  context.assertCurrent();
  const response = await adminFetch(url, { credentials: "include", ...options }, context.tenantId);
  const data = await response.json().catch(() => null);
  context.assertCurrent();
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error
      : typeof data?.message === "string" ? data.message
      : "Unable to update submission alerts. Please try again.");
  }
  return data;
}

export function useFormAlerts(formId, tenantId, enabled) {
  const queryClient = useQueryClient();
  const queryKey = ["form-alerts", tenantId.scopeKey, formId];
  const url = `/api/admin/form-alerts?form_id=${encodeURIComponent(formId || "")}`;
  const query = useQuery({
    queryKey,
    enabled: !!(enabled && formId && tenantId.status === "ready"),
    queryFn: ({ signal }) => alertRequest(tenantId, url, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (settings) => alertRequest(tenantId, url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }),
    onSuccess: (settings) => {
      tenantId.assertCurrent();
      queryClient.setQueryData(queryKey, settings);
    },
  });
  return { query, save };
}

export function useRevokeFormAlert(tenantId) {
  return useMutation({
    mutationFn: async ({ formId, submissionId }) => {
      const result = await alertRequest(tenantId, "/api/admin/form-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", form_id: formId, submission_id: submissionId }),
      });
      if (result?.revoked !== true) throw new Error("Revocation was not confirmed. Please try again.");
      return result;
    },
  });
}
