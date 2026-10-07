import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { adminFetch } from "@/lib/adminFetch";

export function useFormAlertTenant() {
  const [tenantId, setTenantId] = useState(getActiveTenantId);
  useEffect(() => {
    setTenantId(getActiveTenantId());
    return subscribeToActiveTenantId(setTenantId);
  }, []);
  return tenantId;
}

async function alertRequest(tenantId, url, options = {}) {
  if (!tenantId || getActiveTenantId() !== tenantId) {
    throw new Error("The active tenant changed. Reopen this form before continuing.");
  }
  const response = await adminFetch(url, { credentials: "include", ...options });
  const data = await response.json().catch(() => null);
  if (getActiveTenantId() !== tenantId) {
    throw new Error("The active tenant changed. Reopen this form before continuing.");
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error
      : typeof data?.message === "string" ? data.message
      : "Unable to update submission alerts. Please try again.");
  }
  return data;
}

export function useFormAlerts(formId, tenantId, enabled) {
  const queryClient = useQueryClient();
  const queryKey = ["form-alerts", tenantId, formId];
  const url = `/api/admin/form-alerts?form_id=${encodeURIComponent(formId || "")}`;
  const query = useQuery({
    queryKey,
    enabled: !!(enabled && formId && tenantId),
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
    onSuccess: (settings) => queryClient.setQueryData(queryKey, settings),
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
