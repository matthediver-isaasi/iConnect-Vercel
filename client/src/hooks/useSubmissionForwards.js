import { useQuery } from "@tanstack/react-query";
import { adminFetch } from "@/lib/adminFetch";
import { groupSubmissionForwards, submissionForwardBatchIds } from "@/lib/formSubmissionForwards.mjs";

const ENDPOINT = "/api/admin/form-submission-forwards";

export async function submissionForwardRequest(scope, params, payload, signal) {
  scope.assertCurrent();
  const response = await adminFetch(`${ENDPOINT}${params ? `?${new URLSearchParams(params)}` : ""}`, {
    credentials: "include", cache: "no-store", signal,
    ...(payload ? {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    } : {}),
  }, scope.tenantId);
  const data = await response.json().catch(() => null);
  scope.assertCurrent();
  if (!response.ok || !data) {
    throw new Error(typeof data?.error === "string" ? data.error : "Unable to confirm the request. Please try again.");
  }
  return data;
}

export function useSubmissionForwardListHistory(scope, submissions) {
  const ids = submissionForwardBatchIds(submissions);
  return useQuery({
    queryKey: ["submission-forwards-list", scope.scopeKey, ids.join(",")],
    enabled: scope.status === "ready" && ids.length > 0,
    queryFn: async ({ signal }) => {
      const data = await submissionForwardRequest(scope, { submission_ids: ids.join(",") }, null, signal);
      return groupSubmissionForwards(data.forwards);
    },
    retry: false, gcTime: 0,
  });
}

export function useSubmissionForwardHistory(scope, submissionId, enabled = true) {
  return useQuery({
    queryKey: ["submission-forwards", scope.scopeKey, submissionId],
    enabled: scope.status === "ready" && !!submissionId && enabled,
    queryFn: ({ signal }) => submissionForwardRequest(scope, { submission_id: submissionId }, null, signal),
    retry: false, gcTime: 0,
  });
}

export function useSubmissionForwardMembers(scope, submissionId, search, enabled) {
  return useQuery({
    queryKey: ["submission-forward-members", scope.scopeKey, submissionId, search.trim()],
    enabled: scope.status === "ready" && enabled && search.trim().length >= 2,
    queryFn: ({ signal }) => submissionForwardRequest(scope, {
      submission_id: submissionId, action: "members", q: search.trim(),
    }, null, signal),
    retry: false, gcTime: 0,
  });
}
