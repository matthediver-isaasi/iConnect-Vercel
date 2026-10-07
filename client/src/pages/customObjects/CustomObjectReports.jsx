import React, { useEffect, useMemo, useState } from "react";
import "./ReportBuilder.css";
import { useMutation, useQueries } from "@tanstack/react-query";
import { Download, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import ExportReportSwitcher from "@/components/ExportReportSwitcher";
import { useSavedExportReports } from "@/hooks/useSavedExportReports";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadCustomObjectFields, relationshipRequest } from "./relationshipApi";
import { resolveRelationshipPickerPath } from "./relationshipHelpers";
import { ReportRelationshipFilters } from "./ReportRelationshipFilters";
import { ReportRelationshipSelector } from "./ReportRelationshipSelector";
import { ReportIndicatorEditor } from "./ReportIndicatorEditor";
import {
  endpointKey, endpointLabel, loadReportConfig, makeReportConfig, moveReportColumn,
  reconcileReportConfig, reportPathLabel, reportColumnSummary, reportReachableEndpoints,
} from "./reportHelpers.mjs";

const reportUrl = (objectId, action) => `/api/custom-objects/${objectId}/report-${action}`;
const startEndpoint = (objectId) => ({ kind: "custom_object", customObjectId: objectId });
const safePickerPath = (path) => Array.isArray(path) && path.every((hop) =>
  hop && typeof hop === "object" && !Array.isArray(hop)
  && hop.relationship_definition_id != null
  && ["source", "target"].includes(hop.from_side))
  ? path
  : [];
const CORE_FIELDS = {
  member: [
    { id: "full_name", label: "Full name" },
    { id: "first_name", label: "First name" },
    { id: "last_name", label: "Last name" },
    { id: "email", label: "Email" },
    { id: "organization_id", label: "Organisation ID" },
  ],
  organization: [
    { id: "name", label: "Name" },
    { id: "email", label: "Email" },
  ],
  organization_group: [
    { id: "name", label: "Name" },
  ],
};

export function CustomObjectReports({
  object,
  fields,
  definitions,
  canManage,
  initialConfig,
  savedReports: savedReportsOverride,
  onConfigChange,
}) {
  const objectId = object.id;
  const liveSaved = useSavedExportReports({
    settingKey: `custom_object_reports_${objectId}`,
    description: `Shared reports for ${object.plural_label || "a Custom Object"}`,
    enabled: Boolean(objectId) && !savedReportsOverride,
  });
  const saved = savedReportsOverride || liveSaved;
  const [config, setConfig] = useState(() =>
    initialConfig ? loadReportConfig(objectId, initialConfig) : makeReportConfig(objectId));
  const [columnPath, setColumnPath] = useState([]);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnKind, setColumnKind] = useState("field");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [exportProgress, setExportProgress] = useState(null);
  const graph = Array.isArray(definitions) ? definitions : definitions?.data || [];
  const graphLoading = definitions == null;
  const graphObjects = Array.isArray(definitions) ? [] : definitions?.objects || [];
  const configView = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const renderedColumns = Array.isArray(configView.columns)
    ? configView.columns.filter((column) =>
      column && typeof column === "object" && !Array.isArray(column))
    : [];
  const ownerEndpoint = useMemo(() => startEndpoint(objectId), [objectId]);
  const endpoints = useMemo(() => reportReachableEndpoints(graph, ownerEndpoint), [graph, ownerEndpoint]);
  const customEndpoints = endpoints.filter((item) => item.kind === "custom_object" && item.customObjectId);
  const fieldQueries = useQueries({
    queries: customEndpoints.map((endpoint) => ({
      queryKey: ["custom-object-report-fields", endpoint.customObjectId],
      queryFn: () => loadCustomObjectFields(endpoint.customObjectId, { request: relationshipRequest }),
      enabled: Boolean(endpoint.customObjectId) && String(endpoint.customObjectId) !== String(objectId),
    })),
  });
  const fieldsByEndpoint = useMemo(() => Object.fromEntries(customEndpoints.flatMap((endpoint, index) => {
    const isOwner = String(endpoint.customObjectId) === String(objectId);
    if (!isOwner && fieldQueries[index]?.isError) return [];
    const loaded = isOwner ? fields : fieldQueries[index]?.data?.data || fieldQueries[index]?.data;
    if (!Array.isArray(loaded)) return [];
    return [[
      endpointKey(endpoint),
      loaded.filter((field) => field.is_active !== false),
    ]];
  })), [customEndpoints, fieldQueries, fields, objectId]);
  const reconciled = useMemo(() => reconcileReportConfig({
    config, objectId, definitions: graph, fieldsByEndpoint, metadataLoading: graphLoading,
  }), [config, objectId, graph, fieldsByEndpoint, graphLoading]);
  const executionBlocked = graphLoading || reconciled.stale.length > 0
    || reconciled.filtersPending || reconciled.indicatorsPending || !renderedColumns.length;

  useEffect(() => {
    setConfig((current) => current == null || typeof current !== "object"
      || current.start_object_id == null
      || String(current.start_object_id) === String(objectId)
      ? current : makeReportConfig(objectId));
    setPreview(null);
  }, [objectId]);
  useEffect(() => {
    onConfigChange?.(config);
  }, [config, onConfigChange]);
  const previewMutation = useMutation({
    mutationFn: (requestedPage) => {
      if (executionBlocked) throw new Error("Resolve unavailable selections and wait for report metadata before preview.");
      return relationshipRequest(reportUrl(objectId, "preview"), {
      method: "POST",
      body: JSON.stringify({ definition: reconciled.config, page: requestedPage, pageSize: 50 }),
      });
    },
    onSuccess: (data, requestedPage) => { setPreview(data); setPage(requestedPage); },
    onError: (error) => { setPreview(null); toast.error(error.message); },
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (executionBlocked) throw new Error("Resolve unavailable selections and wait for report metadata before export.");
      const storageKey = `custom-object-report-export:${objectId}`;
      const downloadCsv = (parts, name) => {
        const blob = new Blob(parts, { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
        URL.revokeObjectURL(url);
      };
      const request = async (body) => {
        const response = await fetch(reportUrl(objectId, "export"), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || data.error || "Could not export this report.");
        return data;
      };
      const savedJobId = window.localStorage.getItem(storageKey);
      let job = savedJobId
        ? await request({ action: "status", job_id: savedJobId }).catch(() => null)
        : null;
      if (!job || ["complete", "failed"].includes(job.status)) {
        job = await request({ action: "start", definition: reconciled.config,
          name: saved.activeReport?.name || object.plural_label || "custom-object-report" });
        if (job.legacy_sync && typeof job.csv === "string") {
          downloadCsv([job.csv], job.filename || "custom-object-report.csv");
          return;
        }
        window.localStorage.setItem(storageKey, job.id);
      }
      setExportProgress(job);
      while (!["complete", "failed"].includes(job.status)) {
        const previousProcessed = job.processed;
        job = await request({ action: "process", job_id: job.id });
        setExportProgress(job);
        if (job.processed === previousProcessed) {
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      }
      if (job.status === "failed") throw new Error(job.error_message || "The export could not be completed.");
      const chunks = [];
      for (let index = 0; index < job.chunk_count; index += 1) {
        chunks.push((await request({ action: "chunk", job_id: job.id, chunk_index: index })).csv_text);
      }
      const name = job.filename || "custom-object-report.csv";
      downloadCsv(chunks, name);
      window.localStorage.removeItem(storageKey);
    },
    onSuccess: () => toast.success("Your CSV export is complete."),
    onError: (error) => toast.error(error.message),
  });
  useEffect(() => {
    if (!executionBlocked && objectId && window.localStorage.getItem(`custom-object-report-export:${objectId}`)
      && !exportMutation.isPending) exportMutation.mutate();
    // Resume a durable export once when this report screen mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, executionBlocked]);
  const apply = (report) => {
    setConfig(loadReportConfig(objectId, report.config));
    setColumnPath([]);
    setPreview(null);
  };
  const editConfig = (updater) => {
    setConfig((current) => (typeof updater === "function" ? updater(current) : updater));
    setPreview(null);
  };
  const setColumns = (updater) => editConfig((current) => ({
    ...current, columns: typeof updater === "function"
      ? updater(Array.isArray(current?.columns) ? current.columns : []) : updater,
  }));
  const isV2 = configView.version === 2;
  const selectedStart = isV2 && configView.start_endpoint
    && typeof configView.start_endpoint === "object"
    && !Array.isArray(configView.start_endpoint)
    ? configView.start_endpoint
    : ownerEndpoint;
  const selectedEndpoint = reconciled.rowEndpoint;
  const calculation = ["count_distinct", "exists_related"].includes(columnKind);
  const columnEndpoint = resolveRelationshipPickerPath({
    definitions: graph, start: calculation ? selectedEndpoint : selectedStart, path: columnPath, maxHops: 6,
  }).endpoint;
  const availableFields = columnEndpoint.kind === "custom_object"
    ? [{ id: "id", label: "ID", builtIn: true }, ...(fieldsByEndpoint[endpointKey(columnEndpoint)] || [])]
    : (CORE_FIELDS[columnEndpoint.kind] || []);
  const addColumn = (field) => setColumns((current) => [...current, {
    id: `${endpointKey(columnEndpoint)}:${field.id}:${Date.now()}`,
    kind: "field", path: columnPath,
    ...(columnEndpoint.kind === "custom_object"
      ? (field.builtIn ? { field: String(field.id) } : { field_id: String(field.id) })
      : { field: String(field.id) }),
    label: field.label,
  }]);
  const relationshipDefinition = columnPath.length
    ? graph.find((definition) => String(definition.id) === String(columnPath[columnPath.length - 1].relationship_definition_id))
    : null;
  const relationshipMetadata = relationshipDefinition?.configuration?.relationship_fields
    || relationshipDefinition?.relationship_fields || [];
  const addRelationshipColumn = (field) => setColumns((current) => [...current, {
    id: `relationship:${relationshipDefinition.id}:${field.id}:${Date.now()}`,
    kind: "relationship_field", path: columnPath,
    relationship_definition_id: String(relationshipDefinition.id),
    relationship_field_id: String(field.id), field_key: field.key, label: field.label,
  }]);
  const addCountColumn = (path) => {
    const endpoint = resolveRelationshipPickerPath({
      definitions: graph, start: selectedEndpoint, path, maxHops: 6,
    }).endpoint;
    setColumns((current) => [...current, {
      id: `count:${JSON.stringify(path)}:${Date.now()}`,
      kind: "count_distinct",
      path,
      label: `Distinct ${endpointLabel(endpoint, graphObjects, object)} count`,
    }]);
  };
  const addIndicatorColumn = () => {
    setColumns((current) => [...current, {
      id: `indicator:${globalThis.crypto?.randomUUID?.() || Date.now()}`,
      kind: "exists_related", path: columnPath, conditions: [],
      label: `Has matching ${endpointLabel(columnEndpoint, graphObjects, object)}`,
    }]);
    setAddingColumn(false);
  };
  const dirty = !saved.activeReport || JSON.stringify(saved.activeReport.config) !== JSON.stringify(config);
  const unsupportedVersion = ![1, 2].includes(configView.version);
  const rows = preview?.rows || preview?.data || [];
  const headers = preview?.headers || preview?.columns || renderedColumns.map((column) => column.label || column.field_id);

  return <div className="custom-object-report-builder min-w-0 max-w-full space-y-5 [overflow-wrap:anywhere]">
    <Card>
      <CardHeader><CardTitle className="text-lg">Shared reports</CardTitle><CardDescription>Reports are shared with other authorised administrators. Paths and fields are checked again by the server before preview or export.</CardDescription></CardHeader>
      <CardContent className="min-w-0 space-y-5">
        {canManage ? <ExportReportSwitcher reports={saved.reports} activeReportId={saved.activeReportId} isDirty={dirty} isSaving={saved.isSaving}
          onApplyReport={(report) => { saved.setActiveReportId(report.id); apply(report); }}
          onClearReport={() => saved.setActiveReportId(null)}
          onCreateReport={async (name) => { const report = await saved.createReport(name, config); saved.setActiveReportId(report.id); }}
          onUpdateReport={(report) => saved.updateReport(report.id, config)}
          onRenameReport={(report, name) => saved.renameReport(report.id, name)}
          onDeleteReport={(report) => saved.deleteReport(report.id)}
          testIdPrefix="custom-object-report" /> : <p className="text-sm text-slate-500">You can view report settings but need Custom Object management access to save shared reports.</p>}
        {reconciled.stale.length > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><TriangleAlert className="mr-2 inline h-4 w-4" />{reconciled.stale.join(" ")}{unsupportedVersion && canManage && <Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => { setConfig(makeReportConfig(objectId)); setPreview(null); saved.setActiveReportId(null); }}>Start a current-version report</Button>}</div>}
        {isV2 && <details className="min-w-0 rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Advanced: starting entity <span title={endpointLabel(selectedStart, graphObjects, object)} className="mt-1 text-xs font-normal text-slate-500 line-clamp-2">{endpointLabel(selectedStart, graphObjects, object)}</span></summary><div className="mt-3" data-testid="report-start-entity"><Label>Start entity</Label><Select disabled={!canManage || graphLoading} value={endpointKey(selectedStart)} onValueChange={(value) => {
          const endpoint = endpoints.find((item) => endpointKey(item) === value);
          if (!endpoint) return;
          editConfig((current) => ({ ...current, start_endpoint: endpoint, grain_path: [], columns: [] }));
          setColumnPath([]);
        }}><SelectTrigger aria-label="Advanced starting entity"><SelectValue /></SelectTrigger><SelectContent className="report-condition-options">
          {!endpoints.some((item) => endpointKey(item) === endpointKey(selectedStart)) && <SelectItem disabled value={endpointKey(selectedStart)}>Unavailable starting entity</SelectItem>}
          {endpoints.map((endpoint) => <SelectItem key={endpointKey(endpoint)} value={endpointKey(endpoint)}>{endpointLabel(endpoint, graphObjects, object)}</SelectItem>)}
        </SelectContent></Select><p className="mt-1 text-xs text-slate-500">Choose the owner object or a connected entity as the root for row and field paths. Changing the start clears the row selection and columns; filters are retained for review.</p></div></details>}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0" data-testid="report-row-path"><Label>One row per</Label>
            <ReportRelationshipSelector value={configView.grain_path} disabled={!canManage} metadataLoading={graphLoading}
              onChange={(grain_path) => editConfig((current) => ({ ...current, grain_path }))}
              start={selectedStart} definitions={graph} objects={graphObjects} object={object} label="One row per" />
            <p className="mt-1 text-xs text-slate-500">Values reached through to-many paths are joined with semicolons. Row-relative counts, indicators and filters follow this selection.</p>
          {isV2 && <label className="mt-3 flex items-center gap-2 text-sm"><input data-testid="report-include-empty" type="checkbox" disabled={!canManage} checked={configView.include_empty === true} onChange={(event) => editConfig((current) => ({ ...current, include_empty: event.target.checked }))} />Include starting records with no related row</label>}</div>
          <Button className="self-end" disabled={!canManage || executionBlocked || previewMutation.isPending} onClick={() => previewMutation.mutate(1)}>{previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview</Button>
        </div>
        {configView.version === 1 && <div className="rounded-md border bg-slate-50/50 p-3 text-sm text-slate-600">
          This legacy V1 report is retained unchanged. Create a new current-version report to use relationship filters; existing reports are not automatically converted.
          {canManage && <Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => {
            editConfig(makeReportConfig(objectId)); setColumnPath([]); saved.setActiveReportId(null);
          }}>Start a new current-version report</Button>}
        </div>}
        <section className="min-w-0 space-y-3" aria-label="Report columns">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><Label>Columns</Label><p className="mt-1 text-xs text-slate-500">Choose the values to show. Counts and indicators do not remove rows.</p></div>
            <Button type="button" variant="outline" disabled={!canManage} aria-expanded={addingColumn} data-testid="add-report-column"
              onClick={() => setAddingColumn(!addingColumn)}><Plus className="mr-1 h-4 w-4" />{addingColumn ? "Close column selector" : "Add column"}</Button></div>
          {addingColumn && <div className="min-w-0 space-y-3 rounded-md border bg-slate-50/50 p-3">
            <Label htmlFor="report-column-kind">What would you like to show?</Label>
            <select id="report-column-kind" data-testid="report-column-kind" className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
              value={columnKind} onChange={(event) => { setColumnKind(event.target.value); setColumnPath([]); }}>
              <option value="field">{endpointLabel(selectedStart, graphObjects, object)} fields</option>
              <option value="related_field">Related record and relationship fields</option>
              {isV2 && <option value="count_distinct">Related record count</option>}
              {isV2 && <option value="exists_related">Has matching related record · True / False</option>}
            </select>
            {columnKind !== "field" && <ReportRelationshipSelector value={columnPath} onChange={setColumnPath}
              start={calculation ? selectedEndpoint : selectedStart} definitions={graph} objects={graphObjects} object={object}
              disabled={!canManage} metadataLoading={graphLoading} allowRoot={false}
              label={calculation ? "Related records from each row" : "Related records from starting entity"} />}
            <p className="text-xs text-slate-500">{columnKind === "exists_related" ? "True when at least one related record meets every condition. Does not filter rows or change other columns." : calculation ? "Calculated for each row. All distinct linked records are counted, independently of indicator conditions." : "Field values are reached from the starting entity, not the row entity."}</p>
            {!calculation && <div><Label>Add a field</Label><div className="mt-2 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
              {availableFields.map((field) => <Button key={field.id} type="button" size="sm" variant="outline"
                className="h-auto min-h-9 whitespace-normal break-words [overflow-wrap:anywhere]" disabled={!canManage || graphLoading || (columnKind === "related_field" && !columnPath.length)}
                onClick={() => addColumn(field)}><Plus className="mr-1 h-3 w-3 shrink-0" /><span title={field.label} className="min-w-0 line-clamp-2">{field.label}</span></Button>)}
              {columnEndpoint.kind === "custom_object" && !Array.isArray(fieldsByEndpoint[endpointKey(columnEndpoint)]) && <p role="status" className="text-sm text-slate-500">Field metadata unavailable. Saved selections are preserved.</p>}
            </div></div>}
            {!calculation && relationshipMetadata.length > 0 && <div><Label>Relationship fields</Label><div className="mt-2 grid gap-2 sm:grid-cols-2">{relationshipMetadata.map((field) => <Button key={field.id || field.key} type="button" size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal break-words" disabled={!canManage || graphLoading} onClick={() => addRelationshipColumn(field)}><Plus className="mr-1 h-3 w-3 shrink-0" /><span title={field.label} className="min-w-0 line-clamp-2">{field.label}</span></Button>)}</div></div>}
            {calculation && <Button type="button" data-testid={columnKind === "exists_related" ? "add-report-indicator" : "add-report-count"}
              disabled={!canManage || graphLoading || !columnPath.length || Boolean(resolveRelationshipPickerPath({ definitions: graph, start: selectedEndpoint, path: columnPath, maxHops: 6 }).error)}
              onClick={() => { if (columnKind === "exists_related") addIndicatorColumn(); else { addCountColumn(columnPath); setAddingColumn(false); } }}>
              Add {columnKind === "exists_related" ? "indicator" : "count"}
            </Button>}
          </div>}
          {!renderedColumns.length && <p className="rounded-md border border-dashed p-4 text-sm text-slate-500">No columns yet. Add a field, count or indicator to begin.</p>}
        <div className="space-y-2">{renderedColumns.map((column, index) => {
          const pathRoot = isV2 && ["count_distinct", "exists_related"].includes(column.kind) ? selectedEndpoint : selectedStart;
          const displayPath = safePickerPath(column?.path);
          const summary = reportColumnSummary(column, { start: selectedStart, row: isV2 ? selectedEndpoint : selectedStart, definitions: graph, objects: graphObjects, object });
          return <div key={column.id || index} className="min-w-0 space-y-3 rounded border p-3 text-sm">
            <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_auto]">
            <div className="min-w-0"><Label htmlFor={`column-heading-${index}`} className="text-xs">Column heading</Label><Input id={`column-heading-${index}`} data-testid={`column-heading-${index}`} disabled={!canManage} value={column.label || ""} onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><p title={summary} className="report-column-summary mt-1 break-words text-xs text-slate-500">{summary}</p>
              <details className="mt-1 text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary><p className="break-words">{pathRoot === selectedEndpoint ? "Row-relative" : "Start-relative"} · {reportPathLabel(displayPath, graph, graphObjects, object, pathRoot)}</p></details></div>
            {isV2 && !["count_distinct", "exists_related"].includes(column.kind) ? <div className="min-w-0"><Label htmlFor={`column-empty-label-${index}`} className="text-xs">Empty label</Label><Input id={`column-empty-label-${index}`} data-testid={`column-empty-label-${index}`} disabled={!canManage} value={column.empty_label || ""} placeholder="Only when endpoint is missing" onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, empty_label: event.target.value } : item))} /><p className="mt-1 text-xs text-slate-400">Does not replace a blank field value.</p></div> : <div />}
            <div className="flex items-center"><Button type="button" size="sm" variant="ghost" aria-label={`Move column ${index + 1} up`} disabled={!canManage || index === 0} onClick={() => setColumns((items) => moveReportColumn(items, index, -1))}>↑</Button><Button type="button" size="sm" variant="ghost" aria-label={`Move column ${index + 1} down`} disabled={!canManage || index === renderedColumns.length - 1} onClick={() => setColumns((items) => moveReportColumn(items, index, 1))}>↓</Button><Button type="button" size="sm" variant="ghost" aria-label={`Remove column ${index + 1}`} disabled={!canManage} onClick={() => setColumns((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
            {isV2 && column.kind === "exists_related" && <ReportIndicatorEditor column={column} indicatorLabel={`Indicator column ${index + 1}`}
                onChange={(change) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index
                  ? { ...item, ...change } : item))}
                canManage={canManage} start={selectedEndpoint} definitions={graph} objects={graphObjects} object={object}
                fieldsByEndpoint={fieldsByEndpoint} metadataLoading={graphLoading}
                metadataError={fieldQueries.some((query) => query.isError)}
                onRetry={() => fieldQueries.filter((query) => query.isError).forEach((query) => query.refetch())} />}
          </div>;
        })}</div></section>
        {isV2 && <ReportRelationshipFilters filters={configView.filters}
          onChange={(filters) => editConfig((current) => ({ ...current, filters }))}
          canManage={canManage} start={selectedEndpoint}
          definitions={graph} objects={graphObjects} object={object} fieldsByEndpoint={fieldsByEndpoint}
          metadataLoading={graphLoading} metadataError={fieldQueries.some((query) => query.isError)}
          onRetry={() => fieldQueries.filter((query) => query.isError).forEach((query) => query.refetch())} />}
        {(graphLoading || reconciled.indicatorsPending || reconciled.filtersPending) && <p role="status" className="rounded-md border p-3 text-sm text-slate-500">Waiting for authorised relationship or field metadata. Saved selections are preserved; preview and export are blocked.</p>}
        {previewMutation.isError && <p role="alert" className="text-sm text-red-600">Preview failed: {previewMutation.error?.message}. Retry Preview after resolving the issue.</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">{exportMutation.isPending && <span className="text-sm text-slate-500">Preparing CSV… {exportProgress?.total ? `${exportProgress.processed} of ${exportProgress.total} rows` : "counting rows"}</span>}{exportMutation.isError && <span role="alert" className="text-sm text-red-600">Export failed: {exportMutation.error?.message}</span>}<Button variant="outline" disabled={!canManage || executionBlocked || exportMutation.isPending} onClick={() => exportMutation.mutate()}>{exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}Export CSV</Button></div>
      </CardContent>
    </Card>
    {preview && <Card className="min-w-0"><CardHeader><CardTitle className="text-base">Preview</CardTitle><CardDescription>{preview.total ?? 0} matching row{preview.total === 1 ? "" : "s"} · page {page}</CardDescription></CardHeader><CardContent className="min-w-0 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left">{headers.map((header, index) => <th className="p-2 font-medium" key={index}>{typeof header === "string" ? header : header.label}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr className="border-b" key={row.id || row.row_id || rowIndex}>{(Array.isArray(row) ? row : (row.values || Object.values(row))).map((value, index) => <td className="p-2" key={index}>{Array.isArray(value) ? value.join(", ") : renderedColumns[index]?.kind === "exists_related" && typeof value === "boolean" ? value ? "True" : "False" : String(value ?? "")}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="p-3 text-sm text-slate-500">No rows match this report.</p>}<div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={executionBlocked || page <= 1 || previewMutation.isPending} onClick={() => previewMutation.mutate(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={executionBlocked || (!preview.has_more && !(preview.total > page * 50)) || previewMutation.isPending} onClick={() => previewMutation.mutate(page + 1)}>Next</Button></div></CardContent></Card>}
  </div>;
}