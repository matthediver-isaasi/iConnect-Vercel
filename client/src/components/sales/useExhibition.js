import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useSalesSettingsScope } from "./useSalesSettings";

export async function exhibitionRequest(path, options = {}) {
  const response = await base44._apiRequest(path, { credentials: "include", ...options });
  return response?.data ?? response;
}

export function useExhibition(filters = {}, enabled = true) {
  const { scopeKey, ready } = useSalesSettingsScope();
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "" && value !== undefined && value !== null) params.set(key, String(value));
  });
  return useQuery({
    queryKey: ["sales-exhibition", scopeKey, params.toString()],
    queryFn: ({ signal }) => exhibitionRequest(`/api/sales/exhibition?${params}`, { signal }),
    enabled: ready && enabled,
    retry: false,
  });
}

export function useExhibitionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method = "POST", ...body }) => exhibitionRequest("/api/sales/exhibition", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales-exhibition"] }),
  });
}
