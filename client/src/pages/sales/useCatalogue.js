import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useSalesSettingsScope } from "@/components/sales/useSalesSettings";

const ROOT = "/api/sales/catalogue";
const request = (path, options) => base44._apiRequest(`${ROOT}${path}`, options);
const unwrap = (response) => response?.data ?? response;

export function useCatalogue(resource, search = "") {
  const queryClient = useQueryClient();
  const { scopeKey, ready } = useSalesSettingsScope();
  const queryKey = ["sales-catalogue", resource, scopeKey, search];
  const params = new URLSearchParams({ includeInactive: "true" });
  if (search && resource !== "categories") params.set("q", search);
  const endpoint = `/${resource}?${params.toString()}`;
  const query = useQuery({
    queryKey,
    enabled: ready,
    queryFn: async () => unwrap(await request(endpoint)),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sales-catalogue", resource] });
  const create = useMutation({ mutationFn: (data) => request(`/${resource}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, data }) => request(`/${resource}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), onSuccess: refresh });
  const archive = useMutation({ mutationFn: (id) => request(`/${resource}/${id}/archive`, { method: "POST" }), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (id) => request(`/${resource}/${id}/restore`, { method: "POST" }), onSuccess: refresh });
  const reorder = useMutation({ mutationFn: (ids) => request(`/${resource}/reorder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }), onSuccess: refresh });
  const updateStock = useMutation({
    mutationFn: ({ id, remaining, expectedVersion }) => request(`/bundles/${id}/stock`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remaining, expectedVersion }),
    }),
    onSuccess: (response, { id }) => {
      const stock = unwrap(response);
      const patchRows = rows => rows.map(row => row.id === id ? { ...row, bundleStock: stock } : row);
      queryClient.setQueriesData({ queryKey: ["sales-catalogue", "bundles", scopeKey] }, old => {
        if (Array.isArray(old)) return patchRows(old);
        if (Array.isArray(old?.items)) return { ...old, items: patchRows(old.items) };
        if (Array.isArray(old?.results)) return { ...old, results: patchRows(old.results) };
        return old;
      });
    },
  });
  return { ...query, create, update, archive, restore, reorder, updateStock };
}

export function useEventOptions() {
  const { scopeKey, ready } = useSalesSettingsScope();
  return useQuery({ queryKey: ["sales-catalogue", "event-options", scopeKey], enabled: ready, queryFn: async () => unwrap(await request("/event-options")) });
}

export function useCatalogueTaxOptions(enabled = false) {
  const { scopeKey, ready } = useSalesSettingsScope();
  return useQuery({
    queryKey: ["sales-catalogue", "tax-options", scopeKey],
    queryFn: async () => unwrap(await request("/tax-options")),
    enabled: enabled && ready,
  });
}