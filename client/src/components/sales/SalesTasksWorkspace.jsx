import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ExternalLink, ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SalesProjectCardEditor from "./SalesProjectCardEditor";
import { projectTaskRequest, useSalesProjectTasks } from "./useSalesProjectTasks";
import { TaskError, TaskLoading, TaskPagination, TaskSummary } from "./SalesProjectTaskStates";

function TaskFilter({ label, value, onChange, options }) {
  return <div><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
  </Select></div>;
}

function OpportunityTaskFilter({ value, onChange }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selectedName, setSelectedName] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setDebounced(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const query = useQuery({
    queryKey: ["opportunities", "task-filter", debounced, page],
    queryFn: () => projectTaskRequest(`/api/opportunities?${new URLSearchParams({ search: debounced, page: String(page), limit: "25" })}`),
  });
  const options = Array.isArray(query.data) ? query.data : query.data?.items || query.data?.data || [];
  return <div className="space-y-1"><Label htmlFor="task-opportunity-search">Opportunity</Label>
    <Input id="task-opportunity-search" placeholder="Search opportunities" value={search} onChange={(event) => setSearch(event.target.value)} />
    <Select value={value || "all"} onValueChange={(id) => { setSelectedName(options.find((item) => item.id === id)?.name || "Selected opportunity"); onChange(id === "all" ? "" : id); }}>
      <SelectTrigger><SelectValue placeholder="All opportunities" /></SelectTrigger><SelectContent>
        <SelectItem value="all">All opportunities</SelectItem>
        {value && !options.some((item) => item.id === value) && <SelectItem value={value}>{selectedName || "Selected opportunity"}</SelectItem>}
        {options.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {query.isLoading ? <p className="text-xs text-muted-foreground">Loading opportunities…</p> : query.error ? <button className="text-xs text-destructive underline" onClick={() => query.refetch()}>Could not load opportunities. Retry</button> : !options.length ? <p className="text-xs text-muted-foreground">No opportunities match this search.</p> : null}
    <div className="flex gap-2"><button className="text-xs text-muted-foreground underline disabled:opacity-40" disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}>Previous results</button><button className="text-xs text-muted-foreground underline disabled:opacity-40" disabled={query.isFetching || page * 25 >= (query.data?.total ?? options.length)} onClick={() => setPage(page + 1)}>More results</button></div>
  </div>;
}

export function SalesTaskResults({ query, source, page, onPage, showOpportunity = true }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => { setSelected(null); }, [source]);
  if (query.isLoading) return <TaskLoading />;
  if (query.error) return <TaskError error={query.error} onRetry={() => query.refetch()} />;
  const result = query.data || {};
  const tasks = result.items || [];
  return <div className="space-y-4">
    <TaskSummary summary={result.summary} />
    {!tasks.length ? <Card><CardContent className="p-9 text-center"><ListChecks className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /><h3 className="font-semibold">No tasks match this view</h3><p className="mt-1 text-sm text-muted-foreground">Try a different source or clear your filters. Only tasks you can access are shown.</p></CardContent></Card>
      : <Card className="overflow-hidden"><div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <caption className="sr-only">Sales {source} tasks</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="p-3">Task</th>{showOpportunity && <th className="p-3">Opportunity / organisation</th>}<th className="p-3">Status</th><th className="p-3">Assigned to</th><th className="p-3">Due date</th><th className="p-3">Priority</th><th className="p-3"><span className="sr-only">Open board</span></th></tr></thead>
        <tbody>{tasks.map((task) => <tr key={task.id} className="border-t align-top hover:bg-muted/30">
          <td className="min-w-[180px] p-3"><div>
            {source === "project" ? <button className={`text-left font-medium text-blue-700 hover:underline ${task.isComplete ? "line-through" : ""}`} onClick={() => setSelected(task)}>{task.title}</button>
              : <Link className="font-medium text-blue-700 hover:underline" to={`/sales/opportunities/${task.opportunityId}?tab=tasks`}>{task.title}</Link>}
            {task.boardName && <p className="mt-1 text-xs text-muted-foreground">{task.boardName}</p>}
          </div></td>
          {showOpportunity && <td className="min-w-[170px] p-3"><Link className="text-blue-700 hover:underline" to={`/sales/opportunities/${task.opportunityId}`}>{task.opportunityName}</Link><p className="mt-1 text-xs text-muted-foreground">{task.organizationName || "No organisation"}</p></td>}
          <td className="p-3"><p>{task.status || "—"}</p><Badge variant="outline" className="mt-1 whitespace-nowrap">{task.isComplete ? "Completed" : "Outstanding"}</Badge></td>
          <td className="p-3">{task.assignees?.map((person) => person.name).join(", ") || "Unassigned"}</td>
          <td className="whitespace-nowrap p-3">{task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "No due date"}{task.overdue && <Badge variant="destructive" className="mt-1 block w-fit">Overdue</Badge>}</td>
          <td className="p-3 capitalize">{task.priority || "none"}</td>
          <td className="p-3">{source === "project" && <Link aria-label={`Open ${task.title} in project board`} to={`/ProjectBoard/${task.boardId}?card=${encodeURIComponent(task.id)}`} className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-4 w-4" /></Link>}</td>
        </tr>)}</tbody>
      </table></div></Card>}
    <TaskPagination page={page} total={result.total} pageSize={result.pageSize} onPage={onPage} />
    {selected && <SalesProjectCardEditor key={selected.id} boardId={selected.boardId} cardId={selected.id} open onOpenChange={(open) => { if (!open) setSelected(null); }} readOnly={!selected.canEdit} />}
  </div>;
}

export default function SalesTasksWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = (key, fallback = "") => searchParams.get(key) || fallback;
  const source = value("source", "project") === "standard" ? "standard" : "project";
  const scope = value("scope", "my");
  const status = value("status", "outstanding");
  const sort = value("sort", "due");
  const page = Math.max(1, Number(value("page", "1")) || 1);
  const opportunityId = value("opportunityId");
  const taskParams = { view: "tasks", source, scope, opportunityId, status, listName: value("listName"), overdue: value("overdue") || undefined, dueFrom: value("dueFrom"), dueTo: value("dueTo"), sort, page, pageSize: 25 };
  const query = useSalesProjectTasks(taskParams);
  const setFilter = (key, next) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set(key, next); else params.delete(key);
    if (key !== "page") params.delete("page");
    if (key === "source") params.delete("listName");
    setSearchParams(params);
  };
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Sales follow-ups</h2><p className="mt-1 text-sm text-muted-foreground">Project cards and standard tasks stay separate. This view follows each opportunity’s selected task mode.</p></div>
      <div className="flex gap-2" aria-label="Task source"><Button variant={source === "project" ? "default" : "outline"} aria-pressed={source === "project"} onClick={() => setFilter("source", "project")}>Project tasks</Button><Button variant={source === "standard" ? "default" : "outline"} aria-pressed={source === "standard"} onClick={() => setFilter("source", "standard")}>Standard tasks</Button></div>
    </div>
    <Card><CardContent className="space-y-4 p-4">
      <div className="grid gap-4 md:grid-cols-3">
        <TaskFilter label="Assigned to" value={scope} onChange={(next) => setFilter("scope", next)} options={[["my", "My tasks"], ["all", "All accessible tasks"]]} />
        <TaskFilter label="Completion" value={status} onChange={(next) => setFilter("status", next)} options={[["all", "All tasks"], ["outstanding", "Outstanding"], ["completed", "Completed"]]} />
        <TaskFilter label="Sort by" value={sort} onChange={(next) => setFilter("sort", next)} options={[["due", "Due date"], ["priority", "Priority"], ["opportunity", "Opportunity"]]} />
        <OpportunityTaskFilter value={opportunityId} onChange={(next) => setFilter("opportunityId", next)} />
        <div><Label htmlFor="task-list-filter">List / task status</Label><Input id="task-list-filter" className="mt-1" placeholder={source === "project" ? "Exact project list name" : "Task status"} value={value("listName")} onChange={(event) => setFilter("listName", event.target.value)} /></div>
        <div className="flex items-end"><Button className="w-full" variant={value("overdue") === "true" ? "default" : "outline"} aria-pressed={value("overdue") === "true"} onClick={() => setFilter("overdue", value("overdue") === "true" ? "" : "true")}>Overdue only</Button></div>
        <div><Label htmlFor="task-due-from">Due from</Label><Input id="task-due-from" type="date" className="mt-1" value={value("dueFrom")} onChange={(event) => setFilter("dueFrom", event.target.value)} /></div>
        <div><Label htmlFor="task-due-to">Due to</Label><Input id="task-due-to" type="date" className="mt-1" value={value("dueTo")} onChange={(event) => setFilter("dueTo", event.target.value)} /></div>
        <div className="flex items-end"><Button variant="ghost" onClick={() => setSearchParams({ source, scope: "my", status: "outstanding" })}>Clear filters</Button></div>
      </div>
    </CardContent></Card>
    <SalesTaskResults query={query} source={source} page={page} onPage={(next) => setFilter("page", next)} />
  </div>;
}
