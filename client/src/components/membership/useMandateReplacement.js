import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const mandateReplacementKey = (tenantId, memberId) => [
  "membership-mandate-replacement", tenantId || null, memberId || null,
];

export async function requestMandateReplacement({ action, tenantId, signal, request = fetch }) {
  const response = await request("/api/membership/mandate-replacement", {
    credentials: "include",
    signal,
    headers: {
      ...(tenantId ? { "X-Tenant-Id": tenantId } : {}),
      ...(action ? { "Content-Type": "application/json" } : {}),
    },
    ...(action ? { method: "POST", body: JSON.stringify({ action }) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not check your Direct Debit change. Please try again.");
  if (typeof payload.eligible !== "boolean" || typeof payload.canStart !== "boolean"
    || typeof payload.canResume !== "boolean") {
    throw new Error("Could not verify your Direct Debit change. Please try again.");
  }
  return payload;
}

export function useMandateReplacement({ memberId, tenantId }) {
  const client = useQueryClient();
  const lock = useRef(false);
  const mounted = useRef(true);
  const initialVerification = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = mandateReplacementKey(tenantId, memberId);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => requestMandateReplacement({ tenantId, signal }),
    enabled: !!memberId,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const perform = useCallback(async (action) => {
    if (!memberId || lock.current) return null;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const queryKey = mandateReplacementKey(tenantId, memberId);
      // Prevent an older eligibility GET overwriting a newly verified operation.
      await client.cancelQueries({ queryKey });
      const result = await requestMandateReplacement({ action, tenantId });
      client.setQueryData(queryKey, result);
      if (result.operation?.status === "completed") {
        // Existing membership/history consumers retain their own query keys.
        // Mark them stale without discarding the confirmed operation.
        void client.invalidateQueries({ predicate: query => query.queryKey[0] !== queryKey[0] });
      }
      return mounted.current ? result : null;
    } catch (err) {
      if (mounted.current) setError(err.message);
      return null;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [client, memberId, tenantId]);

  const refresh = useCallback(() => perform("refresh"), [perform]);

  // A hosted flow may return in a fresh document, not just a focus event.
  useEffect(() => {
    if (!query.isSuccess || query.isFetching || initialVerification.current) return;
    initialVerification.current = true;
    if (query.data?.operation) void refresh();
  }, [query.isSuccess, query.isFetching, query.data?.operation, refresh]);

  useEffect(() => {
    if (!memberId) return;
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [memberId, refresh]);

  return { ...query, busy, error, perform, refresh };
}
