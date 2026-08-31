import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const ROOT = "/api/sales/catalogue";
const request = (path, options) => base44._apiRequest(`${ROOT}${path}`, options);
const unwrap = (response) => response?.data ?? response;

export function useCatalogue(resource, search = "") {
  const queryClient = useQueryClient();
  const queryKey = ["sales-catalogue", resource, search];
  const params = new URLSearchParams({ includeInactive: "true" });
  if (search && resource !== "categories") params.set("q", search);
  const endpoint = `/${resource}?${params.toString()}`;
  const query = useQuery({
    queryKey,
    queryFn: async () => unwrap(await request(endpoint)),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sales-catalogue", resource] });
  const create = useMutation({ mutationFn: (data) => request(`/${resource}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, data }) => request(`/${resource}/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }), onSuccess: refresh });
  const archive = useMutation({ mutationFn: (id) => request(`/${resource}/${id}/archive`, { method: "POST" }), onSuccess: refresh });
  const restore = useMutation({ mutationFn: (id) => request(`/${resource}/${id}/restore`, { method: "POST" }), onSuccess: refresh });
  const reorder = useMutation({ mutationFn: (ids) => request(`/${resource}/reorder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }), onSuccess: refresh });
  return { ...query, create, update, archive, restore, reorder };
}

export function useEventOptions() {
  return useQuery({ queryKey: ["sales-catalogue", "event-options"], queryFn: async () => unwrap(await request("/event-options")) });
}