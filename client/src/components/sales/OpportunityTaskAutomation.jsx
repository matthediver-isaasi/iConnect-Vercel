import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskError, TaskLoading } from "./SalesProjectTaskStates";
import { PROJECT_TASKS_URL, projectTaskRequest, refreshSalesProjects, useSalesProjectTasks } from "./useSalesProjectTasks";
import { useQuoteNaming } from "@/hooks/useSalesSettings";

export default function OpportunityTaskAutomation({ opportunityId }) {
  const naming = useQuoteNaming();
  const query = useSalesProjectTasks({ view: "automation", opportunityId }, Boolean(opportunityId));
  const queryClient = useQueryClient();
  const command = useMutation({
    mutationFn: (payload) => projectTaskRequest(PROJECT_TASKS_URL, { method: "POST", body: JSON.stringify({ opportunityId, ...payload }) }),
    onSuccess: (_, payload) => toast.success(payload.action === "automation-configure" ? "Automatic task list updated" : "Pending task retry finished"),
    // The shared root includes automation plus standard and project task views.
    onSettled: () => refreshSalesProjects(queryClient),
  });
  const data = query.data;
  const requests = data?.requests || [];
  const pending = requests.filter((request) => request.status === "pending");
  const projectPending = pending.some((request) => request.task_mode === "project");
  return <Card><CardContent className="space-y-4 p-5">
    <div><h3 className="font-semibold">Accepted {naming.singular.toLowerCase()} task automation</h3>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Enabled catalogue products create one task per product {naming.singular.toLowerCase()} line or enabled bundle component, including quantity—not one task per unit. Task settings are fixed with the issued {naming.singular.toLowerCase()}. There is no past {naming.singular.toLowerCase()} backfill and no task migration when the opportunity’s mode changes.</p>
      <p className="mt-1 text-xs text-muted-foreground">This only creates tasks. It does not send emails or perform financial actions.</p>
    </div>
    {query.isLoading ? <TaskLoading /> : query.error ? <TaskError error={query.error} onRetry={() => query.refetch()} /> : data && <>
      <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
        <p className="text-sm font-medium">{data.taskMode === "project" ? "Current mode: Project tasks" : "Current mode: Standard tasks"}</p>
        {data.taskMode === "standard" && <p className="text-sm text-muted-foreground">Standard tasks need no board configuration. You can configure the linked board below for project-mode requests.</p>}
        {!data.boardId ? <p className="text-sm text-amber-700">No project board linked. Link or create a board above and choose a list before project-mode requests can create tasks.</p>
          : <p className="text-sm text-muted-foreground">Cards are added to “{data.quoteTaskListName || "Quote tasks"}” on the linked board. This list is created automatically if needed. Its name can be changed in Sales settings.</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h4 className="text-sm font-medium">Acceptance requests</h4><p className="mt-1 text-xs text-muted-foreground">Showing {requests.length} of {data.total ?? requests.length} requests, pending first (up to 100). Pending requests retain the mode captured at acceptance.</p></div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={query.isFetching || command.isPending} onClick={() => query.refetch()}>Refresh status</Button>
          <Button size="sm" disabled={!data.canManage || !pending.length || command.isPending} onClick={() => command.mutate({ action: "automation-retry" })}>{command.isPending && command.variables?.action === "automation-retry" ? "Retrying…" : "Retry pending tasks"}</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Retry processes existing pending work only; it does not create requests for past {naming.plural.toLowerCase()}.{!data.canManage && " Only opportunity managers can retry."}{projectPending && " Project-mode retries recheck the linked board and list permissions."}</p>
      {requests.length ? <ul className="divide-y rounded-lg border">{requests.map((request) => <li key={request.id} className="space-y-1 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 break-words text-sm font-medium">{request.title}</p><Badge variant="outline" className={request.status === "pending" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-blue-200 bg-blue-50 text-blue-700"}>{request.status === "pending" ? "Pending" : "Task created"}</Badge></div>
        <p className="text-xs text-muted-foreground">Quantity: {request.quantity} · {request.task_mode === "project" ? "Project" : "Standard"} mode at acceptance</p>
        {request.last_error && request.status === "pending" && <p className="break-words text-xs text-destructive">{request.last_error}</p>}
      </li>)}</ul> : <div className="rounded-lg border border-dashed p-5"><h4 className="text-sm font-medium">No acceptance requests yet</h4><p className="mt-1 text-sm text-muted-foreground">Enable task creation on catalogue products for future issued {naming.plural.toLowerCase()}. Requests appear here when a qualifying {naming.singular.toLowerCase()} is accepted.</p></div>}
    </>}
    {command.error && <p role="alert" className="text-sm text-destructive">{command.error.message || "Could not update task automation. Refresh the status and try again."}</p>}
  </CardContent></Card>;
}
