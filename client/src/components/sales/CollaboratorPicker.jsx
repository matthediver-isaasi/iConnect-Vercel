import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The endpoint is scoped to the manager's own primary organisation. Search is
// deliberately local: an empty search must still show all eligible colleagues.
export async function loadCollaboratorOptions(request, opportunityId, signal) {
  const members = new Map();
  const offsets = new Set();
  let offset = 0;
  while (offset !== null) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (offsets.has(offset)) throw new Error("Could not load all colleagues. Please retry.");
    offsets.add(offset);
    const page = await request(`/api/opportunities/${encodeURIComponent(opportunityId)}?resource=collaborator-options&offset=${offset}`, { signal });
    if (!Array.isArray(page?.items) || !(page.nextOffset === null || (Number.isInteger(page.nextOffset) && page.nextOffset > offset))) {
      throw new Error("Could not load colleagues. Please retry.");
    }
    page.items.forEach(member => members.set(String(member.id), member));
    offset = page.nextOffset;
  }
  return [...members.values()];
}

const memberName = member => [member.first_name, member.last_name].filter(Boolean).join(" ") || member.email || "Unnamed colleague";
const EMPTY_ITEMS = [];

export default function CollaboratorPicker({ opportunityId, items = EMPTY_ITEMS, request, onAdd, pending = false }) {
  const [options, setOptions] = useState({ opportunityId: null, items: [], loading: true, error: null });
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState({ opportunityId, id: "" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const context = useRef(opportunityId);
  context.current = opportunityId;
  const addInFlight = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSearch("");
    setSelection({ opportunityId, id: "" });
    setAddError(null);
    setOptions({ opportunityId, items: [], loading: true, error: null });
    loadCollaboratorOptions(requestRef.current, opportunityId, controller.signal)
      .then(members => { if (active) setOptions({ opportunityId, items: members, loading: false, error: null }); })
      .catch(error => { if (active) setOptions({ opportunityId, items: [], loading: false, error: error.message || "Could not load colleagues." }); });
    return () => { active = false; controller.abort(); };
  }, [opportunityId, retry]);

  const current = options.opportunityId === opportunityId;
  const loading = !current || options.loading;
  const error = current ? options.error : null;
  const available = useMemo(() => {
    // Relation row IDs are not member IDs. Legacy tenant_user rows are retained,
    // and never interpreted as member principals.
    const excluded = new Set(items.filter(item => item.principal_kind === "member").map(item => String(item.principal_id)));
    return (current ? options.items : []).filter(member => !excluded.has(String(member.id)));
  }, [items, current, options.items]);
  const visible = available.filter(member => `${memberName(member)} ${member.email || ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectedId = selection.opportunityId === opportunityId && available.some(member => String(member.id) === selection.id) ? selection.id : "";
  const disabled = loading || Boolean(error) || pending || adding;
  const add = async () => {
    if (disabled || !selectedId || addInFlight.current) return;
    addInFlight.current = true;
    setAdding(true);
    setAddError(null);
    const id = opportunityId;
    try {
      await onAdd(selectedId);
      if (context.current === id) {
        setSelection({ opportunityId: id, id: "" });
        setSearch("");
        setOptions(old => ({ ...old, items: old.items.filter(member => String(member.id) !== selectedId) }));
      }
    } catch (error) {
      if (context.current === id) setAddError(error.message || "Could not add colleague. Please try again.");
    } finally { addInFlight.current = false; setAdding(false); }
  };
  return <div className="mb-5 w-full space-y-2">
    <p className="text-sm text-slate-500">Add a colleague from your membership team.</p>
    <div className="relative">
      <Search aria-hidden="true" className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
      <Input aria-label="Search team colleagues" className="pl-9" placeholder="Search by name or email…" value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />
    </div>
    {loading ? <div role="status" className="rounded-md border bg-slate-50 p-3 text-sm text-slate-500">Loading team colleagues…<div aria-hidden="true" className="mt-2 h-4 w-2/3 animate-pulse rounded bg-slate-200" /></div>
      : error ? <div role="alert" className="rounded-md border border-rose-200 p-3 text-sm text-rose-700">{error} <Button type="button" variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></div>
        : <select aria-label="Team colleague" size={Math.min(5, Math.max(2, visible.length + 1))} className="w-full rounded-md border border-slate-200 bg-background p-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-ring" value={selectedId} disabled={disabled || !visible.length} onChange={event => setSelection({ opportunityId, id: event.target.value })}>
          <option value="">Select a team colleague</option>
          {visible.map(member => <option key={member.id} value={String(member.id)}>{memberName(member)}{member.email ? ` · ${member.email}` : ""}</option>)}
        </select>}
    {!loading && !error && !visible.length && <p role="status" className="text-sm text-slate-500">{available.length ? "No colleagues match your search." : "No colleagues available to add."}</p>}
    {addError && <p role="alert" className="text-sm text-rose-700">{addError}</p>}
    <Button type="button" disabled={disabled || !selectedId} onClick={add}><Plus aria-hidden="true" className="mr-2 h-4 w-4" />{adding || pending ? "Adding…" : "Add"}</Button>
  </div>;
}
