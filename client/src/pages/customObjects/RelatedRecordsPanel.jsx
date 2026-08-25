import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CircleAlert, Link2, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { relationshipRequest, relationshipRoutes } from "./relationshipApi";
import { applicableSidesForRecord, canEditDefinitionFrom, cardinalityLimitReached, definitionList, isDefinitionVisible, labelForSide, oppositeKindFor, relationshipPayload } from "./relationshipHelpers";

function EntityPicker({ objectId, recordId, definition, editSide, onPick, disabled }) {
  const [open, setOpen] = useState(false); const [searchInput, setSearchInput] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const endpoint = oppositeKindFor(definition, editSide);
  const query = useQuery({
    queryKey: ["relationship-entity-picker", objectId, recordId, definition.id, editSide, search, page],
    queryFn: () => relationshipRequest(relationshipRoutes.picker(objectId, { definitionId: definition.id, recordId, side: editSide, search, page, pageSize: 10 })),
    enabled: open,
  });
  useEffect(() => { if (!open) { setSearch(""); setSearchInput(""); setPage(1); } }, [open]);
  const entities = query.data?.data || []; const total = query.data?.total || 0; const pages = Math.max(1, Math.ceil(total / 10));
  return <Dialog open={open} onOpenChange={setOpen}><Button disabled={disabled} size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Add link</Button><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Add {labelForSide(definition, editSide)}</DialogTitle><DialogDescription>Choose one {endpoint.kind.replace("_", " ")} to link to this record.</DialogDescription></DialogHeader><form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}><Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search records" /><Button type="submit" variant="outline" size="icon" aria-label="Search"><Search className="h-4 w-4" /></Button></form><div className="min-h-48 rounded-md border">{query.isLoading ? <div className="grid h-48 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div> : query.error ? <div className="p-6 text-center text-sm text-rose-700">{query.error.message}</div> : !entities.length ? <div className="p-8 text-center text-sm text-slate-500">No matching records found.</div> : entities.map((entity) => <button type="button" key={entity.id} className="flex w-full items-center justify-between border-b px-4 py-3 text-left last:border-0 hover:bg-slate-50" onClick={() => { onPick(entity); setOpen(false); }}><span><span className="block font-medium text-slate-900">{entity.primary_label || entity.display_value || entity.name}</span>{entity.secondary_text && <span className="mt-0.5 block text-xs text-slate-500">{entity.secondary_text}</span>}</span><Plus className="h-4 w-4 text-slate-400" /></button>)}</div><DialogFooter className="items-center sm:justify-between"><span className="mr-auto text-xs text-slate-500">{total} available</span><div className="flex gap-2"><Button size="icon" variant="outline" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="icon" variant="outline" disabled={page >= pages} onClick={() => setPage((x) => x + 1)}><ChevronRight className="h-4 w-4" /></Button></div></DialogFooter></DialogContent></Dialog>;
}

function RelationshipPanel({ objectId, recordId, definition, editSide, canEditRecord }) {
  const qc = useQueryClient(); const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ["record-relationships", objectId, recordId, definition.id, editSide, page], queryFn: () => relationshipRequest(relationshipRoutes.edges(objectId, { recordId, definitionId: definition.id, side: editSide, page, pageSize: 10 })) });
  const edges = query.data?.data || []; const total = query.data?.total || 0; const pageSize = query.data?.pageSize || 10; const pages = Math.max(1, Math.ceil(total / pageSize));
  const editable = canEditDefinitionFrom(definition, editSide, canEditRecord); const constrained = cardinalityLimitReached(definition, editSide, total);
  const create = useMutation({
    mutationFn: (entity) => relationshipRequest(relationshipRoutes.createEdge(objectId), { method: "POST", body: JSON.stringify(relationshipPayload({ definitionId: definition.id, recordId, entityId: entity.id, editSide })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["record-relationships", objectId, recordId, definition.id] }); toast.success("Relationship added"); },
    onError: (error) => toast.error(error.status === 409 ? `This link could not be added: ${error.message}` : error.message),
  });
  const remove = useMutation({
    mutationFn: (edgeId) => relationshipRequest(relationshipRoutes.deleteEdge(objectId, edgeId), { method: "DELETE", body: JSON.stringify({ routed_side: editSide, routed_record_id: recordId }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["record-relationships", objectId, recordId, definition.id] }); toast.success("Relationship removed"); },
    onError: (error) => toast.error(error.status === 409 ? `This link changed elsewhere: ${error.message}` : error.message),
  });
  return <Card className="overflow-hidden"><CardContent className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b bg-slate-50/70 px-5 py-4"><div><div className="flex items-center gap-2"><h3 className="font-semibold text-slate-900">{labelForSide(definition, editSide)}</h3><Badge variant="outline">{total}</Badge></div><p className="mt-1 text-xs text-slate-500">{definition.cardinality?.replaceAll("_", " ")} relationship</p></div>{editable && <EntityPicker objectId={objectId} recordId={recordId} definition={definition} editSide={editSide} disabled={constrained || create.isPending} onPick={(entity) => create.mutate(entity)} />}</div>{constrained && editable && <div className="border-b bg-amber-50 px-5 py-2 text-xs text-amber-800">This side has reached its configured relationship limit.</div>}{query.isLoading ? <div className="space-y-3 p-5">{[1, 2].map((x) => <div key={x} className="h-10 animate-pulse rounded bg-slate-100" />)}</div> : query.error ? <div className="p-5 text-sm text-rose-700"><CircleAlert className="mr-2 inline h-4 w-4" />{query.error.message} <button type="button" className="ml-2 underline" onClick={() => query.refetch()}>Retry</button></div> : !edges.length ? <div className="p-7 text-center text-sm text-slate-500">No {labelForSide(definition, editSide).toLowerCase()} linked yet.</div> : <div>{edges.map((edge) => <div key={edge.relationship_id} className="group flex items-center justify-between gap-3 border-b px-5 py-3 last:border-0 hover:bg-slate-50"><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-900">{edge.related?.primary_label || "Untitled record"}</p>{edge.related?.secondary_text && <p className="truncate text-xs text-slate-500">{edge.related.secondary_text}</p>}</div>{editable && <Button variant="ghost" size="icon" className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" disabled={remove.isPending} aria-label="Remove relationship" onClick={() => { if (window.confirm(`Remove the link to ${edge.related?.primary_label || "this record"}?`)) remove.mutate(edge.relationship_id); }}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</div>)}</div>} {pages > 1 && <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-slate-500"><span>Page {page} of {pages}</span><div className="flex gap-1"><Button size="icon" variant="ghost" disabled={page === 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="icon" variant="ghost" disabled={page === pages} onClick={() => setPage((x) => x + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}</CardContent></Card>;
}

export function RelatedRecordsPanel({ objectId, recordId, object, record }) {
  const definitionsQuery = useQuery({ queryKey: ["custom-objects", objectId, "relationships"], queryFn: () => relationshipRequest(relationshipRoutes.definitions(objectId)) });
  const panels = useMemo(() => definitionList(definitionsQuery.data)
    .filter((definition) => definition.status === "active")
    .flatMap((definition) => applicableSidesForRecord(definition, "custom_object", objectId)
      .filter((side) => isDefinitionVisible(definition, side))
      .map((side) => ({ definition, side }))), [definitionsQuery.data, objectId]);
  const capabilities = record?.capabilities || object?.capabilities || object?.permissions;
  const canEditRecord = capabilities?.edit_records ?? capabilities?.can_edit_records ?? true;
  if (definitionsQuery.isLoading) return <div className="mt-6 space-y-3"><div className="h-6 w-44 animate-pulse rounded bg-slate-200" /><div className="h-36 animate-pulse rounded-lg bg-slate-100" /></div>;
  if (definitionsQuery.error) return <Card className="mt-6 border-rose-200"><CardContent className="flex gap-3 p-5 text-sm text-rose-700"><CircleAlert className="h-5 w-5 shrink-0" />Relationship panels could not be loaded. {definitionsQuery.error.message}</CardContent></Card>;
  if (!panels.length) return null;
  return <section className="mt-8 border-t pt-7"><div className="mb-4 flex items-center gap-2"><Link2 className="h-5 w-5 text-slate-500" /><h2 className="text-lg font-semibold text-slate-950">Related records</h2></div><div className="grid gap-4 lg:grid-cols-2">{panels.map(({ definition, side }) => <RelationshipPanel key={`${definition.id}-${side}`} objectId={objectId} recordId={recordId} definition={definition} editSide={side} canEditRecord={canEditRecord} />)}</div></section>;
}