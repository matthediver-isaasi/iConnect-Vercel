import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { useSalesProjectTasks } from "./useSalesProjectTasks";
import { TaskError, TaskLoading, TaskPagination } from "./SalesProjectTaskStates";

// Searchable, paginated list of live boards the user owns/administers that are
// not linked to any opportunity. opportunityId is optional (new opportunity).
export default function SalesBoardPicker({ opportunityId, enabled = true, value, onChange, onFetchingChange }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { if (search !== debounced) { setDebounced(search); setPage(1); onChange(null); } }, 250);
    return () => clearTimeout(timer);
  }, [search, debounced, onChange]);
  const query = useSalesProjectTasks({ view: "boards", opportunityId, search: debounced, page, pageSize: 25 }, enabled);
  const busy = query.isFetching || Boolean(query.error);
  useEffect(() => { onFetchingChange?.(busy); }, [busy, onFetchingChange]);
  return <div className="space-y-2">
    <Input aria-label="Search eligible boards" placeholder="Search boards…" value={search} onChange={(event) => setSearch(event.target.value)} />
    {query.isLoading ? <TaskLoading /> : query.error ? <TaskError error={query.error} onRetry={() => query.refetch()} />
      : query.data?.items?.length ? <div className="max-h-64 space-y-2 overflow-y-auto">{query.data.items.map((board) => <label key={board.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${value?.id === board.id ? "border-primary bg-primary/5" : ""}`}><input type="radio" name="eligible-board" checked={value?.id === board.id} onChange={() => onChange(board)} /><span>{board.name}</span></label>)}</div>
        : <div className="rounded-lg border border-dashed p-5 text-center"><p className="font-medium">No eligible boards</p><p className="mt-1 text-sm text-muted-foreground">Only live boards you own or administer that are not linked to another opportunity appear here.</p></div>}
    {!query.error && !query.isLoading && <TaskPagination page={page} total={query.data?.total} pageSize={25} onPage={(next) => { setPage(next); onChange(null); }} />}
  </div>;
}
