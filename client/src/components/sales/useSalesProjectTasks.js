import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const PROJECT_TASKS_URL = "/api/sales/project-tasks";
export async function projectTaskRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include", ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
export function projectTasksSearch(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => [key, String(value)])).toString();
}
export function refreshSalesProjects(queryClient) {
  const roots = new Set(["sales-project-tasks", "opportunity", "opportunities", "project-board", "project-boards", "card-detail", "sales-dashboard", "sales-reports"]);
  return queryClient.invalidateQueries({ predicate: (query) => roots.has(query.queryKey[0]) });
}
export function useSalesProjectTasks(params, enabled = true) {
  return useQuery({
    queryKey: ["sales-project-tasks", params],
    queryFn: () => projectTaskRequest(`${PROJECT_TASKS_URL}?${projectTasksSearch(params)}`),
    enabled, refetchOnWindowFocus: true, refetchInterval: 45000,
  });
}
export function useSalesProjectCommand(opportunityId, expectedVersion) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command) => projectTaskRequest(PROJECT_TASKS_URL, {
      method: "POST", body: JSON.stringify({ opportunityId, expectedVersion, ...command }),
    }),
    onSettled: () => refreshSalesProjects(queryClient),
  });
}
