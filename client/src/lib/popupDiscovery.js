import { popupRequest } from "@/lib/cmsPopups";
import { boundedPopupRequest } from "./popupRuntimeRequests";
import { popupDiagnostic, popupFailureReason } from "./popupDiagnostics";

// Short-lived, component-owned discovery only: never cache a selected design or
// allow a response from a different member, page or old navigation to authorize it.
export function startPopupDiscovery(pageSlug, viewerIdentity, signal) {
  popupDiagnostic("discovery_started");
  const query = new URLSearchParams({ page_slug: pageSlug }).toString();
  return {
    pageSlug, viewerIdentity,
    promise: boundedPopupRequest(popupRequest, query, { publicRequest: true, signal })
      .then(data => {
        popupDiagnostic("discovery_received");
        return { data, receivedAt: Date.now() };
      }, error => { popupDiagnostic("discovery_failed", { reason: popupFailureReason(error) }); return null; }),
  };
}

export async function readPopupDiscovery(discovery, page, viewerIdentity) {
  const reject = (reason, ageMs) => { popupDiagnostic("discovery_not_reused", { reason, ageMs }); return null; };
  if (!discovery) return reject("not_available");
  if (discovery.pageSlug !== page.slug) return reject("page_changed");
  if (discovery.viewerIdentity !== viewerIdentity) return reject("viewer_changed");
  const result = await discovery.promise;
  if (!result) return reject("request_failed");
  const ageMs = Date.now() - result.receivedAt;
  if (ageMs > 10000) return reject("expired", ageMs);
  if (result.data?.page_id !== page.id) return reject("page_changed", ageMs);
  if (result.data?.viewer_key !== viewerIdentity) return reject("viewer_changed", ageMs);
  popupDiagnostic("discovery_reused", { ageMs });
  return result.data;
}
