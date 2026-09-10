import React, { useEffect, useMemo, useState } from "react";
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
import {
  endpointKey, endpointLabel, loadReportConfig, makeReportConfig, moveReportColumn,
  reconcileReportConfig, reportPathLabel,
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
const allPaths = (definitions, start) => {
  const result = [[]];
  const visit = (path) => {
    const resolved = resolveRelationshipPickerPath({
      definitions, start, path, maxHops: 6,
    });
    resolved.options.forEach(({ definition, from_side }) => {
      const next = [...path, { relationship_definition_id: String(definition.id), from_side }];
      result.push(next);
      visit(next);
    });
  };
  visit([]);
  return result;
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
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [exportProgress, setExportProgress] = useState(null);
  const graph = Array.isArray(definitions) ? definitions : definitions?.data || [];
  const graphObjects = Array.isArray(definitions) ? [] : definitions?.objects || [];
  const configView = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const renderedColumns = Array.isArray(configView.columns)
    ? configView.columns.filter((column) =>
      column && typeof column === "object" && !Array.isArray(column))
    : [];
  const ownerEndpoint = useMemo(() => startEndpoint(objectId), [objectId]);
  const ownerPaths = useMemo(() => allPaths(graph, ownerEndpoint), [graph, ownerEndpoint]);
  const endpoints = useMemo(() => {
    const unique = new Map();
    ownerPaths.forEach((path) => {
      const endpoint = resolveRelationshipPickerPath({
        definitions: graph, start: ownerEndpoint, path, maxHops: 6,
      }).endpoint;
      unique.set(endpointKey(endpoint), endpoint);
    });
    return [...unique.values()];
  }, [ownerPaths, graph, ownerEndpoint]);
  const customEndpoints = endpoints.filter((item) => item.kind === "custom_object" && item.customObjectId);
  const fieldQueries = useQueries({
    queries: customEndpoints.map((endpoint) => ({
      queryKey: ["custom-object-report-fields", endpoint.customObjectId],
      queryFn: () => loadCustomObjectFields(endpoint.customObjectId, { request: relationshipRequest }),
      enabled: Boolean(endpoint.customObjectId),
    })),
  });
  const fieldsByEndpoint = useMemo(() => Object.fromEntries(customEndpoints.map((endpoint, index) => [
    endpointKey(endpoint),
    String(endpoint.customObjectId) === String(objectId)
      ? fields.filter((field) => field.is_active !== false)
      : ((fieldQueries[index]?.data?.data || fieldQueries[index]?.data || []).filter((field) => field.is_active !== false)),
  ])), [customEndpoints, fieldQueries, fields, objectId]);
  const reconciled = useMemo(() => reconcileReportConfig({
    config, objectId, definitions: graph, fieldsByEndpoint,
  }), [config, objectId, graph, fieldsByEndpoint]);

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
    mutationFn: (requestedPage) => relationshipRequest(reportUrl(objectId, "preview"), {
      method: "POST",
      body: JSON.stringify({ definition: reconciled.config, page: requestedPage, pageSize: 50 }),
    }),
    onSuccess: (data, requestedPage) => { setPreview(data); setPage(requestedPage); },
    onError: (error) => toast.error(error.message),
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
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
    if (objectId && window.localStorage.getItem(`custom-object-report-export:${objectId}`)
      && !exportMutation.isPending) exportMutation.mutate();
    // Resume a durable export once when this report screen mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId]);
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
  const paths = useMemo(() => allPaths(graph, selectedStart), [graph, selectedStart]);
  const selectedPath = safePickerPath(configView.grain_path);
  const selectedEndpoint = reconciled.rowEndpoint;
  const countPaths = useMemo(
    () => allPaths(graph, selectedEndpoint).filter((path) => path.length),
    [graph, selectedEndpoint],
  );
  const columnEndpoint = resolveRelationshipPickerPath({
    definitions: graph, start: selectedStart, path: columnPath, maxHops: 6,
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
  const dirty = !saved.activeReport || JSON.stringify(saved.activeReport.config) !== JSON.stringify(config);
  const unsupportedVersion = ![1, 2].includes(configView.version);
  const rows = preview?.rows || preview?.data || [];
  const headers = preview?.headers || preview?.columns || renderedColumns.map((column) => column.label || column.field_id);

  return <div className="space-y-5">
    <Card>
      <CardHeader><CardTitle className="text-lg">Shared reports</CardTitle><CardDescription>Reports are shared with other authorised administrators. Paths and fields are checked again by the server before preview or export.</CardDescription></CardHeader>
      <CardContent className="space-y-5">
        {canManage ? <ExportReportSwitcher reports={saved.reports} activeReportId={saved.activeReportId} isDirty={dirty} isSaving={saved.isSaving}
          onApplyReport={(report) => { saved.setActiveReportId(report.id); apply(report); }}
          onClearReport={() => saved.setActiveReportId(null)}
          onCreateReport={async (name) => { const report = await saved.createReport(name, config); saved.setActiveReportId(report.id); }}
          onUpdateReport={(report) => saved.updateReport(report.id, config)}
          onRenameReport={(report, name) => saved.renameReport(report.id, name)}
          onDeleteReport={(report) => saved.deleteReport(report.id)}
          testIdPrefix="custom-object-report" /> : <p className="text-sm text-slate-500">You can view report settings but need Custom Object management access to save shared reports.</p>}
        {reconciled.stale.length > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><TriangleAlert className="mr-2 inline h-4 w-4" />{reconciled.stale.join(" ")}{unsupportedVersion && canManage && <Button type="button" size="sm" variant="outline" className="ml-3" onClick={() => { setConfig(makeReportConfig(objectId)); setPreview(null); saved.setActiveReportId(null); }}>Start a current-version report</Button>}</div>}
        {isV2 && <div data-testid="report-start-entity"><Label>Start entity</Label><Select disabled={!canManage} value={endpointKey(selectedStart)} onValueChange={(value) => {
          const endpoint = endpoints.find((item) => endpointKey(item) === value);
          if (!endpoint) return;
          editConfig((current) => ({ ...current, start_endpoint: endpoint, grain_path: [], columns: [] }));
          setColumnPath([]);
        }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
          {!endpoints.some((item) => endpointKey(item) === endpointKey(selectedStart)) && <SelectItem disabled value={endpointKey(selectedStart)}>Unavailable starting entity</SelectItem>}
          {endpoints.map((endpoint) => <SelectItem key={endpointKey(endpoint)} value={endpointKey(endpoint)}>{endpointLabel(endpoint, graphObjects, object)}</SelectItem>)}
        </SelectContent></Select><p className="mt-1 text-xs text-slate-500">Choose the owner object or a connected entity as the root for row and field paths.</p></div>}
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <div data-testid="report-row-path"><Label>Related row path</Label><Select disabled={!canManage} value={JSON.stringify(selectedPath)} onValueChange={(value) => editConfig((current) => ({ ...current, grain_path: JSON.parse(value) }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
            {!paths.some((path) => JSON.stringify(path) === JSON.stringify(selectedPath)) && <SelectItem disabled value={JSON.stringify(selectedPath)}>Unavailable saved row path</SelectItem>}
            {paths.map((path) => <SelectItem key={JSON.stringify(path)} value={JSON.stringify(path)}>{reportPathLabel(path, graph, graphObjects, object, selectedStart)}</SelectItem>)}
          </SelectContent></Select><p className="mt-1 text-xs text-slate-500">One row per {endpointLabel(selectedEndpoint, graphObjects, object)}. Values reached through to-many paths are joined with semicolons.</p>
          {isV2 && <label className="mt-3 flex items-center gap-2 text-sm"><input data-testid="report-include-empty" type="checkbox" disabled={!canManage} checked={configView.include_empty === true} onChange={(event) => editConfig((current) => ({ ...current, include_empty: event.target.checked }))} />Include starting records with no related row</label>}</div>
          <Button className="self-end" disabled={!canManage || reconciled.stale.length > 0 || !renderedColumns.length || previewMutation.isPending} onClick={() => previewMutation.mutate(1)}>{previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview</Button>
        </div>
        <div className="grid gap-3 rounded-md border bg-slate-50/50 p-3">
          <div><Label>Field path (from start entity)</Label><Select disabled={!canManage} value={JSON.stringify(columnPath)} onValueChange={(value) => setColumnPath(JSON.parse(value))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{paths.map((path) => <SelectItem key={JSON.stringify(path)} value={JSON.stringify(path)}>{reportPathLabel(path, graph, graphObjects, object, selectedStart)}</SelectItem>)}</SelectContent></Select><p className="mt-1 text-xs text-slate-500">Field paths are relative to the selected start entity.</p></div>
          <div><Label>Add a field from this path</Label><div className="mt-2 flex flex-wrap gap-2">{availableFields.length ? availableFields.map((field) => <Button key={field.id} type="button" size="sm" variant="outline" disabled={!canManage} onClick={() => addColumn(field)}><Plus className="mr-1 h-3 w-3" />{field.label}</Button>) : <p className="text-sm text-slate-500">No selectable fields are available on this endpoint.</p>}</div></div>
          {relationshipMetadata.length > 0 && <div><Label>Relationship fields</Label><div className="mt-2 flex flex-wrap gap-2">{relationshipMetadata.map((field) => <Button key={field.id || field.key} type="button" size="sm" variant="outline" disabled={!canManage} onClick={() => addRelationshipColumn(field)}><Plus className="mr-1 h-3 w-3" />{field.label}</Button>)}</div></div>}
          {isV2 && <div data-testid="report-distinct-counts"><Label>Distinct counts (from row entity)</Label><p className="mt-1 text-xs text-slate-500">Count distinct related records reached from each actual row endpoint.</p><div className="mt-2 flex flex-wrap gap-2">{countPaths.map((path) => <Button data-testid={`add-count-${path[path.length - 1].relationship_definition_id}`} key={JSON.stringify(path)} type="button" size="sm" variant="outline" disabled={!canManage} onClick={() => addCountColumn(path)}><Plus className="mr-1 h-3 w-3" />{reportPathLabel(path, graph, graphObjects, object, selectedEndpoint)}</Button>)}</div></div>}
        </div>
        <div className="space-y-2">{renderedColumns.map((column, index) => {
          const pathRoot = isV2 && column.kind === "count_distinct" ? selectedEndpoint : selectedStart;
          const displayPath = safePickerPath(column?.path);
          return <div key={column.id || index} className="grid gap-2 rounded border p-2 text-sm md:grid-cols-[minmax(10rem,1fr)_minmax(9rem,0.7fr)_auto]">
            <div><Label className="text-xs">Column heading</Label><Input data-testid={`column-heading-${index}`} disabled={!canManage} value={column.label || ""} onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><p className="mt-1 truncate text-xs text-slate-400">{column.kind === "count_distinct" ? "Distinct count · row-relative: " : "Field · start-relative: "}{reportPathLabel(displayPath, graph, graphObjects, object, pathRoot)}</p></div>
            {isV2 && column.kind !== "count_distinct" ? <div><Label className="text-xs">Empty label</Label><Input data-testid={`column-empty-label-${index}`} disabled={!canManage} value={column.empty_label || ""} placeholder="Only when endpoint is missing" onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, empty_label: event.target.value } : item))} /><p className="mt-1 text-xs text-slate-400">Does not replace a blank field value.</p></div> : <div />}
            <div className="flex items-center"><Button type="button" size="sm" variant="ghost" disabled={!canManage || index === 0} onClick={() => setColumns((items) => moveReportColumn(items, index, -1))}>↑</Button><Button type="button" size="sm" variant="ghost" disabled={!canManage || index === renderedColumns.length - 1} onClick={() => setColumns((items) => moveReportColumn(items, index, 1))}>↓</Button><Button type="button" size="sm" variant="ghost" disabled={!canManage} onClick={() => setColumns((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4" /></Button></div>
          </div>;
        })}</div>
        <div className="flex items-center justify-end gap-3">{exportMutation.isPending && <span className="text-sm text-slate-500">Preparing CSV… {exportProgress?.total ? `${exportProgress.processed} of ${exportProgress.total} rows` : "counting rows"}</span>}{exportMutation.isError && <span className="text-sm text-red-600">Export failed: {exportMutation.error?.message}</span>}<Button variant="outline" disabled={!canManage || reconciled.stale.length > 0 || !renderedColumns.length || exportMutation.isPending} onClick={() => exportMutation.mutate()}>{exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}Export CSV</Button></div>
      </CardContent>
    </Card>
    {preview && <Card><CardHeader><CardTitle className="text-base">Preview</CardTitle><CardDescription>{preview.total ?? 0} matching row{preview.total === 1 ? "" : "s"} · page {page}</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left">{headers.map((header, index) => <th className="p-2 font-medium" key={index}>{typeof header === "string" ? header : header.label}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr className="border-b" key={row.id || row.row_id || rowIndex}>{(Array.isArray(row) ? row : (row.values || Object.values(row))).map((value, index) => <td className="p-2" key={index}>{Array.isArray(value) ? value.join(", ") : String(value ?? "")}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="p-3 text-sm text-slate-500">No rows match this report.</p>}<div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={page <= 1 || previewMutation.isPending} onClick={() => previewMutation.mutate(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={!preview.has_more && !(preview.total > page * 50) || previewMutation.isPending} onClick={() => previewMutation.mutate(page + 1)}>Next</Button></div></CardContent></Card>}
  </div>;
}