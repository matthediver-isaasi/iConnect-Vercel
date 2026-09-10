import { useQuery } from "@tanstack/react-query";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const metadataKey = (memberInfo, directoryId, settings) => [
  "directory-object-sources",
  memberInfo?.tenant_id || null,
  memberInfo?.id || null,
  directoryId || "main",
  Boolean(settings),
];

/** Explicit publication/embed markers only; ordinary framed app previews are authenticated app views. */
export function isDirectoryEmbedLocation(location) {
  const current = location || (typeof window !== "undefined" ? window.location : null);
  if (!current) return false;
  const pathname = String(current.pathname || "").toLowerCase();
  return pathname === "/embed" || pathname.startsWith("/embed/")
    || new URLSearchParams(current.search || "").get("embed") === "true";
}

/**
 * Authenticated metadata for custom-object fields opted in to an organisation
 * directory. The identity dimensions prevent data crossing tenant/viewer
 * caches. Guests never issue this request.
 */
export function useDirectoryObjectSources({
  directoryId = "main",
  settings = false,
  enabled = true,
} = {}) {
  const { memberInfo, authResolved } = useMemberAccess();
  const queryKey = metadataKey(memberInfo, directoryId, settings);
  const isEmbedded = isDirectoryEmbedLocation();

  return useQuery({
    queryKey,
    enabled: Boolean(
      enabled && authResolved && memberInfo?.id && memberInfo?.tenant_id
      && directoryId && !isEmbedded
    ),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (directoryId && directoryId !== "main") params.set("directory_id", directoryId);
      if (settings) params.set("settings", "true");
      const suffix = params.size ? `?${params}` : "";
      const response = await fetch(`/api/organisation-directory/custom-object-fields${suffix}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Unable to load custom object fields");
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.sources)) {
        throw new Error("Invalid custom object fields response");
      }
      return payload;
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
}
