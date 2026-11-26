import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ExternalLink, Link2, Lock, Plus } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSalesProjectBoard } from "./SalesProjectCardEditor";
import { refreshSalesProjects, useSalesProjectCommand, useSalesProjectTasks } from "./useSalesProjectTasks";
import { SalesTaskResults } from "./SalesTasksWorkspace";
import { TaskError, TaskLoading } from "./SalesProjectTaskStates";
import SalesBoardPicker from "./SalesBoardPicker";
import OpportunityTaskAutomation from "./OpportunityTaskAutomation";

function BoardLinkDialog({ opportunityId, open, onOpenChange, onLink, pending }) {
  const [board, setBoard] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setBoard(null); }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Link an existing board</DialogTitle><DialogDescription>Only eligible live boards you own or administer appear here. Linking preserves their tasks, settings and membership, including member-group boards. This can only be done once.</DialogDescription></DialogHeader>
    {open && <SalesBoardPicker opportunityId={opportunityId} value={board} onChange={setBoard} onFetchingChange={setBusy} />}
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button disabled={!board || busy || pending} onClick={() => onLink(board.id)}>Link board</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function AddProjectTaskDialog({ boardId, open, onOpenChange }) {
  const board = useSalesProjectBoard(boardId, open);
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [listId, setListId] = useState("");
  const [listName, setListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);
  useEffect(() => { if (open) { setTitle(""); setListId(""); setListName(""); setCreatingList(false); } }, [open]);
  const createList = useMutation({
    mutationFn: () => apiRequest("POST", `/api/projects/boards/${boardId}/lists`, { name: listName.trim() }),
    onSuccess: async (result) => {
      await refreshSalesProjects(queryClient);
      const createdId = result?.list?.id || result?.id;
      if (createdId) setListId(createdId);
      setListName(""); setCreatingList(false);
      toast.success("Project list created");
    },
  });
  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/projects/cards", { title: title.trim(), list_id: listId }),
    onSuccess: () => { refreshSalesProjects(queryClient); onOpenChange(false); toast.success("Project task created"); },
  });
  const lists = board.data?.lists || [];
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>Add project task</DialogTitle><DialogDescription>This creates a card on the linked project board, not a separate Sales task.</DialogDescription></DialogHeader>
    {board.isLoading ? <TaskLoading /> : board.error ? <TaskError error={board.error} onRetry={() => board.refetch()} /> : !board.canCreate ? <p className="text-sm text-muted-foreground">You do not have permission to create cards on this board.</p> : <>
      <div><Label htmlFor="sales-project-card-title">Task title</Label><Input id="sales-project-card-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></div>
      {lists.length > 0 && <div><Label>Project list</Label><Select value={listId} onValueChange={setListId}><SelectTrigger><SelectValue placeholder="Choose a list" /></SelectTrigger><SelectContent>{lists.map((list) => <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>)}</SelectContent></Select></div>}
      {(!lists.length || creatingList) ? <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
        <p className="text-sm text-muted-foreground">{!board.canCreateLists ? "This board has no available list for your task. Ask a board editor with Create Lists permission to add one." : !lists.length ? "This board has no lists yet. Create its first list, then add your task." : "Add a new list to the original project board."}</p>
        <Label htmlFor="sales-project-list-name">List name</Label><Input id="sales-project-list-name" placeholder="For example, Follow-ups" value={listName} onChange={(event) => setListName(event.target.value)} />
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={!board.canCreateLists || !listName.trim() || createList.isPending} onClick={() => createList.mutate()}>Create list</Button>{lists.length > 0 && <Button size="sm" variant="ghost" onClick={() => setCreatingList(false)}>Cancel</Button>}</div>
        {createList.error && <p role="alert" className="text-sm text-destructive">{createList.error.message}</p>}
      </div> : board.canCreateLists && <Button size="sm" variant="ghost" onClick={() => setCreatingList(true)}><Plus className="mr-2 h-4 w-4" />Create another list</Button>}
    </>}
    {create.error && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
    <DialogFooter><Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!board.canCreate || !title.trim() || !lists.some((list) => list.id === listId) || create.isPending} onClick={() => create.mutate()}>Add task</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export default function OpportunityProjectTasksPanel({ opportunityId, standardTasks }) {
  const metadata = useSalesProjectTasks({ opportunityId });
  const data = metadata.data;
  const command = useSalesProjectCommand(opportunityId, data?.expectedVersion);
  const [linkOpen, setLinkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const board = useSalesProjectBoard(data?.board?.id, Boolean(data?.taskMode === "project" && !data?.boardUnavailable && data?.permissions?.canViewBoard));
  const tasks = useSalesProjectTasks({ view: "tasks", opportunityId, source: "project", scope: "all", status, sort: "due", page, pageSize: 25 }, Boolean(data?.taskMode === "project" && data?.board && !data?.boardUnavailable && data?.permissions?.canViewBoard));
  const queryClient = useQueryClient();
  useEffect(() => {
    if (board.dataUpdatedAt) queryClient.invalidateQueries({ queryKey: ["sales-project-tasks"] });
  }, [board.dataUpdatedAt, queryClient]);
  useEffect(() => { setPage(1); }, [opportunityId, data?.taskMode, status]);
  // Only used for legacy project-mode opportunities that never had a board.
  const act = (payload) => command.mutate(payload, {
    onSuccess: () => { setLinkOpen(false); toast.success(payload.action === "create" ? "Project board created" : "Project board linked"); },
  });
  if (metadata.isLoading) return <TaskLoading />;
  if (metadata.error) return <TaskError error={metadata.error} onRetry={() => metadata.refetch()} />;
  if (!data) return null;
  const available = Boolean(data.board && !data.boardUnavailable && !data.board.is_archived && data.permissions?.canViewBoard);
  const project = data.taskMode === "project";
  return <div className="space-y-4">
    <Card><CardContent className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold">Tasks for this opportunity</h3><p className="mt-1 max-w-xl text-sm text-muted-foreground">{project ? "Tasks are managed on a project board." : "This opportunity uses standard tasks."} This was chosen when the opportunity was created and cannot be changed.</p></div>
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium"><Lock className="h-3 w-3" aria-hidden="true" />{project ? "Project board" : "Standard tasks"}</span>
      </div>
      {data.board ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3"><div><p className="text-sm font-medium">{data.board.name}</p><p className="mt-1 text-xs text-muted-foreground">{available ? project ? "Tasks are managed in Projects." : "Board retained from earlier. This opportunity uses standard tasks." : "The linked board is archived or unavailable. Its tasks have not been deleted."}</p></div>{available && <Button size="sm" variant="outline" asChild><Link to={`/ProjectBoard/${data.board.id}`}><ExternalLink className="mr-2 h-4 w-4" />Open board</Link></Button>}</div>
        : project && (data.boardUnavailable ? <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">The linked project board is not available to you. Its tasks have not been deleted.</div>
        : data.needsBoard && <div className="rounded-lg border border-dashed p-5"><h4 className="font-medium">No project board linked</h4><p className="mt-1 text-sm text-muted-foreground">This older opportunity uses project tasks but has no board. Create one or link an existing board. This can only be done once.</p>{data.permissions?.canManage && <div className="mt-4 flex flex-wrap gap-2"><Button disabled={!data.permissions?.canCreateBoard || command.isPending} onClick={() => act({ action: "create" })}><Plus className="mr-2 h-4 w-4" />Create project board</Button><Button variant="outline" disabled={command.isPending} onClick={() => setLinkOpen(true)}><Link2 className="mr-2 h-4 w-4" />Link existing board</Button></div>}</div>)}
      {command.error && <p role="alert" className="text-sm text-destructive">{[409, 412].includes(command.error.status) ? `${command.error.message || "This opportunity changed elsewhere."} The latest settings have been reloaded.` : command.error.message}</p>}
    </CardContent></Card>
    <OpportunityTaskAutomation key={opportunityId} opportunityId={opportunityId} />
    {!project ? standardTasks : available ? <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Label>Completion</Label><Select value={status} onValueChange={setStatus}><SelectTrigger className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All tasks</SelectItem><SelectItem value="outstanding">Outstanding</SelectItem><SelectItem value="completed">Completed</SelectItem></SelectContent></Select></div><Button disabled={!board.canCreate} onClick={() => setAddOpen(true)}><Plus className="mr-2 h-4 w-4" />Add project task</Button></div>
      {board.error && <TaskError error={board.error} onRetry={() => board.refetch()} />}
      <SalesTaskResults query={tasks} source="project" page={page} onPage={setPage} showOpportunity={false} />
    </> : <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">{data.board ? "Project tasks cannot be displayed because the linked board is archived or unavailable to you." : "Project tasks will appear here once a project board is linked."}</CardContent></Card>}
    {data.needsBoard && <BoardLinkDialog opportunityId={opportunityId} open={linkOpen} onOpenChange={setLinkOpen} pending={command.isPending} onLink={(boardId) => act({ action: "link", boardId })} />}
    {data.board && <AddProjectTaskDialog boardId={data.board.id} open={addOpen} onOpenChange={setAddOpen} />}
  </div>;
}
