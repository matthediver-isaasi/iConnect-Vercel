import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { projectTaskRequest } from "@/components/sales/useSalesProjectTasks";
import { invalidateInboxViews } from "@/lib/inboxSources.mjs";

export const boardInboxSummaryKey = (boardId) => ["board-inbox", boardId, "summary"];

// List identity includes the filter so all/unread pages never share cache entries.
// Every key stays under ["board-inbox", boardId] for shared invalidation.
export const boardInboxListKey = (boardId, page, unreadOnly = false) => ["board-inbox", boardId, page, unreadOnly ? "unread" : "all"];

// A complete set, independent of the inbox's paginated message list.
export function useBoardInboxSummary(boardId, enabled = true) {
  return useQuery({
    queryKey: boardInboxSummaryKey(boardId),
    queryFn: ({ signal }) => projectTaskRequest(`/api/projects/boards/${encodeURIComponent(boardId)}/inbox?summary=true`, { signal }),
    enabled: Boolean(boardId && enabled),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useBoardInbox(boardId, page = 1, enabled = true, { unreadOnly = false } = {}) {
  const queryClient = useQueryClient();
  const url = `/api/projects/boards/${encodeURIComponent(boardId)}/inbox`;
  const query = useQuery({
    queryKey: boardInboxListKey(boardId, page, unreadOnly),
    queryFn: ({ signal }) => projectTaskRequest(`${url}?page=${page}&pageSize=30${unreadOnly ? "&unread=true" : ""}`, { signal }),
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
