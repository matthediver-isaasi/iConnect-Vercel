import { adminFetch } from "@/lib/adminFetch";

// Authenticated adapters only: authority and target validation stay server-side.
async function request(path, { context, tenantId, signal, method = "GET", body } = {}) {
  context?.assertCurrent();
  const response = await adminFetch(path, {
    method, credentials: "include", cache: "no-store", signal,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }, context?.tenantId || tenantId);
  const data = await response.json().catch(() => null);
  context?.assertCurrent();
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "Sign in with your member account or an authorised administrator account, then retry."
      : typeof data?.error === "string" ? data.error
        : "Affiliation settings could not be loaded or saved. Please retry.";
    throw Object.assign(new Error(message), { status: response.status, code: data?.code });
  }
  if (!data || typeof data !== "object") throw new Error("The affiliation response could not be verified. Please retry.");
  return data;
}

export const loadAffiliationConfig = (formId, options) =>
  request(`/api/forms/member-affiliation-config?form_id=${encodeURIComponent(formId)}`, options);
export const saveAffiliationConfig = (formId, config, options) =>
  request("/api/forms/member-affiliation-config", { ...options, method: "PUT", body: { form_id: formId, config } });
export const loadAffiliationDiscovery = (formId, options) =>
  request(`/api/forms/member-affiliation-discovery?form_id=${encodeURIComponent(formId)}`, options);
export const loadMemberAffiliationSnapshot = (formId, options) =>
  request(`/api/forms/member-affiliations?form_id=${encodeURIComponent(formId)}`, options);
export const loadAffiliationReview = (submissionId, options) =>
  request(`/api/forms/member-affiliation-review?submission_id=${encodeURIComponent(submissionId)}`, options);
export const saveAffiliationResolution = (submissionId, resolution, expectedVersion, options) =>
  request("/api/forms/member-affiliation-review", {
    ...options, method: "PUT", body: { submission_id: submissionId, resolution, expectedVersion },
  });
