import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { popupRequest } from "@/lib/cmsPopups";
import { getActiveTenantId } from "@/api/base44Client";

export function usePopupDiscovery(enabled = true) {
  return useQuery({ queryKey: ["cms-popup-discovery", getActiveTenantId()], queryFn: () => popupRequest("discovery=1"), enabled, staleTime: 60000 });
}
export function useCmsPopups(id, enabled = true, editorRead = false) {
  const client = useQueryClient();
  const tenantId = getActiveTenantId();
  const key = id ? ["cms-popup", tenantId, id, editorRead] : ["cms-popups", tenantId];
  const query = useQuery({
    queryKey: key, queryFn: () => popupRequest(id ? `id=${encodeURIComponent(id)}${editorRead ? "&preview=1" : ""}` : ""),
    // Lists contain management configuration only. Any id read returns design
    // and must be explicitly opted into by an authorized popup editor.
    enabled: enabled && (!id || editorRead), staleTime: 0,
  });
  const mutation = useMutation({
    mutationFn: ({ id: target, method = "PATCH", ...body }) => popupRequest(
      target ? `id=${encodeURIComponent(target)}` : "",
      { method, body: JSON.stringify(body) },
    ),
    onSuccess: (data) => {
      if (data.popup) {
        client.setQueryData(["cms-popup", tenantId, data.popup.id, editorRead], (old) => ({ ...old, popup: { ...old?.popup, ...data.popup } }));
      }
      client.invalidateQueries({ queryKey: ["cms-popups"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return { ...query, mutation };
}
