import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { projectTaskRequest } from "@/components/sales/useSalesProjectTasks";
import { invalidateInboxViews } from "@/lib/inboxSources.mjs";

export function useBoardInbox(boardId, page = 1, enabled = true) {
  const queryClient = useQueryClient();
  const url = `/api/projects/boards/${encodeURIComponent(boardId)}/inbox`;
  const query = useQuery({
    queryKey: ["board-inbox", boardId, page],
    queryFn: ({ signal }) => projectTaskRequest(`${url}?page=${page}&pageSize=30`, { signal }),
    enabled: Boolean(boardId && enabled),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const command = useMutation({
    mutationFn: (body) => apiRequest("PATCH", url, body),
    onSuccess: () => invalidateInboxViews(queryClient, boardId),
  });
  return { query, command };
}
