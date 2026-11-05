import { popupRequest } from "@/lib/cmsPopups";
import { boundedPopupRequest } from "./popupRuntimeRequests";

// Short-lived, component-owned discovery only: never cache a selected design or
// allow a response from a different member, page or old navigation to authorize it.
export function startPopupDiscovery(pageSlug, viewerIdentity, signal) {
  const query = new URLSearchParams({ page_slug: pageSlug }).toString();
  return {
    pageSlug, viewerIdentity,
    promise: boundedPopupRequest(popupRequest, query, { publicRequest: true, signal })
      .then(data => ({ data, receivedAt: Date.now() }), () => null),
  };
}

export async function readPopupDiscovery(discovery, page, viewerIdentity) {
  if (!discovery || discovery.pageSlug !== page.slug || discovery.viewerIdentity !== viewerIdentity) return null;
  const result = await discovery.promise;
  if (!result || Date.now() - result.receivedAt > 10000
    || result.data?.page_id !== page.id || result.data?.viewer_key !== viewerIdentity) return null;
  return result.data;
}
