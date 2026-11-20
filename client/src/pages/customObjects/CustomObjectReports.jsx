import React, { useEffect, useMemo, useRef, useState } from "react";
import "./ReportBuilder.css";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
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
import ReportSharingControls, { InternalReportLink } from "./ReportSharingControls";
import { validateReportSort, reportDefinitionKey } from "../../../../shared/customObjectReportSort.mjs";
import {
  endpointKey, endpointLabel, loadReportConfig, makeReportConfig, moveReportColumn,
  reconcileReportConfig, reportPathLabel, reportColumnSummary, reportReachableEndpoints,
} from "./reportHelpers.mjs";

const reportUrl = (objectId, action) => `/api/custom-objects/${objectId}/report-${action}`;
const reportSharingUrl = (objectId) => `/api/custom-objects/${encodeURIComponent(objectId)}/report-sharing`;
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
  linkedReportId = "",
}) {
  const objectId = object.id;
  const liveSaved = useSavedExportReports({
    settingKey: `custom_object_reports_${objectId}`,
    description: `Shared reports for ${object.plural_label || "a Custom Object"}`,
    enabled: Boolean(objectId) && !savedReportsOverride,
    strict: Boolean(linkedReportId),
  });
  const saved = savedReportsOverride || liveSaved;
  const [config, setConfig] = useState(() =>
    initialConfig ? loadReportConfig(objectId, initialConfig) : makeReportConfig(objectId));
  const [columnPath, setColumnPath] = useState([]);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnKind, setColumnKind] = useState("field");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState(null);
  const [sortProgress, setSortProgress] = useState(null);
  const [sortJob, setSortJob] = useState(null);
  const [exportProgress, setExportProgress] = useState(null);
  const [appliedLink, setAppliedLink] = useState("");
  const [previewedLink, setPreviewedLink] = useState("");
  const linkKey = linkedReportId ? `${objectId}:${linkedReportId}` : "";
  const currentLink = useRef(linkKey);
  currentLink.current = linkKey;
  const currentDefinitionKey = useRef("");
  const currentSortJob = useRef(null);
  const linkedReport = saved.reports.find(report => report.id === linkedReportId);
  const linkPending = Boolean(linkKey && appliedLink !== linkKey);
  useEffect(() => {
    if (!linkKey) {
      if (appliedLink) {
        setConfig(makeReportConfig(objectId));
        saved.setActiveReportId(null);
        setPreview(null);
        setSortJob(null);
        setSortProgress(null);
        currentSortJob.current = null;
      }
      setAppliedLink("");
      setPreviewedLink("");
      return;
    }
    if (appliedLink === linkKey || saved.isFetching || saved.error || !linkedReport) return;
    setConfig(loadReportConfig(objectId, linkedReport.config));
    saved.setActiveReportId(linkedReport.id);
    setColumnPath([]);
    setPreview(null);
    setSortJob(null);
    setSortProgress(null);
    currentSortJob.current = null;
    setPage(1);
    setPreviewedLink("");
    setAppliedLink(linkKey);
  }, [linkKey, appliedLink, linkedReport, saved.isFetching, saved.error, objectId]);
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
  const organizationFieldsQuery = useQuery({
    queryKey: ["custom-object-report-organization-fields", objectId],
    queryFn: async () => {
      const response = await relationshipRequest(reportUrl(objectId, "organization-fields"));
      if (!Array.isArray(response?.data)) throw new Error("Invalid organisation field metadata response.");
      return response.data;
    },
    enabled: Boolean(objectId) && endpoints.some((endpoint) => endpoint.kind === "organization"),
  });
  // Failed refreshes must not authorise execution using cached metadata.
  const organizationFields = organizationFieldsQuery.isError ? undefined : organizationFieldsQuery.data;
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
    config, objectId, definitions: graph, fieldsByEndpoint, organizationFields, metadataLoading: graphLoading,
  }), [config, objectId, graph, fieldsByEndpoint, organizationFields, graphLoading]);
  let validatedSort = [];
  let sortError = "";
  try {
    validatedSort = validateReportSort(reconciled.config);
  } catch (error) {
    sortError = error.message || "The saved sort configuration is invalid.";
  }
  const legacyHop = Array.isArray(configView.grain_path) ? configView.grain_path[0] : null;
  const legacyRelationship = graph.find(item => String(item.id) === String(legacyHop?.relationship_definition_id));
  const legacyMany = legacyRelationship && (legacyRelationship.cardinality === "many_to_many"
    || (legacyRelationship.cardinality === "one_to_many" && legacyHop?.from_side === "source")
    || (legacyRelationship.cardinality === "many_to_one" && legacyHop?.from_side === "target"));
  const v1SortSupported = configView.version !== 1 || configView.grain_path?.length === 0
    || (configView.grain_path?.length === 1 && legacyMany);
  const unsupportedV1Sort = configView.version === 1 && validatedSort.length > 0 && !v1SortSupported;
  const configKey = (() => {
    try { return reportDefinitionKey(reconciled.config); } catch { return ""; }
  })();
  currentDefinitionKey.current = configKey;
  const executionBlocked = linkPending || graphLoading || reconciled.stale.length > 0
    || reconciled.filtersPending || reconciled.indicatorsPending || reconciled.columnsPending || !renderedColumns.length
    || Boolean(sortError) || unsupportedV1Sort;

  useEffect(() => {
    setPreview(null);
    setSortJob(null);
    setSortProgress(null);
    currentSortJob.current = null;
    setPage(1);
  }, [configKey]);

  const makePreviewRequest = (requestedPage) => ({
    requestedPage,
    definitionKey: configKey,
    linkKey,
  });
  useEffect(() => {
    setConfig((current) => current == null || typeof current !== "object"
      || current.start_object_id == null
      || String(current.start_object_id) === String(objectId)
      ? current : makeReportConfig(objectId));
    setPreview(null);
    setSortJob(null);
    setSortProgress(null);
    currentSortJob.current = null;
  }, [objectId]);
  useEffect(() => {
    onConfigChange?.(config);
  }, [config, onConfigChange]);
  const previewMutation = useMutation({
    mutationFn: async ({ requestedPage, definitionKey: requestedKey, linkKey: requestLink }) => {
      if (executionBlocked) throw new Error("Resolve unavailable selections and wait for report metadata before preview.");
      const requestedDefinition = reconciled.config;
      const requestKey = reportDefinitionKey(requestedDefinition);
      if (requestKey !== requestedKey || requestLink !== linkKey) return null;
      const post = (body) => relationshipRequest(reportUrl(objectId, "preview"), {
        method: "POST",
        body: JSON.stringify(body),
      });
      let data;
      const activeJob = currentSortJob.current;
      if (activeJob?.definitionKey === requestKey) {
        try {
          data = await post({ definition: requestedDefinition, action: "page", job_id: activeJob.id, page: requestedPage, pageSize: 50 });
        } catch {
          if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return null;
          currentSortJob.current = null;
          setSortJob({ id: activeJob.id, status: "failed" });
          throw new Error("Sorted preview snapshot expired or is unavailable. Retry Preview to prepare a new sorted snapshot; the report was not run unsorted.");
        }
      } else {
        data = await post({ definition: requestedDefinition, page: requestedPage, pageSize: 50 });
        if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return data;
        if (data?.sort_job?.status === "complete" && data.sort_job.id) {
          currentSortJob.current = { id: data.sort_job.id, definitionKey: requestKey };
          setSortJob(data.sort_job);
        }
        if (data?.sort_job && data.sort_job.status !== "complete") {
          if (data.sort_job.status === "failed") {
            setSortJob(data.sort_job);
            throw new Error("Sorted preview preparation failed. The saved report was not run unsorted.");
          }
          const job = { id: data.sort_job.id, definitionKey: requestKey };
          currentSortJob.current = job;
          setSortJob(data.sort_job);
          setSortProgress(data.sort_job);
          let completed;
          let stalledAttempts = 0;
          let preparedRows = Number(data.sort_job.processed) || 0;
          for (; stalledAttempts < 60;) {
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return data;
            try {
              completed = await post({
                definition: requestedDefinition, action: "process", job_id: job.id,
                page: requestedPage, pageSize: 50,
              });
            } catch {
              if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return data;
              currentSortJob.current = null;
              setSortJob({ id: job.id, status: "failed" });
              throw new Error("Sorted preview preparation failed or expired. Retry Preview to prepare a new sorted snapshot; the report was not run unsorted.");
            }
            if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return data;
            if (completed?.sort_job) {
              setSortJob(completed.sort_job);
              setSortProgress(completed.sort_job);
              const processed = Number(completed.sort_job.processed) || 0;
              stalledAttempts = processed > preparedRows ? 0 : stalledAttempts + 1;
              preparedRows = processed;
            }
            if (completed?.sort_job?.status === "failed") {
              currentSortJob.current = null;
              throw new Error("Sorted preview preparation failed. The saved report was not run unsorted.");
            }
            if (completed?.sort_job?.status === "complete" || Array.isArray(completed?.data)) break;
          }
          if (currentDefinitionKey.current !== requestKey || currentLink.current !== requestLink) return data;
          if (!completed || !Array.isArray(completed.data) || completed.sort_job?.status !== "complete") {
            currentSortJob.current = null;
            throw new Error("Sorted preview preparation did not finish in time. The saved report was not run unsorted; retry Preview.");
          }
          data = completed;
          currentSortJob.current = job;
          setSortProgress(null);
        }
      }
      if (currentDefinitionKey.current === requestKey && currentLink.current === requestLink) {
        setPreview(data); setPage(requestedPage);
      }
      return data;
    },
    onError: (error, request) => {
      if (request?.definitionKey !== currentDefinitionKey.current || request?.linkKey !== currentLink.current) return;
      setPreview(null); setSortProgress(null); toast.error(error.message);
    },
  });
  useEffect(() => {
    if (!linkKey || appliedLink !== linkKey || executionBlocked || previewedLink === linkKey) return;
    setPreviewedLink(linkKey);
    previewMutation.mutate(makePreviewRequest(1));
  }, [linkKey, appliedLink, executionBlocked, previewedLink]);
  const exportMutation = useMutation({
    mutationFn: async () => {
      if (executionBlocked) throw new Error("Resolve unavailable selections and wait for report metadata before export.");
      const storageKey = `custom-object-report-export:${objectId}`;
      const requestedKey = reportDefinitionKey(reconciled.config);
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
      if (job) {
        try {
          if (!job.definition || reportDefinitionKey(job.definition) !== requestedKey) job = null;
        } catch {
          job = null;
        }
      }
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
    setSortJob(null);
    setSortProgress(null);
    currentSortJob.current = null;
    setPage(1);
  };
  const editConfig = (updater) => {
    setConfig((current) => (typeof updater === "function" ? updater(current) : updater));
    setPreview(null);
    setSortJob(null);
    setSortProgress(null);
    currentSortJob.current = null;
    setPage(1);
  };
  const setColumns = (updater) => editConfig((current) => ({
    ...current,
    ...(() => {
      const nextColumns = typeof updater === "function"
        ? updater(Array.isArray(current?.columns) ? current.columns : []) : updater;
      const validIds = new Set((Array.isArray(nextColumns) ? nextColumns : [])
        .map((column) => column?.id).filter((id) => typeof id === "string"));
      return {
        columns: nextColumns,
        ...(Array.isArray(current?.sort)
          ? { sort: current.sort.filter((rule) => validIds.has(rule?.column_id)) }
          : {}),
      };
    })(),
  }));
  const addSortRule = () => editConfig((current) => {
    const columns = Array.isArray(current?.columns) ? current.columns : [];
    const used = new Set();
    const repaired = columns.map((column) => {
      let id = typeof column?.id === "string" && column.id.trim() ? column.id : "";
      if (!id || used.has(id)) {
        id = `report-column:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      }
      used.add(id);
      return id === column?.id ? column : { ...column, id };
    });
    const rules = Array.isArray(current?.sort) ? [...current.sort] : [];
    const nextColumn = repaired.find((column) => !rules.some((rule) => rule?.column_id === column.id));
    return { ...current, columns: repaired, sort: nextColumn ? [...rules, { column_id: nextColumn.id, direction: "asc" }] : rules };
  });
  const updateSort = (updater) => editConfig((current) => ({
    ...current,
    sort: typeof updater === "function" ? updater(Array.isArray(current?.sort) ? current.sort : []) : updater,
  }));
  const sortRules = Array.isArray(configView.sort) ? configView.sort : [];
  const isV2 = configView.version === 2;
  const selectedStart = isV2 && configView.start_endpoint
    && typeof configView.start_endpoint === "object"
    && !Array.isArray(configView.start_endpoint)
    ? configView.start_endpoint
    : ownerEndpoint;
  const selectedEndpoint = reconciled.rowEndpoint;
  const calculation = ["count_distinct", "exists_related"].includes(columnKind);
  const rowRelativeColumn = calculation || columnKind === "matching_field";
  const columnEndpoint = resolveRelationshipPickerPath({
    definitions: graph, start: rowRelativeColumn ? selectedEndpoint : selectedStart, path: columnPath, maxHops: 6,
  }).endpoint;
  const availableFields = columnEndpoint.kind === "custom_object"
    ? [{ id: "id", label: "ID", builtIn: true }, ...(fieldsByEndpoint[endpointKey(columnEndpoint)] || [])]
    : [...(CORE_FIELDS[columnEndpoint.kind] || []), ...(columnEndpoint.kind === "organization"
      ? (organizationFields || []).map((field) => ({ ...field, preferenceField: true })) : [])];
  const addColumn = (field) => setColumns((current) => [...current, {
    id: `${endpointKey(columnEndpoint)}:${field.id}:${Date.now()}`,
    kind: columnKind === "matching_field" ? "matching_field" : "field", path: columnPath,
    ...(columnKind === "matching_field" ? { conditions: [] } : {}),
    ...(columnEndpoint.kind === "custom_object"
      ? (field.builtIn ? { field: String(field.id) } : { field_id: String(field.id) })
      : field.preferenceField ? { preference_field_id: String(field.id) } : { field: String(field.id) }),
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
  if (linkPending) {
    const loading = !saved.error && (saved.isFetching || (!saved.reportsLoaded && !savedReportsOverride));
    return (
      <Card><CardHeader><CardTitle>{loading ? "Loading report…" : "Report unavailable"}</CardTitle></CardHeader>
        <CardContent>
          <p role={loading ? "status" : "alert"}>
            {loading ? "Loading the selected saved report." : saved.error
              ? "The saved reports could not be loaded. Please try again."
              : "This saved report no longer exists or is not available for this data object."}
          </p>
          {!loading && saved.refetch && <Button className="mt-3" variant="outline" onClick={() => saved.refetch()}>Retry</Button>}
        </CardContent>
      </Card>
    );
  }
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
          onUpdateReport={async (report) => {
            await saved.updateReport(report.id, config);
            try {
              await fetch(reportSharingUrl(objectId), {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ report_id: report.id, action: "sync" }),
              }).then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.message || data.error || "Sharing sync failed.");
              });
            } catch { toast.warning("Report saved, but its external sharing snapshot could not be updated."); }
          }}
          onRenameReport={async (report, name) => {
            await saved.renameReport(report.id, name);
            try {
              await fetch(reportSharingUrl(objectId), {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ report_id: report.id, action: "sync" }),
              }).then(async (response) => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.message || data.error || "Sharing sync failed.");
              });
            } catch { toast.warning("Report renamed, but its external sharing snapshot could not be updated."); }
          }}
          onDeleteReport={(report) => saved.deleteReport(report.id)}
          testIdPrefix="custom-object-report" /> : <p className="text-sm text-slate-500">You can view report settings but need Custom Object management access to save shared reports.</p>}
        {canManage && <ReportSharingControls key={`${objectId}:${saved.activeReport?.id || ""}`} objectId={objectId} report={saved.activeReport} dirty={dirty} />}
        {canManage && <InternalReportLink key={`internal:${objectId}:${saved.activeReport?.id || ""}`} objectId={objectId} report={saved.activeReport} dirty={dirty} />}
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
          <Button className="self-end" disabled={!canManage || executionBlocked || previewMutation.isPending} onClick={() => {
            currentSortJob.current = null; setSortJob(null); setPreview(null);
            previewMutation.mutate(makePreviewRequest(1));
          }}>{previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Preview</Button>
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
               {isV2 && <option value="matching_field">Related field · matching records only</option>}
              {isV2 && <option value="count_distinct">Related record count</option>}
              {isV2 && <option value="exists_related">Has matching related record · True / False</option>}
            </select>
            {columnKind !== "field" && <ReportRelationshipSelector value={columnPath} onChange={setColumnPath}
              start={rowRelativeColumn ? selectedEndpoint : selectedStart} definitions={graph} objects={graphObjects} object={object}
              disabled={!canManage} metadataLoading={graphLoading} allowRoot={false}
              label={rowRelativeColumn ? "Related records from each row" : "Related records from starting entity"} />}
            <p className="text-xs text-slate-500">{columnKind === "matching_field" ? "Show only matching records from each row. Blank and repeated values preserve identity order; rows and counts are unchanged." : columnKind === "exists_related" ? "True when at least one related record meets every condition. Does not filter rows or change other columns." : calculation ? "Calculated for each row. All distinct linked records are counted, independently of indicator conditions." : "Field values are reached from the starting entity, not the row entity."}</p>
            {!calculation && <div><Label>Add a field</Label><div className="mt-2 grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
              {availableFields.map((field) => <Button key={`${field.preferenceField ? "preference" : "field"}:${field.id}`} type="button" size="sm" variant="outline"
                className="h-auto min-h-9 whitespace-normal break-words [overflow-wrap:anywhere]" disabled={!canManage || graphLoading || (["related_field", "matching_field"].includes(columnKind) && !columnPath.length)}
                onClick={() => addColumn(field)}><Plus className="mr-1 h-3 w-3 shrink-0" /><span title={field.label} className="min-w-0 line-clamp-2">{field.label}</span></Button>)}
              {columnEndpoint.kind === "custom_object" && !Array.isArray(fieldsByEndpoint[endpointKey(columnEndpoint)]) && <p role="status" className="text-sm text-slate-500">Field metadata unavailable. Saved selections are preserved.</p>}
              {columnEndpoint.kind === "organization" && !Array.isArray(organizationFields) && <p role="status" className="text-sm text-slate-500">Organisation custom field metadata unavailable. Saved selections are preserved.</p>}
            </div></div>}
            {!rowRelativeColumn && relationshipMetadata.length > 0 && <div><Label>Relationship fields</Label><div className="mt-2 grid gap-2 sm:grid-cols-2">{relationshipMetadata.map((field) => <Button key={field.id || field.key} type="button" size="sm" variant="outline" className="h-auto min-h-9 whitespace-normal break-words" disabled={!canManage || graphLoading} onClick={() => addRelationshipColumn(field)}><Plus className="mr-1 h-3 w-3 shrink-0" /><span title={field.label} className="min-w-0 line-clamp-2">{field.label}</span></Button>)}</div></div>}
            {calculation && <Button type="button" data-testid={columnKind === "exists_related" ? "add-report-indicator" : "add-report-count"}
              disabled={!canManage || graphLoading || !columnPath.length || Boolean(resolveRelationshipPickerPath({ definitions: graph, start: selectedEndpoint, path: columnPath, maxHops: 6 }).error)}
              onClick={() => { if (columnKind === "exists_related") addIndicatorColumn(); else { addCountColumn(columnPath); setAddingColumn(false); } }}>
              Add {columnKind === "exists_related" ? "indicator" : "count"}
            </Button>}
          </div>}
          {!renderedColumns.length && <p className="rounded-md border border-dashed p-4 text-sm text-slate-500">No columns yet. Add a field, count or indicator to begin.</p>}
        <div className="space-y-2">{renderedColumns.map((column, index) => {
          const pathRoot = isV2 && ["count_distinct", "exists_related", "matching_field"].includes(column.kind) ? selectedEndpoint : selectedStart;
          const displayPath = safePickerPath(column?.path);
          const summary = reportColumnSummary(column, { start: selectedStart, row: isV2 ? selectedEndpoint : selectedStart, definitions: graph, objects: graphObjects, object });
          return <div key={column.id || index} className="min-w-0 space-y-3 rounded border p-3 text-sm">
            <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_auto]">
            <div className="min-w-0"><Label htmlFor={`column-heading-${index}`} className="text-xs">Column heading</Label><Input id={`column-heading-${index}`} data-testid={`column-heading-${index}`} disabled={!canManage} value={column.label || ""} onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /><p title={summary} className="report-column-summary mt-1 break-words text-xs text-slate-500">{summary}</p>
              <details className="mt-1 text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary><p className="break-words">{pathRoot === selectedEndpoint ? "Row-relative" : "Start-relative"} · {reportPathLabel(displayPath, graph, graphObjects, object, pathRoot)}</p></details></div>
            {isV2 && !["count_distinct", "exists_related", "matching_field"].includes(column.kind) ? <div className="min-w-0"><Label htmlFor={`column-empty-label-${index}`} className="text-xs">Empty label</Label><Input id={`column-empty-label-${index}`} data-testid={`column-empty-label-${index}`} disabled={!canManage} value={column.empty_label || ""} placeholder="Only when endpoint is missing" onChange={(event) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, empty_label: event.target.value } : item))} /><p className="mt-1 text-xs text-slate-400">Does not replace a blank field value.</p></div> : <div />}
            <div className="flex items-center"><Button type="button" size="sm" variant="ghost" aria-label={`Move column ${index + 1} up`} disabled={!canManage || index === 0} onClick={() => setColumns((items) => moveReportColumn(items, index, -1))}>↑</Button><Button type="button" size="sm" variant="ghost" aria-label={`Move column ${index + 1} down`} disabled={!canManage || index === renderedColumns.length - 1} onClick={() => setColumns((items) => moveReportColumn(items, index, 1))}>↓</Button><Button type="button" size="sm" variant="ghost" aria-label={`Remove column ${index + 1}`} disabled={!canManage} onClick={() => setColumns((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
            {isV2 && ["exists_related", "matching_field"].includes(column.kind) && <ReportIndicatorEditor column={column} projection={column.kind === "matching_field"} indicatorLabel={`Indicator column ${index + 1}`}
                onChange={(change) => setColumns((items) => items.map((item, itemIndex) => itemIndex === index
                  ? { ...item, ...change } : item))}
                canManage={canManage} start={selectedEndpoint} definitions={graph} objects={graphObjects} object={object}
                fieldsByEndpoint={fieldsByEndpoint} metadataLoading={graphLoading}
                metadataError={fieldQueries.some((query) => query.isError)}
                onRetry={() => fieldQueries.filter((query) => query.isError).forEach((query) => query.refetch())} />}
          </div>;
        })}</div></section>
        <section className="min-w-0 space-y-3 rounded-md border p-3" aria-label="Report sorting" data-testid="report-sort-editor">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><Label>Sort priority</Label><p className="mt-1 max-w-3xl text-xs text-slate-500">
              Blank and null values sort last. Numbers, dates and booleans use typed ordering; text is case-sensitive.
              Joined multi-value cells sort as their displayed joined text, retaining identity order within each cell.
              Equal values keep a stable row tie-breaker.
            </p></div>
            <Button type="button" variant="outline" data-testid="add-report-sort"
              disabled={!canManage || !renderedColumns.length || sortRules.length >= 10
                || renderedColumns.every((column) => sortRules.some((rule) => rule?.column_id === column.id))}
              onClick={addSortRule}><Plus className="mr-1 h-4 w-4" />Add sort</Button>
          </div>
          {configView.version === 1 && <p className="text-xs text-slate-600">
            V1 sorting supports the root and a single-hop to-many path. Complex legacy V1 reports must be recreated as V2 before sorting; this report will not be upgraded automatically.
          </p>}
          {!sortRules.length && <p className="rounded-md border border-dashed p-3 text-sm text-slate-500">No sort rules. Rows retain the report’s default order.</p>}
          <ol className="space-y-2">
            {sortRules.map((rule, index) => {
              const columnIndex = renderedColumns.findIndex((column) => column?.id === rule?.column_id);
              const unavailable = columnIndex < 0;
              return <li key={`${rule?.column_id || "invalid"}-${index}`} className="grid min-w-0 gap-2 rounded border p-3 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,0.7fr)_auto] sm:items-end">
                <span className="pb-2 text-sm font-medium">Priority {index + 1}</span>
                <div className="min-w-0"><Label htmlFor={`sort-column-${index}`} className="text-xs">Column</Label>
                  <select id={`sort-column-${index}`} data-testid={`sort-column-${index}`} aria-label={`Sort priority ${index + 1} column`}
                    disabled={!canManage} value={rule?.column_id || ""} className="mt-1 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                    onChange={(event) => updateSort((rules) => rules.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, column_id: event.target.value } : item))}>
                    {unavailable && <option value={rule?.column_id || ""}>Unavailable saved column</option>}
                    {renderedColumns.filter((column) => typeof column?.id === "string" && column.id
                      && (!sortRules.some((other, otherIndex) => otherIndex !== index && other?.column_id === column.id)
                        || column.id === rule?.column_id)).map((column) =>
                      <option key={column.id} value={column.id}>{column.label || "Untitled column"}</option>)}
                  </select>
                </div>
                <div className="min-w-0"><Label htmlFor={`sort-direction-${index}`} className="text-xs">Direction</Label>
                  <select id={`sort-direction-${index}`} data-testid={`sort-direction-${index}`} aria-label={`Sort priority ${index + 1} direction`}
                    disabled={!canManage} value={rule?.direction || "asc"} className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                    onChange={(event) => updateSort((rules) => rules.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, direction: event.target.value } : item))}>
                    <option value="asc">Ascending</option><option value="desc">Descending</option>
                  </select>
                </div>
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move sort priority ${index + 1} up`}
                    disabled={!canManage || index === 0} onClick={() => updateSort((rules) => moveReportColumn(rules, index, -1))}>↑</Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Move sort priority ${index + 1} down`}
                    disabled={!canManage || index === sortRules.length - 1} onClick={() => updateSort((rules) => moveReportColumn(rules, index, 1))}>↓</Button>
                  <Button type="button" size="sm" variant="ghost" aria-label={`Remove sort priority ${index + 1}`}
                    disabled={!canManage} onClick={() => updateSort((rules) => rules.filter((_, ruleIndex) => ruleIndex !== index))}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </li>;
            })}
          </ol>
        </section>
        {isV2 && <ReportRelationshipFilters filters={configView.filters}
          onChange={(filters) => editConfig((current) => ({ ...current, filters }))}
          canManage={canManage} start={selectedEndpoint}
          definitions={graph} objects={graphObjects} object={object} fieldsByEndpoint={fieldsByEndpoint}
          metadataLoading={graphLoading} metadataError={fieldQueries.some((query) => query.isError)}
          onRetry={() => fieldQueries.filter((query) => query.isError).forEach((query) => query.refetch())} />}
        {organizationFieldsQuery.isError && <div role="alert" className="rounded-md border p-3 text-sm text-red-600">Organisation custom fields could not be loaded: {organizationFieldsQuery.error?.message}. Saved selections are preserved.<Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => organizationFieldsQuery.refetch()}>Retry organisation fields</Button></div>}
        {sortError && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Saved sort rules are invalid: {sortError}. They are preserved, but preview and export are blocked until repaired.</p>}
        {unsupportedV1Sort && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Complex V1 reports cannot be sorted. Create a new V2 report to add sorting; this legacy definition will not be upgraded automatically.</p>}
        {(graphLoading || reconciled.indicatorsPending || reconciled.filtersPending || reconciled.columnsPending) && <p role="status" className="rounded-md border p-3 text-sm text-slate-500">Waiting for authorised relationship or field metadata. Saved selections are preserved; preview and export are blocked.</p>}
        {sortProgress && <p role="status" aria-live="polite" className="rounded-md border p-3 text-sm text-slate-600">
          Preparing globally sorted preview · {sortProgress.processed ?? 0} of {sortProgress.total ?? "…"} rows
        </p>}
        {sortJob?.status === "failed" && <p role="alert" className="rounded-md border border-red-300 p-3 text-sm text-red-700">Sorted preview preparation failed. The saved report was not run unsorted. Retry Preview to start a new preparation.</p>}
        {previewMutation.isError && <p role="alert" className="text-sm text-red-600">Preview failed: {previewMutation.error?.message}. Retry Preview after resolving the issue.</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">{exportMutation.isPending && <span className="text-sm text-slate-500">Preparing CSV… {exportProgress?.total ? `${exportProgress.processed} of ${exportProgress.total} rows` : "counting rows"}</span>}{exportMutation.isError && <span role="alert" className="text-sm text-red-600">Export failed: {exportMutation.error?.message}</span>}<Button variant="outline" disabled={!canManage || executionBlocked || exportMutation.isPending} onClick={() => exportMutation.mutate()}>{exportMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}Export CSV</Button></div>
      </CardContent>
    </Card>
    {preview && <Card className="min-w-0"><CardHeader><CardTitle className="text-base">Preview</CardTitle><CardDescription>{preview.total ?? 0} matching row{preview.total === 1 ? "" : "s"} · page {page}</CardDescription></CardHeader><CardContent className="min-w-0 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left">{headers.map((header, index) => <th className="p-2 font-medium" key={index}>{typeof header === "string" ? header : header.label}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr className="border-b" key={row.id || row.row_id || rowIndex}>{(Array.isArray(row) ? row : (row.values || Object.values(row))).map((value, index) => <td className="p-2" key={index}>{Array.isArray(value) ? value.join(", ") : renderedColumns[index]?.kind === "exists_related" && typeof value === "boolean" ? value ? "True" : "False" : String(value ?? "")}</td>)}</tr>)}</tbody></table>{!rows.length && <p className="p-3 text-sm text-slate-500">No rows match this report.</p>}<div className="mt-3 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={executionBlocked || page <= 1 || previewMutation.isPending} onClick={() => previewMutation.mutate(makePreviewRequest(page - 1))}>Previous</Button><Button size="sm" variant="outline" disabled={executionBlocked || (!preview.has_more && !(preview.total > page * 50)) || previewMutation.isPending} onClick={() => previewMutation.mutate(makePreviewRequest(page + 1))}>Next</Button></div></CardContent></Card>}
  </div>;
}