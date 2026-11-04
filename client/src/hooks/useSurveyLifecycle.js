import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export async function surveyLifecycleRequest(body, { signal } = {}) {
  // Nested update_assignment changes are forwarded without normalization here:
  // preview and execute must carry exactly the same dates/access configuration.
  const response = await fetch("/api/surveys/lifecycle", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || "Survey lifecycle could not be updated. Please try again.");
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export function useSurveyLifecycle(formId, enabled = true) {
  return useQuery({
    queryKey: ["survey-lifecycle", formId],
    enabled: !!formId && enabled,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/surveys/lifecycle?form_id=${encodeURIComponent(formId)}`, {
        credentials: "include", signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || "Could not load survey lifecycle.");
      return payload;
    },
  });
}

export function useSurveyLifecycleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async body => {
      const result = await surveyLifecycleRequest({ operation: "execute", ...body });
      if (result.success !== true) throw new Error("The server did not confirm this change. Refresh the impact before trying again.");
      return result;
    },
    onSuccess: async () => {
      // All duplicated management surfaces must refresh after the same workflow.
      await queryClient.invalidateQueries({
        predicate: query => [
          "survey-lifecycle", "forms", "form", "forms-for-surveys",
          "event-survey-assignments", "survey-assignment-version-form",
          "survey-assignment-versions", "dd-enabled-forms", "form-for-dd-config",
          "seedable-forms-all",
        ].includes(query.queryKey[0]),
      });
    },
  });
}
