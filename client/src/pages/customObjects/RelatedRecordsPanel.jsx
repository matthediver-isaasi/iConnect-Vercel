import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, CircleAlert, GripVertical, Link2, Loader2, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  loadRelationshipDefinitions,
  relationshipRequest,
  relationshipRoutes,
} from "./relationshipApi";
import { canEditDefinitionFrom, cardinalityLimitReached, contextualCreateEligibility, labelForSide, oppositeKindFor, relatedRecordPath, relationshipCreatePayload, relationshipFieldCanEdit, relationshipFieldUpdatePayload, relationshipFieldValue, relationshipFieldsForSide, relationshipLinkState, relationshipPanels, withRelationshipFieldValue } from "./relationshipHelpers";
import { ContextualRecordCreateDialog } from "./ContextualRecordCreateDialog";
import {
  compactPreviewColumns,
  relationshipCardColumnLayoutClasses,
  relationshipPickerContextColumn,
  relationshipScalarDisplayValue,
} from "./recordHelpers";
import {
  clampRelationshipColumnWidth,
  defaultRelationshipColumnState,
  moveRelationshipColumn,
  reconcileRelationshipColumnState,
  relationshipColumnDescriptors,
} from "./relationshipColumnHelpers.mjs";
import { useRelationshipTablePreferences } from "@/hooks/useRelationshipTablePreferences";
import SortableHeader, { getAriaSort } from "@/components/SortableHeader";
import { RelatedRecordsLoadingSurface } from "./RelatedRecordsLoadingSurface";

const normalizeContext = ({ context, objectId, recordId }) =>
  context || { kind: "custom_object", objectId, recordId };

const routeParams = (context, definition, side, extra = {}) => ({
  kind: context.kind,
  recordId: context.recordId,
  definitionId: definition.id,
  side,
  ...extra,
});

const routesFor = (context, definition, side) => {
  const custom = context.kind === "custom_object";
  return {
    picker: (extra) => custom
      ? relationshipRoutes.picker(context.objectId, { definitionId: definition.id, recordId: context.recordId, side, ...extra })
      : relationshipRoutes.corePicker(routeParams(context, definition, side, extra)),
    edges: (extra) => custom
      ? relationshipRoutes.edges(context.objectId, { recordId: context.recordId, definitionId: definition.id, side, ...extra })
      : relationshipRoutes.coreEdges(routeParams(context, definition, side, extra)),
    create: () => custom
      ? relationshipRoutes.createEdge(context.objectId)
      : relationshipRoutes.createCoreEdge({ ...context, definitionId: definition.id, side }),
    remove: (edgeId) => custom
      ? relationshipRoutes.deleteEdge(context.objectId, edgeId)
      : relationshipRoutes.deleteCoreEdge(edgeId, { ...context, definitionId: definition.id, side }),
    update: (edgeId) => custom
      ? relationshipRoutes.updateEdge(context.objectId, edgeId)
      : relationshipRoutes.updateCoreEdge(edgeId, { ...context, definitionId: definition.id, side }),
  };
};

export function useRelatedRecordDefinitions({
  context,
  objectId,
  recordId,
  enabled = true,
  includeArchived = false,
}) {
  const resolved = normalizeContext({ context, objectId, recordId });
  const query = useQuery({
    queryKey: ["related-record-definitions", resolved.kind, resolved.objectId, resolved.recordId, includeArchived],
    // Never inherit a global keep-previous-data policy across record identities.
    placeholderData: undefined,
    queryFn: () => resolved.kind === "custom_object"
      ? loadRelationshipDefinitions(
          resolved.objectId,
          relationshipRequest,
          100,
          includeArchived,
        )
      : relationshipRequest(relationshipRoutes.coreDefinitions(resolved)),
    enabled: enabled && Boolean(resolved.recordId) && (resolved.kind !== "custom_object" || Boolean(resolved.objectId)),
  });
  const panels = useMemo(
    () => relationshipPanels(query.data, resolved, { includeArchived }),
    [query.data, resolved.kind, resolved.objectId, includeArchived],
  );
  return { ...query, panels, context: resolved };
}

export function RelatedRecordsDefinitionState({ query }) {
  const loading = query.isPending || query.isFetching;
  return (
    <Card className="min-w-0 overflow-hidden border-slate-200 shadow-none">
      <RelatedRecordsLoadingSurface active={loading}>
        {loading ? <div aria-hidden="true" className="space-y-4 p-5"><div className="h-5 w-32 rounded bg-slate-100" /><div className="h-12 rounded bg-slate-100" /></div>
          : query.error ? <div role="alert" className="p-5 text-sm text-rose-700">Records could not be loaded. <button type="button" className="ml-2 underline" onClick={() => query.refetch()}>Retry</button></div>
            : null}
      </RelatedRecordsLoadingSurface>
    </Card>
  );
}

function EntityPicker({ context, definition, editSide, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const endpoint = oppositeKindFor(definition, editSide);
  const routes = routesFor(context, definition, editSide);
  const query = useQuery({
    queryKey: ["relationship-entity-picker", context.kind, context.objectId, context.recordId, definition.id, editSide, search, page],
    queryFn: () => relationshipRequest(routes.picker({ search, page, pageSize: 10 })),
    enabled: open,
  });
  useEffect(() => {
    if (!open) {
      setSearch("");
      setSearchInput("");
      setPage(1);
    }
  }, [open]);
  const entities = query.data?.data || [];
  const contextColumn = relationshipPickerContextColumn(definition, editSide);
  const primaryHeading = endpoint.kind === "custom_object"
    ? (query.data?.primaryColumnLabel || "Record")
    : labelForSide(definition, editSide);
  const total = query.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 10));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button disabled={disabled} size="sm" onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Add link</Button>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add {labelForSide(definition, editSide)}</DialogTitle>
          <DialogDescription>Choose one {(endpoint.kind || "record").replaceAll("_", " ")} to link to this record.</DialogDescription>
        </DialogHeader>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}>
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search records" />
          <Button type="submit" variant="outline" size="icon" aria-label="Search"><Search className="h-4 w-4" /></Button>
        </form>
        <div className="min-h-48 rounded-md border">
          {contextColumn && <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-3 border-b bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:grid"><span>{primaryHeading}</span><span>{contextColumn.label}</span><span className="sr-only">Actions</span></div>}
          {query.isLoading ? <div className="grid h-48 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
            : query.error ? <div className="p-6 text-center text-sm text-rose-700">{query.error.message}</div>
              : !entities.length ? <div className="p-8 text-center text-sm text-slate-500">No matching records found.</div>
                : entities.map((entity) => (
                  <button type="button" key={entity.id} className={contextColumn ? "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem]" : "flex w-full items-center justify-between border-b px-4 py-3 text-left last:border-0 hover:bg-slate-50"} onClick={() => { onPick(entity); setOpen(false); }}>
                    <span><span className="block font-medium text-slate-900">{entity.primary_label || entity.display_value || entity.name || "Untitled record"}</span>{entity.secondary_text && <span className="mt-0.5 block text-xs text-slate-500">{entity.secondary_text}</span>}</span>
                    {contextColumn && <span className="col-start-1 text-xs text-slate-600 sm:col-start-2 sm:text-sm"><span className="font-medium sm:hidden">{contextColumn.label}: </span>{entity.picker_context_label || "—"}</span>}
                    <Plus className="h-4 w-4 text-slate-400" />
                  </button>
                ))}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="mr-auto text-xs text-slate-500">{total} available</span>
          <div className="flex gap-2">
            <Button type="button" size="icon" variant="outline" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button type="button" size="icon" variant="outline" disabled={page >= pages} onClick={() => setPage((x) => x + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RelationshipPanel({
  context,
  record,
  definition,
  editSide,
  canEditRecord,
  includeArchived = false,
  embedded = false,
  displayMode = "columns",
  loadingOverlay = false,
}) {
  const location = useLocation();
  const linkState = relationshipLinkState(location);
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState("");
  const [sortDir, setSortDir] = useState("asc");
  const [draggedColumn, setDraggedColumn] = useState(null);
  const routes = routesFor(context, definition, editSide);
  const queryKey = ["record-relationships", context.kind, context.objectId, context.recordId, definition.id, editSide];
  const query = useQuery({
    queryKey: [...queryKey, page, sortField, sortDir],
    placeholderData: loadingOverlay
      ? (previous, previousQuery) => queryKey.every((part, index) => part === previousQuery?.queryKey[index]) ? previous : undefined
      : undefined,
    queryFn: () => relationshipRequest(routes.edges({
      page,
      pageSize: 10,
      ...(sortField ? { sortField, sortDir } : {}),
      ...(includeArchived ? { includeArchived: "true" } : {}),
    })),
  });
  const loading = loadingOverlay && (query.isPending || query.isFetching);
  const edges = query.data?.data || [];
  const previewColumns = compactPreviewColumns(
    definition,
    editSide,
    edges.flatMap((edge) => edge.related?.compact_fields || []),
  );
  const edgeFields = [
    ...relationshipFieldsForSide(definition, editSide),
    ...edges.flatMap((edge) => relationshipFieldsForSide({
      relationship_fields: edge.relationship_fields,
    }, editSide)),
  ].filter((field, index, all) =>
    all.findIndex((item) => item.id === field.id) === index);
  const endpoint = oppositeKindFor(definition, editSide);
  const descriptors = useMemo(() => relationshipColumnDescriptors({
    recordLabel: endpoint.kind === "custom_object" ? "Record" : labelForSide(definition, editSide),
    relationshipFields: edgeFields,
    previewColumns,
  }), [definition, editSide, edgeFields.map((field) => field.id).join("|"), previewColumns.map((column) => `${column.type}:${column.field_id || column.relationship_definition_id}:${column.side || ""}`).join("|")]);
  const preferences = useRelationshipTablePreferences({
    definitionId: definition.id,
    side: editSide,
    contextKind: context.kind,
    objectId: context.objectId,
    enabled: displayMode !== "cards",
  });
  const [columnState, setColumnState] = useState(() => defaultRelationshipColumnState(descriptors));
  const descriptorSignature = descriptors.map((descriptor) => descriptor.id).join("|");
  useEffect(() => {
    const reconciled = reconcileRelationshipColumnState(descriptors, preferences.preference);
    setColumnState(reconciled);
    setSortField(reconciled.sortField);
    setSortDir(reconciled.sortDir);
  }, [descriptorSignature, preferences.preference]);
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const orderedDescriptors = columnState.order
    .map((id) => descriptorById.get(id))
    .filter(Boolean);
  const total = query.data?.total || 0;
  const pageSize = query.data?.pageSize || 10;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const editPermission = canEditRecord ??
    (context.kind === "custom_object" ? true : definition.can_edit === true);
  const editable = !includeArchived
    && definition.status !== "archived"
    && canEditDefinitionFrom(definition, editSide, editPermission);
  const constrained = cardinalityLimitReached(definition, editSide, total);
  const oppositeObject = useQuery({
    queryKey: ["custom-objects", endpoint.customObjectId],
    queryFn: () => relationshipRequest(`/api/custom-objects/${endpoint.customObjectId}`),
    enabled: editable && endpoint.kind === "custom_object" && Boolean(endpoint.customObjectId),
  });
  const contextualCreate = contextualCreateEligibility({
    definition,
    side: editSide,
    object: oppositeObject.data,
  });
  const resolvedDisplayMode = displayMode === "cards" ? "cards" : "columns";
  const create = useMutation({
    mutationFn: (entity) => relationshipRequest(routes.create(), {
      method: "POST",
      body: JSON.stringify({
        ...relationshipCreatePayload({
          contextKind: context.kind,
          definitionId: definition.id,
          recordId: context.recordId,
          entityId: entity.id,
          editSide,
        }),
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["related-record-definitions", context.kind, context.objectId, context.recordId] });
      toast.success("Relationship added");
    },
    onError: (error) => toast.error(error.status === 409 ? `This link could not be added: ${error.message}` : error.message),
  });
  const remove = useMutation({
    mutationFn: (edgeId) => relationshipRequest(routes.remove(edgeId), {
      method: "DELETE",
      body: JSON.stringify({ routed_side: editSide, routed_record_id: context.recordId }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["related-record-definitions", context.kind, context.objectId, context.recordId] });
      toast.success("Relationship removed");
    },
    onError: (error) => toast.error(error.status === 409 ? `This link changed elsewhere: ${error.message}` : error.message),
  });
  const updateEdgeField = useMutation({
    mutationFn: ({ edge, field, value }) => relationshipRequest(
      routes.update(edge.relationship_id),
      {
        method: "PATCH",
        body: JSON.stringify(relationshipFieldUpdatePayload({
          field,
          value,
          side: editSide,
          recordId: context.recordId,
        })),
      },
    ),
    onMutate: async ({ edge, field, value }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueriesData({ queryKey });
      qc.setQueriesData({ queryKey }, (payload) => {
        if (!payload) return payload;
        const updateEdges = (items) => (items || []).map((item) =>
          String(item.relationship_id) === String(edge.relationship_id)
            ? withRelationshipFieldValue(item, field, value)
            : item);
        return Array.isArray(payload)
          ? updateEdges(payload)
          : { ...payload, data: updateEdges(payload.data) };
      });
      return { previous };
    },
    onError: (error, _variables, mutationContext) => {
      for (const [key, value] of mutationContext?.previous || []) qc.setQueryData(key, value);
      toast.error(error.status === 409
        ? `This relationship changed elsewhere: ${error.message}`
        : `Relationship field could not be saved: ${error.message}`);
    },
    onSuccess: () => toast.success("Relationship field saved"),
    onSettled: () => {
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ["related-record-definitions", context.kind, context.objectId, context.recordId] });
    },
  });
  const renderEdgeField = (edge, field) => {
    const value = relationshipFieldValue(edge, field);
    const canEdit = relationshipFieldCanEdit({
      field,
      side: editSide,
      editable: editable && definition.status === "active",
      edge,
    });
    const pending = updateEdgeField.isPending
      && String(updateEdgeField.variables?.edge?.relationship_id) === String(edge.relationship_id)
      && updateEdgeField.variables?.field?.id === field.id;
    const controlId = `relationship-${edge.relationship_id}-field-${field.id}`;
    if (!canEdit) return <span aria-label={`${field.label}: ${value ? "Yes" : "No"}`}>{value ? "Yes" : "No"}</span>;
    return (
      <div className="flex items-center gap-2">
        <Switch
          id={controlId}
          checked={value}
          disabled={pending}
          aria-label={`${field.label} for this relationship`}
          aria-busy={pending}
          onCheckedChange={(checked) => updateEdgeField.mutate({ edge, field, value: checked })}
        />
        <label htmlFor={controlId} className="text-xs text-slate-500">{value ? "Yes" : "No"}</label>
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-label="Saving relationship field" />}
      </div>
    );
  };
  const persistColumnState = (next) => {
    setColumnState(next);
    setSortField(next.sortField || "");
    setSortDir(next.sortDir === "desc" ? "desc" : "asc");
    void preferences.save(next).catch((error) =>
      toast.error(`Column settings could not be saved: ${error.message}`));
  };
  const reorderColumn = (id, direction) => {
    const next = {
      ...columnState,
      order: moveRelationshipColumn(columnState.order, id, direction),
    };
    if (next.order.join("|") !== columnState.order.join("|")) persistColumnState(next);
  };
  const dropColumn = (targetId) => {
    if (!draggedColumn || draggedColumn === targetId) return setDraggedColumn(null);
    const without = columnState.order.filter((id) => id !== draggedColumn);
    const targetIndex = without.indexOf(targetId);
    without.splice(targetIndex < 0 ? without.length : targetIndex, 0, draggedColumn);
    persistColumnState({ ...columnState, order: without });
    setDraggedColumn(null);
  };
  const beginResize = (event, descriptor) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnState.widths[descriptor.id] || descriptor.defaultWidth;
    const onMove = (moveEvent) => {
      const width = clampRelationshipColumnWidth(startWidth + moveEvent.clientX - startX);
      setColumnState((current) => ({
        ...current,
        widths: { ...current.widths, [descriptor.id]: width },
      }));
    };
    const onUp = (upEvent) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const width = clampRelationshipColumnWidth(startWidth + upEvent.clientX - startX);
      persistColumnState({
        ...columnState,
        widths: { ...columnState.widths, [descriptor.id]: width },
      });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };
  const handleSort = (field) => {
    setPage(1);
    const nextDir = sortField === field && sortDir === "asc" ? "desc" : "asc";
    persistColumnState({ ...columnState, sortField: field, sortDir: nextDir });
  };
  const resizeColumnBy = (descriptor, delta) => {
    persistColumnState({
      ...columnState,
      widths: {
        ...columnState.widths,
        [descriptor.id]: clampRelationshipColumnWidth(
          (columnState.widths[descriptor.id] || descriptor.defaultWidth) + delta,
        ),
      },
    });
  };
  const relatedFor = (edge) => ({
    kind: edge.related_kind,
    custom_object_id: edge.related_custom_object_id,
    record_id: edge.related_record_id,
    ...(edge.related || {}),
  });
  const previewValue = (related, descriptor) => {
    if (descriptor.kind === "compact_scalar")
      return related.compact_fields?.find((item) =>
        String(item.field_id) === descriptor.fieldId)?.value;
    if (descriptor.kind === "relationship_preview")
      return related.relationship_columns?.filter((item) =>
        String(item.relationship_definition_id) === descriptor.relationshipDefinitionId
        && item.side === descriptor.side) || [];
    return null;
  };
  const renderPreviewValue = (value) => Array.isArray(value)
    ? value.length
      ? value.map((item, index) => {
          const valuePath = relatedRecordPath(item.value);
          return <React.Fragment key={`${item.value.id}-${index}`}>{index > 0 && ", "}{valuePath ? <Link to={valuePath} state={linkState} className="hover:underline">{item.value.primary_label}</Link> : item.value.primary_label}</React.Fragment>;
        })
      : "—"
    : relationshipScalarDisplayValue(value);
  return (
    <Card className={embedded ? "min-w-0 overflow-hidden border-slate-200 shadow-none" : "min-w-0 overflow-hidden"}>
      <RelatedRecordsLoadingSurface enabled={loadingOverlay} active={loading}>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-slate-50/70 px-5 py-4">
          <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">{labelForSide(definition, editSide)}</h3>{(!loadingOverlay || (!loading && !query.error)) && <Badge variant="outline">{total}</Badge>}{definition.status === "archived" && <Badge variant="outline">Archived definition</Badge>}</div><p className="mt-1 text-xs text-slate-500">{definition.cardinality?.replaceAll("_", " ")} relationship{includeArchived ? " history" : ""}</p></div>
          {editable && <div className="flex gap-2"><EntityPicker context={context} definition={definition} editSide={editSide} disabled={constrained || create.isPending} onPick={(entity) => create.mutate(entity)} />{contextualCreate && <ContextualRecordCreateDialog originContext={context} originRecord={record} originDefinition={definition} originSide={editSide} targetObject={oppositeObject.data} disabled={constrained} />}</div>}
        </div>
        {constrained && editable && <div className="border-b bg-amber-50 px-5 py-2 text-xs text-amber-800">This side has reached its configured relationship limit.</div>}
        {(query.isLoading || (loading && !edges.length)) ? <div aria-hidden="true" className="space-y-3 p-5">{[1, 2].map((x) => <div key={x} className="h-10 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />)}</div>
          : query.error && !loading ? <div role="alert" className="p-5 text-sm text-rose-700"><CircleAlert className="mr-2 inline h-4 w-4" />{query.error.message} <button type="button" className="ml-2 underline" onClick={() => query.refetch()}>Retry</button></div>
            : !edges.length ? <div className="p-7 text-center text-sm text-slate-500">No {labelForSide(definition, editSide).toLowerCase()} linked yet.</div>
              : <div className={resolvedDisplayMode === "columns" ? "overflow-x-auto" : ""}>{resolvedDisplayMode === "columns" && <>
                <div className="flex justify-end border-b px-3 py-2">
                  {preferences.error && <span role="alert" className="mr-auto self-center text-xs text-rose-700">Column settings could not be loaded: {preferences.error.message}</span>}
                  {preferences.canPersist && <Button type="button" size="sm" variant="ghost" disabled={preferences.isSaving} onClick={() => persistColumnState(defaultRelationshipColumnState(descriptors))}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" />Reset columns
                  </Button>}
                </div>
                <table
                  className={relationshipCardColumnLayoutClasses.table}
                  style={{
                    width: orderedDescriptors.reduce((sum, descriptor) =>
                      sum + (columnState.widths[descriptor.id] || descriptor.defaultWidth), 64),
                    minWidth: "100%",
                  }}
                >
                  <thead><tr className="border-b bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {orderedDescriptors.map((descriptor, index) => <th
                      key={descriptor.id}
                      draggable={preferences.canPersist}
                      onDragStart={() => setDraggedColumn(descriptor.id)}
                      onDragEnd={() => setDraggedColumn(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => dropColumn(descriptor.id)}
                      aria-sort={getAriaSort(descriptor.sortField, sortField, sortDir)}
                      className="relative px-2 py-2"
                      style={{ width: columnState.widths[descriptor.id] }}
                    >
                      <div className="flex items-center gap-1">
                        {preferences.canPersist && <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab opacity-50" aria-hidden="true" />}
                        <SortableHeader field={descriptor.sortField} sortField={sortField} sortDir={sortDir} onSort={handleSort}>{descriptor.label}</SortableHeader>
                        {preferences.canPersist && <span className="ml-auto flex shrink-0">
                          <button type="button" className="rounded p-1 hover:bg-slate-200 disabled:opacity-30" disabled={index === 0} onClick={() => reorderColumn(descriptor.id, -1)} aria-label={`Move ${descriptor.label} left`}><ArrowLeft className="h-3 w-3" /></button>
                          <button type="button" className="rounded p-1 hover:bg-slate-200 disabled:opacity-30" disabled={index === orderedDescriptors.length - 1} onClick={() => reorderColumn(descriptor.id, 1)} aria-label={`Move ${descriptor.label} right`}><ArrowRight className="h-3 w-3" /></button>
                        </span>}
                      </div>
                      {preferences.canPersist && <button
                        type="button"
                        role="slider"
                        className="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none border-r border-transparent hover:border-slate-400 focus:border-slate-500"
                        onPointerDown={(event) => beginResize(event, descriptor)}
                        onKeyDown={(event) => {
                          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                          event.preventDefault();
                          if (event.key === "ArrowLeft") resizeColumnBy(descriptor, -10);
                          else if (event.key === "ArrowRight") resizeColumnBy(descriptor, 10);
                          else resizeColumnBy(
                            descriptor,
                            event.key === "Home" ? -10000 : 10000,
                          );
                        }}
                        aria-label={`Resize ${descriptor.label} column`}
                        aria-valuemin="120"
                        aria-valuemax="480"
                        aria-valuenow={columnState.widths[descriptor.id]}
                        aria-orientation="horizontal"
                      />}
                    </th>)}
                    <th className="w-16 px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr></thead>
                  <tbody>{edges.map((edge) => {
                    const related = relatedFor(edge);
                    const path = relatedRecordPath(related);
                    const label = related.primary_label || "Untitled record";
                    const text = <><p className="truncate text-sm font-medium text-slate-900">{label}</p>{!previewColumns.length && related.secondary_text && <p className="truncate text-xs text-slate-500">{related.secondary_text}</p>}</>;
                    const primary = path ? <Link to={path} state={linkState} className="min-w-0 hover:underline">{text}</Link> : <div className="min-w-0">{text}</div>;
                    return <tr key={edge.relationship_id} className="group border-b last:border-0 hover:bg-slate-50">
                      {orderedDescriptors.map((descriptor) => <td key={descriptor.id} className="px-4 py-3 align-top text-sm text-slate-700">
                        {descriptor.kind === "record"
                          ? <>{primary}{edge.archived_at && <Badge variant="outline" className="mt-2">Archived link</Badge>}</>
                          : descriptor.kind === "relationship_boolean"
                            ? renderEdgeField(edge, edgeFields.find((field) => String(field.id) === descriptor.fieldId))
                            : renderPreviewValue(previewValue(related, descriptor))}
                      </td>)}
                      <td className="px-4 py-2 text-right align-top">{editable && <Button variant="ghost" size="icon" className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" disabled={remove.isPending} aria-label="Remove relationship" onClick={() => { if (window.confirm(`Remove the link to ${label}?`)) remove.mutate(edge.relationship_id); }}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </>}{resolvedDisplayMode === "cards" && <div className={relationshipCardColumnLayoutClasses.cardGrid}>{edges.map((edge) => {
                 const related = { kind: edge.related_kind, custom_object_id: edge.related_custom_object_id, record_id: edge.related_record_id, ...(edge.related || {}) };
                 const path = relatedRecordPath(related);
                 const label = related.primary_label || "Untitled record";
                 const primary = path ? <Link to={path} state={linkState} className="font-semibold text-slate-900 hover:underline">{label}</Link> : <span className="font-semibold text-slate-900">{label}</span>;
                 const values = previewColumns.map((column) => column.type === "field"
                   ? related.compact_fields?.find((item) => String(item.field_id) === column.field_id)?.value
                   : related.relationship_columns?.filter((item) => String(item.relationship_definition_id) === column.relationship_definition_id && item.side === column.side) || []);
                  return <article key={edge.relationship_id} className={relationshipCardColumnLayoutClasses.card}><div className="flex items-start justify-between gap-3"><div className="min-w-0">{primary}{edge.archived_at && <Badge variant="outline" className="mt-2 block w-fit">Archived link</Badge>}</div>{editable && <Button variant="ghost" size="icon" className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" disabled={remove.isPending} aria-label="Remove relationship" onClick={() => { if (window.confirm(`Remove the link to ${label}?`)) remove.mutate(edge.relationship_id); }}><Trash2 className="h-4 w-4 text-rose-600" /></Button>}</div>{(edgeFields.length > 0 || previewColumns.length > 0) && <dl className="mt-4 space-y-3">{edgeFields.map((field) => <div key={`edge-field-${field.id}`}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field.label}</dt><dd className="mt-1 text-sm text-slate-700">{renderEdgeField(edge, field)}</dd></div>)}{previewColumns.map((column, index) => <div key={`${column.type}-${column.field_id || column.relationship_definition_id}-${index}`}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{column.label}</dt><dd className="mt-1 text-sm text-slate-700">{Array.isArray(values[index]) ? values[index].length ? values[index].map((item, valueIndex) => { const valuePath = relatedRecordPath(item.value); return <React.Fragment key={`${item.value.id}-${valueIndex}`}>{valueIndex > 0 && ", "}{valuePath ? <Link to={valuePath} state={linkState} className="hover:underline">{item.value.primary_label}</Link> : item.value.primary_label}</React.Fragment>; }) : "—" : relationshipScalarDisplayValue(values[index])}</dd></div>)}</dl>}</article>;
               })}</div>}</div>}
        {pages > 1 && <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-slate-500"><span>Page {page} of {pages}</span><div className="flex gap-1"><Button size="icon" variant="ghost" disabled={page === 1} onClick={() => setPage((x) => x - 1)}><ChevronLeft className="h-4 w-4" /></Button><Button size="icon" variant="ghost" disabled={page === pages} onClick={() => setPage((x) => x + 1)}><ChevronRight className="h-4 w-4" /></Button></div></div>}
      </CardContent>
      </RelatedRecordsLoadingSurface>
    </Card>
  );
}

export function RelatedRecordsPanel({ context, objectId, recordId, object, record, definition, side, showHeading = true, embedded = false, displayMode = "columns", loadingOverlay = false }) {
  const resolved = normalizeContext({ context, objectId, recordId });
  const includeArchived = resolved.kind === "custom_object"
    && Boolean(record?.archived_at || object?.status === "archived");
  const definitionsQuery = useRelatedRecordDefinitions({
    context: resolved,
    enabled: !definition,
    includeArchived,
  });
  const panels = definition ? [{ definition, side }] : definitionsQuery.panels;
  const capabilities = record?.capabilities || object?.capabilities || object?.permissions;
  const explicitPermission = capabilities?.edit_records ?? capabilities?.can_edit_records;
  const canEditRecord = explicitPermission ?? (resolved.kind === "custom_object" ? true : undefined);
  if (loadingOverlay && !definition && (definitionsQuery.isPending || definitionsQuery.error)) return <RelatedRecordsDefinitionState query={definitionsQuery} />;
  if (!definition && definitionsQuery.isLoading) return <div className="mt-6 space-y-3"><div className="h-6 w-44 animate-pulse rounded bg-slate-200" /><div className="h-36 animate-pulse rounded-lg bg-slate-100" /></div>;
  if (!definition && definitionsQuery.error) return <Card className="mt-6 border-rose-200"><CardContent className="flex gap-3 p-5 text-sm text-rose-700"><CircleAlert className="h-5 w-5 shrink-0" />Relationship panels could not be loaded. {definitionsQuery.error.message}</CardContent></Card>;
  if (!panels.length) return null;
  return <section className={`min-w-0 ${showHeading ? "mt-8 border-t pt-7" : ""}`}>{showHeading && <div className="mb-4 flex items-center gap-2"><Link2 className="h-5 w-5 text-slate-500" /><h2 className="text-lg font-semibold text-slate-950">{includeArchived ? "Relationship history" : "Related records"}</h2></div>}<div className={embedded ? "grid min-w-0 gap-4" : "grid min-w-0 gap-4 lg:grid-cols-2"}>{panels.map((panel) => <RelationshipPanel key={`${resolved.kind}-${resolved.objectId}-${resolved.recordId}-${includeArchived}-${panel.definition.id}-${panel.side}`} context={resolved} record={record} definition={panel.definition} editSide={panel.side} canEditRecord={canEditRecord} includeArchived={includeArchived} embedded={embedded} displayMode={displayMode} loadingOverlay={loadingOverlay} />)}</div></section>;
}