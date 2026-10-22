import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { adminFetch } from "@/lib/adminFetch";
import { invoicingAddressChanges, invoicingAddressFormValues, INVOICING_CORE_FIELDS } from "@/lib/invoicingAddressFields";
import {
  getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused, subscribeToViewerProtectedWork,
} from "@/lib/viewerProtectedWorkGate";

export async function invoicingAddressRequest(tenantId, ownerType, ownerId, address, signal) {
  const write = address !== undefined;
  const response = await adminFetch(write ? "/api/invoicing-address"
    : `/api/invoicing-address?${new URLSearchParams({ ownerType, ownerId })}`, {
    method: write ? "PATCH" : "GET",
    signal,
    cache: "no-store",
    ...(write ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerType, ownerId, address }) } : {}),
  }, tenantId);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "Failed to load or save invoicing address.");
  if (!data?.address || INVOICING_CORE_FIELDS.some(({ fieldKey }) =>
    data.address[fieldKey] !== null && typeof data.address[fieldKey] !== "string")) {
    throw new Error("Invalid invoicing address response.");
  }
  return data.address;
}

// Address drafts never live in an entity form. A draft is bound to the exact
// tenant, authenticated viewer/session, and owner that supplied its baseline.
export function useInvoicingAddress(ownerType, ownerId, { isNew = false } = {}) {
  const { memberInfo, authResolved, sessionValidated, sessionWorkPaused, sessionRoleSnapshot } = useLayoutContext();
  const tenantIntent = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const generation = useSyncExternalStore(subscribeToViewerProtectedWork,
    getViewerProtectedWorkGeneration, getViewerProtectedWorkGeneration);
  const paused = sessionWorkPaused || isViewerProtectedWorkPaused();
  const dashboard = useQuery({
    queryKey: ["invoicing-address-session", tenantIntent, generation, authResolved],
    enabled: !!authResolved && !memberInfo && !paused,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/auth/tenant-user-me", { credentials: "include", cache: "no-store", signal });
      const data = await res.json();
      if (!res.ok || !data?.authenticated || !data?.tenant?.id) throw new Error("Your session could not be verified.");
      return data;
    },
  });
  const tenantId = memberInfo?.tenant_id || dashboard.data?.tenant?.id;
  const allowed = !!(authResolved && !paused && tenantId && (!tenantIntent || tenantIntent === tenantId)
    && (memberInfo ? sessionValidated && sessionRoleSnapshot?.session_key : dashboard.isSuccess));
  const queryKey = ["invoicing-address", tenantId, memberInfo?.id || dashboard.data?.user?.id,
    memberInfo?.role_id, sessionRoleSnapshot?.session_key, generation, ownerType, ownerId || "new", allowed];
  const identityKey = JSON.stringify(queryKey);
  const scope = useRef({ identityKey, epoch: 0 });
  if (scope.current.identityKey !== identityKey) {
    scope.current = { identityKey, epoch: scope.current.epoch + 1 };
  }
  const scopeKey = JSON.stringify([identityKey, scope.current.epoch]);
  const live = useRef();
  live.current = scopeKey;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    enabled: allowed && !!ownerId && !isNew,
    queryFn: ({ signal }) => invoicingAddressRequest(tenantId, ownerType, ownerId, undefined, signal),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [draftState, setDraftState] = useState(null);
  const [saveState, setSaveState] = useState(null);
  useEffect(() => {
    setDraftState(null);
    setSaveState(null);
  }, [scopeKey]);
  const draft = draftState?.scopeKey === scopeKey ? draftState : null;
  const ready = allowed && (isNew || (query.isSuccess && !query.isFetching && !query.isError));
  const values = draft?.values || invoicingAddressFormValues(isNew ? {} : query.data);
  const error = saveState?.scopeKey === scopeKey && saveState.error
    || query.error?.message || dashboard.error?.message
    || (!allowed && authResolved && !dashboard.isFetching ? "Your tenant or session could not be verified. Reload this page." : null);
  const assertCurrent = () => {
    if (!mounted.current || !allowed || live.current !== scopeKey || getActiveTenantId() !== tenantIntent
      || getViewerProtectedWorkGeneration() !== generation || isViewerProtectedWorkPaused()) {
      throw new Error("Your tenant, session or address owner changed. Reopen this record before saving.");
    }
  };
  return {
    values, ready, error, scopeKey, assertCurrent,
    saveError: saveState?.scopeKey === scopeKey && !!saveState.error,
    loading: !error && !ready,
    saving: saveState?.scopeKey === scopeKey && saveState.pending,
    retry: () => dashboard.isError ? dashboard.refetch() : query.refetch(),
    reset: () => { setDraftState(null); setSaveState(null); },
    setValue: (key, value) => {
      if (!ready) return;
      setDraftState({ scopeKey, values: { ...values, [key]: value }, baseline: draft?.baseline || (isNew ? {} : query.data) });
    },
    // New owners are created first, then explicitly supplied here. Failed writes
    // retain the draft and baseline; retries therefore cannot clear unread data.
    save: async (createdOwnerId) => {
      assertCurrent();
      if (!draft) return;
      if (!ready) throw new Error("Reload the invoicing address before saving address changes.");
      const changes = invoicingAddressChanges(draft.values, draft.baseline);
      if (!Object.keys(changes).length) return;
      const id = isNew ? createdOwnerId : ownerId;
      if (!id) throw new Error("Create the address owner before saving its invoicing address.");
      setSaveState({ scopeKey, pending: true });
      try {
        const address = await invoicingAddressRequest(tenantId, ownerType, id, changes);
        assertCurrent();
        client.setQueryData(queryKey, address);
        setDraftState({ scopeKey, values: invoicingAddressFormValues(address), baseline: address });
        setSaveState(null);
      } catch (e) {
        if (live.current === scopeKey) setSaveState({ scopeKey, error: e.message });
        throw e;
      }
    },
  };
}
