import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";

export const BADGE_HELP_PATH = "/help/sharing-your-membership-badge";
export const BADGE_INSTRUCTIONS_ENDPOINT = "/api/badge-instructions";
export const MAX_BADGE_PDF_BYTES = 2 * 1024 * 1024;
export const badgeInstructionsKey = (tenantId) => ["badge-instructions", tenantId];
export const badgeDocumentUrl = (tenantId) => `${BADGE_INSTRUCTIONS_ENDPOINT}?document=true&tenantId=${encodeURIComponent(tenantId)}`;

export function useBadgeTenant(memberTenantId) {
  const active = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  if (active && memberTenantId && String(active) !== String(memberTenantId)) return null;
  return active || memberTenantId || null;
}

export async function badgeInstructionsRequest(tenantId, method = "GET", body, signal) {
  if (!tenantId) throw new Error("Select an active tenant and try again.");
  const response = await fetch(BADGE_INSTRUCTIONS_ENDPOINT, {
    method, credentials: "include", signal,
    headers: { "X-Tenant-Id": String(tenantId), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof data?.error === "string" ? data.error : data?.message;
    const error = new Error(response.status === 409
      ? "These instructions changed elsewhere. Reload the saved settings, then try again."
      : detail || `Request failed (${response.status}). Please try again.`);
    if (typeof data?.warning === "string") error.warning = data.warning;
    throw error;
  }
  if (!data || String(data.tenantId) !== String(tenantId) ||
      !["standard", "pdf"].includes(data.mode) || typeof data.canManage !== "boolean" ||
      !(data.revision === null || typeof data.revision === "string") ||
      !(data.document === null || (typeof data.document?.filename === "string" &&
        Number.isFinite(data.document?.size) && data.document.size > 0 && data.document.size <= MAX_BADGE_PDF_BYTES))) {
    throw new Error("The server returned invalid badge instructions. Reload and try again.");
  }
  return data;
}

export function useBadgeInstructions(tenantId) {
  return useQuery({
    queryKey: badgeInstructionsKey(tenantId),
    enabled: !!tenantId,
    queryFn: ({ signal }) => badgeInstructionsRequest(tenantId, "GET", undefined, signal),
    retry: false,
    staleTime: 0,
  });
}

export function useSaveBadgeInstructions(tenantId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ method, body }) => badgeInstructionsRequest(tenantId, method, body),
    onSuccess: (data) => client.setQueryData(badgeInstructionsKey(tenantId), data),
  });
}

export function readBadgePdf(file) {
  if (!file || !/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
    return Promise.reject(new Error("Choose a PDF file (.pdf)."));
  }
  if (file.size <= 0 || file.size > MAX_BADGE_PDF_BYTES) {
    return Promise.reject(new Error("Choose a non-empty PDF no larger than 2 MB."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The PDF could not be read. Select it again and retry."));
    reader.onabort = () => reject(new Error("Reading was cancelled. Select the PDF again."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}

// Opening the tab synchronously avoids popup blocking; fetching explicitly keeps
// tenant headers on document requests (ordinary anchors cannot send headers).
export async function previewBadgePdf(event, tenantId, onError = () => {}) {
  event.preventDefault();
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    onError("Allow popups for this site, then open the PDF again.");
    return;
  }
  tab.opener = null;
  tab.document.title = "Badge instructions";
  tab.document.body.textContent = "Loading badge instructions…";
  try {
    const response = await fetch(badgeDocumentUrl(tenantId), {
      credentials: "include", headers: { "X-Tenant-Id": String(tenantId) },
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/pdf")) {
      throw new Error("The PDF is unavailable. Try again or use the standard help page.");
    }
    const url = URL.createObjectURL(await response.blob());
    if (tab.closed) { URL.revokeObjectURL(url); return; }
    tab.location.replace(url);
    window.setTimeout(() => URL.revokeObjectURL(url), 300000);
  } catch (error) {
    onError(error.message);
    if (!tab.closed) {
      tab.document.body.textContent = `${error.message} `;
      const fallback = tab.document.createElement("a");
      fallback.href = new URL(BADGE_HELP_PATH, window.location.origin).href;
      fallback.textContent = "Open standard badge help";
      tab.document.body.appendChild(fallback);
    }
  }
}
