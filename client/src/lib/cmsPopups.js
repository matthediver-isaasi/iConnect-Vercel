import { adminFetch } from "@/lib/adminFetch";
import { getTenantSlugFromLocation } from "@/api/publicClient";
import { POPUP_BLOCK_TYPES as SHARED_POPUP_BLOCK_TYPES, POPUP_DEFAULT_CONFIG, validatePopupDesign } from "@shared/cmsPopupContract.js";

export async function popupRequest(query = "", { publicRequest = false, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (publicRequest) {
    let slug = null;
    try { slug = getTenantSlugFromLocation(); } catch { /* Host resolution remains authoritative when storage is denied. */ }
    if (slug) {
      headers.set("X-Tenant-Slug", slug);
      const params = new URLSearchParams(query);
      params.set("tenant", slug);
      query = params.toString();
    }
  }
  const response = await (publicRequest ? fetch : adminFetch)(
    `/api/${publicRequest ? "" : "admin/"}cms-popups${query ? `?${query}` : ""}`,
    { ...options, headers, credentials: "include", cache: "no-store" },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 409
      ? "This popup changed in another session. Reload before saving again."
      : data.error || "Unable to load popups.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export const DEFAULT_POPUP_CONFIG = POPUP_DEFAULT_CONFIG;

// Deliberately conservative: payment, auth, booking, arbitrary HTML/embeds and
// dynamic widgets do not belong in automatically presented modal documents.
export const POPUP_BLOCK_TYPES = new Set(SHARED_POPUP_BLOCK_TYPES);
export function popupDesignError(design) {
  try { validatePopupDesign(design); return null; }
  catch (error) { return error.message; }
}

export function popupConfig(popup) {
  const config = popup?.config || {};
  return { ...DEFAULT_POPUP_CONFIG, ...config,
    modal: { ...DEFAULT_POPUP_CONFIG.modal, ...config.modal },
    trigger: { ...DEFAULT_POPUP_CONFIG.trigger, ...config.trigger },
    frequency: { ...DEFAULT_POPUP_CONFIG.frequency, ...config.frequency } };
}
