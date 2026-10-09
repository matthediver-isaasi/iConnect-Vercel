import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useProjectBoardRealtime } from "@/hooks/useProjectBoardRealtime";
import { apiRequest } from "@/lib/queryClient";
import { publishProjectCardUpdate } from "@/lib/projectBoardCache";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CardDetailModal from "./ProjectCardDetailModal";
import { projectTaskRequest, refreshSalesProjects } from "./useSalesProjectTasks";
import { TaskError, TaskLoading } from "./SalesProjectTaskStates";

export function useSalesProjectBoard(boardId, enabled = true) {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const canView = isAccessReady && !isFeatureExcluded("projects.board-view");
  const board = useQuery({
    queryKey: ["project-board", boardId],
    queryFn: () => projectTaskRequest(`/api/projects/boards/${boardId}`),
    enabled: Boolean(boardId && enabled && canView),
    refetchOnWindowFocus: true, refetchInterval: 45000,
  });
  useProjectBoardRealtime(canView && enabled ? boardId : null);
  const role = board.data?.board?.user_role;
  const canEdit = canView && ["owner", "admin", "member"].includes(role) && !board.data?.board?.is_archived;
  return {
    ...board, canView, canEdit,
    canManage: canEdit && ["owner", "admin"].includes(role),
    canManageLabels: canEdit && ["owner", "admin"].includes(role) && !isFeatureExcluded("projects.board-view.manage-labels"),
    canCreateLists: canEdit && !isFeatureExcluded("projects.board-view.create-lists"),
    canCreate: canEdit && !isFeatureExcluded("projects.board-view.create-cards"),
    canAssign: canEdit && !isFeatureExcluded("projects.board-view.assign-cards"),
  };
}

// Resolves the actual Projects card, never an overview DTO or a copied Sales task.
export default function SalesProjectCardEditor({ boardId, cardId, open, onOpenChange, readOnly = false }) {
  const board = useSalesProjectBoard(boardId, open);
  const detail = useQuery({
    queryKey: ["card-detail", cardId],
    queryFn: () => projectTaskRequest(`/api/projects/cards/${cardId}`),
    enabled: Boolean(open && cardId && board.canView && board.data),
    refetchOnWindowFocus: true,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (board.dataUpdatedAt) queryClient.invalidateQueries({ queryKey: ["sales-project-tasks"] });
  }, [board.dataUpdatedAt, queryClient]);
  const update = useMutation({
    mutationFn: (data) => apiRequest("PATCH", `/api/projects/cards/${cardId}`, data),
    onSuccess: async (data) => {
      await publishProjectCardUpdate(queryClient, cardId, data.card);
      void refreshSalesProjects(queryClient);
    },
  });
  const remove = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/projects/cards/${cardId}`),
    onSuccess: () => { onOpenChange(false); refreshSalesProjects(queryClient); toast.success("Card deleted"); },
    onError: (error) => toast.error(error.message || "Could not delete card"),
  });
  if (!open) return null;
  // An overview row may be beyond the board endpoint's legacy row cap.
  // Resolve the original card directly and verify it still belongs here.
  const candidate = detail.data?.card;
  const card = candidate?.board_id === boardId && !candidate.is_archived ? candidate : null;
  if (!board.canView || board.isLoading || detail.isLoading || board.error || detail.error || !card) return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Project task</DialogTitle><DialogDescription>Load the original task from its project board.</DialogDescription></DialogHeader>
    {!board.canView ? <p className="text-sm text-muted-foreground">Project Board View permission is required to open this task.</p>
      : board.isLoading || detail.isLoading ? <TaskLoading />
        : board.error || detail.error ? <TaskError error={board.error || detail.error} onRetry={() => { board.refetch(); detail.refetch(); }} />
          : <p className="text-sm text-muted-foreground">This task is archived, unavailable, or no longer on this board.</p>}
    <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
  </DialogContent></Dialog>;
  return <CardDetailModal card={card} open={open} onOpenChange={onOpenChange} boardId={boardId}
    labels={board.data?.labels} members={board.data?.members} lists={board.data?.lists}
    canEdit={board.canEdit && !readOnly} canManage={board.canManage && !readOnly} canManageLabels={board.canManageLabels && !readOnly} canAssign={board.canAssign && !readOnly}
    onUpdate={update.mutateAsync} onDelete={() => remove.mutateAsync()}
  />;
}
