// Detail reads use the carousel publication boundary, including primary-source
// consent. Never substitute a generic Member/Organization entity read or the
// ordinary directory list, whose access policy is not carousel publication.
export async function readDirectoryCarouselDetails({ source, directoryId, directorySlug, tenant, recordId, entityType, signal }) {
  const params = new URLSearchParams({ mode: "carousel", source, detail_id: recordId });
  if (source === "dynamic") {
    if (directoryId) params.set("directory_id", directoryId);
    else if (directorySlug) params.set("slug", directorySlug);
    else throw new Error("Directory is not configured");
  }
  if (tenant) params.set("tenant", tenant);
  const response = await fetch(`/api/public/dynamic-directory?${params}`, {
    credentials: "include", signal, cache: "no-store",
  });
  if (!response.ok) throw new Error("Directory details unavailable");
  const data = await response.json();
  // Older servers ignore detail_id and return a logo-only carousel page.
  // Fail closed until the authorized detail contract is available.
  const detail = data.detail;
  if (data.source !== source || detail?.entityType !== entityType || detail?.record?.id !== recordId
    || !detail.config?.directory
    || (source === "dynamic" && (directoryId
      ? detail.config.directory.id !== directoryId
      : detail.config.directory.slug !== directorySlug))) {
    throw new Error("Record no longer available in this directory");
  }
  return detail;
}
