import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Columns3,
  Download,
  Loader2,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { COUNTRIES } from "@/data/countries";
import CustomFieldFileUpload, {
  CustomFieldFileDisplay,
} from "@/components/CustomFieldFileUpload";
import SortableHeader from "@/components/SortableHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  applyRecordPermissionToggle,
  arrayValue,
  buildRecordPayload,
  detailSections,
  fieldAccess,
  formatRecordValue,
  normalizeRecordPermissions,
  optionValues,
  readableFields,
  sharedListFields,
  validateRecordValues,
  writableFields,
} from "./customObjects/recordHelpers";
import { RelatedRecordsPanel } from "./customObjects/RelatedRecordsPanel";
import { relationshipBackPath } from "./customObjects/relationshipHelpers";
import { RecordFieldControl } from "./customObjects/RecordFieldControls";

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const request = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      response.status,
      body.message || body.error || `Request failed (${response.status})`,
      body.details,
    );
  return body;
};

const countriesByCode = Object.fromEntries(
  COUNTRIES.map((country) => [country.code, country.name]),
);
const fileDisplayValue = (value) => {
  const file = Array.isArray(value) ? value[0] : value;
  if (!file || typeof file !== "object" || file.file_url) return file;
  return {
    ...file,
    file_url: file.url || file.path,
    file_name: file.name,
  };
};
const capability = (source, name) => {
  const capabilities = source?.capabilities || source?.permissions;
  if (!capabilities) return true;
  const shortName = name.replace(/_records$/, "");
  if (Array.isArray(capabilities))
    return capabilities.includes(name) || capabilities.includes(shortName);
  return (
    capabilities[name] ??
    capabilities[shortName] ??
    capabilities[`can_${name}`] ??
    true
  );
};
const recordsPath = (objectId) => `/CustomObjectsAdmin/${objectId}/records`;
const csvCell = (value) => {
  const text = value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

function PageState({ title, message, retry }) {
  return (
    <Card className="mx-auto max-w-3xl">
      <CardContent className="py-14 text-center">
        <CircleAlert className="mx-auto mb-3 h-7 w-7 text-slate-400" />
        <h2 className="font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm text-slate-600">{message}</p>
        {retry && (
          <Button variant="outline" className="mt-4" onClick={retry}>
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function useSchema(objectId) {
  const objectQuery = useQuery({
    queryKey: ["custom-objects", objectId],
    queryFn: () => request(`/api/custom-objects/${objectId}`),
    retry: false,
  });
  const fieldsQuery = useQuery({
    queryKey: ["custom-objects", objectId, "record-fields"],
    queryFn: () =>
      request(`/api/custom-objects/${objectId}/fields?includeInactive=true&pageSize=100`),
    retry: false,
  });
  return {
    objectQuery,
    fieldsQuery,
    object: objectQuery.data,
    fields: fieldsQuery.data?.data || fieldsQuery.data || [],
  };
}

function Workspace({ children, object, backToRecords = false, backTo }) {
  return (
    <main className="min-h-screen bg-slate-50/70 p-4 md:p-8">
      <div className="mx-auto max-w-7xl">
        <Link
          to={
            backTo ||
            (backToRecords
              ? recordsPath(object?.id)
              : `/CustomObjectsAdmin/${object?.id}`)
          }
          className="mb-5 inline-flex items-center text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {backTo ? "Back" : backToRecords ? `All ${object?.plural_label || "records"}` : "Object setup"}
        </Link>
        {children}
      </div>
    </main>
  );
}

const filterOperators = (type) => {
  if (type === "boolean") return [["equals", "is"]];
  if (["number", "decimal", "date"].includes(type))
    return [
      ["equals", "equals"],
      ["gte", "at least"],
      ["lte", "at most"],
    ];
  if (["dropdown", "picklist", "country", "countries", "list"].includes(type))
    return [
      ["any_of", "is any of"],
      ["none_of", "is none of"],
    ];
  return [
    ["contains", "contains"],
    ["equals", "equals"],
    ["is_empty", "is empty"],
    ["is_not_empty", "is not empty"],
  ];
};

function FilterValue({ field, value, onChange }) {
  const type = field.field_type;
  if (type === "boolean")
    return (
      <Select value={String(value ?? "")} onValueChange={(next) => onChange(next === "true")}>
        <SelectTrigger className="w-32"><SelectValue placeholder="Choose" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  if (["dropdown", "picklist"].includes(type))
    return (
      <Select value={String(value ?? "")} onValueChange={onChange}>
        <SelectTrigger className="w-48"><SelectValue placeholder="Choose" /></SelectTrigger>
        <SelectContent>
          {optionValues(field).map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  if (["country", "countries"].includes(type)) {
    const allowed = field.all_countries !== false
      ? COUNTRIES
      : COUNTRIES.filter((country) => arrayValue(field.selected_countries).includes(country.code));
    return (
      <Select value={String(value ?? "")} onValueChange={onChange}>
        <SelectTrigger className="w-48"><SelectValue placeholder="Choose" /></SelectTrigger>
        <SelectContent>
          {allowed.map((country) => (
            <SelectItem key={country.code} value={country.code}>{country.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      className="w-48"
      type={["number", "decimal"].includes(type) ? "number" : type === "date" ? "date" : "text"}
      step={type === "decimal" ? "any" : undefined}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Filter value"
    />
  );
}

export function CustomObjectRecordList() {
  const { objectId } = useParams();
  const { memberInfo, organizationInfo } = useMemberAccess();
  const { objectQuery, fieldsQuery, object, fields } = useSchema(objectId);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filters, setFilters] = useState({});
  const [columnsOpen, setColumnsOpen] = useState(false);
  const tenantKey =
    memberInfo?.tenant_id || organizationInfo?.tenant_id || memberInfo?.organization_id;
  const storageKey = `custom-object-columns:${tenantKey || "object"}:${objectId}`;
  const [visibleIds, setVisibleIds] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || null;
    } catch {
      return null;
    }
  });
  const activeFields = readableFields(fields);
  useEffect(() => {
    if (!visibleIds && activeFields.length)
      setVisibleIds(sharedListFields(object, fields).map((field) => field.id));
  }, [fieldsQuery.data, object]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (visibleIds) localStorage.setItem(storageKey, JSON.stringify(visibleIds));
  }, [storageKey, visibleIds]);
  const queryString = useMemo(() => {
    const appliedFilters = Object.fromEntries(
      Object.entries(filters).filter(
        ([, filter]) =>
          ["is_empty", "is_not_empty"].includes(filter.op) ||
          filter.value === false ||
          (Array.isArray(filter.value)
            ? filter.value.length > 0
            : String(filter.value ?? "").trim() !== ""),
      ),
    );
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      search,
      sortField,
      sortDir,
      includeArchived: String(includeArchived),
      filters: JSON.stringify(appliedFilters),
    });
    return params.toString();
  }, [page, pageSize, search, sortField, sortDir, includeArchived, filters]);
  const recordsQuery = useQuery({
    queryKey: ["custom-object-records", objectId, queryString],
    queryFn: () => request(`/api/custom-objects/${objectId}/records?${queryString}`),
    enabled: !!object && !objectQuery.error && !fieldsQuery.error,
    retry: false,
  });
  const records = recordsQuery.data?.data || [];
  const total = recordsQuery.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const visibleFields = activeFields.filter((field) => visibleIds?.includes(field.id));
  const canCreate =
    object?.status === "active" &&
    capability(object, "create_records");
  const exportRecords = useMutation({
    mutationFn: async () => {
      const exportParams = new URLSearchParams(queryString);
      exportParams.set("page", "1");
      exportParams.set("pageSize", "1000");
      const first = await request(`/api/custom-objects/${objectId}/export?${exportParams}`);
      const allRows = [...(first.data || [])];
      const total = first.total || allRows.length;
      const pages = Math.ceil(total / 1000);
      for (let exportPage = 2; exportPage <= pages; exportPage += 1) {
        exportParams.set("page", String(exportPage));
        const next = await request(`/api/custom-objects/${objectId}/export?${exportParams}`);
        allRows.push(...(next.data || []));
      }
      return { ...first, data: allRows, total };
    },
    onSuccess: (payload) => {
      const columns = payload.columns || [];
      const rows = payload.data || [];
      const csv = [
        ["Name", ...columns.map((column) => column.label || column.key)].map(csvCell).join(","),
        ...rows.map((record) => [
          record.display_value,
          ...columns.map((column) => record.data?.[column.key]),
        ].map(csvCell).join(",")),
      ].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${object.object_key || "custom-object"}-records.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`${rows.length} record${rows.length === 1 ? "" : "s"} exported`);
    },
    onError: (error) => toast.error(error.message),
  });
  const updateFilter = (field, patch) => {
    setPage(1);
    setFilters((current) => ({
      ...current,
      [field.id]: { op: filterOperators(field.field_type)[0][0], value: "", ...current[field.id], ...patch },
    }));
  };
  const doSort = (field) => {
    setPage(1);
    if (sortField === field) setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir("asc");
    }
  };
  if (objectQuery.isLoading || fieldsQuery.isLoading)
    return <Workspace object={{ id: objectId }}><Loader2 className="mx-auto mt-24 h-8 w-8 animate-spin" /></Workspace>;
  const schemaError = objectQuery.error || fieldsQuery.error;
  if (schemaError?.status === 403 || recordsQuery.error?.status === 403)
    return <Workspace object={{ id: objectId }}><PageState title="Permission denied" message="You do not have permission to view these records." /></Workspace>;
  if (schemaError)
    return <Workspace object={{ id: objectId }}><PageState title="Records could not be loaded" message={schemaError.message} retry={() => { objectQuery.refetch(); fieldsQuery.refetch(); }} /></Workspace>;
  return (
    <Workspace object={object}>
      <header className="mb-6 flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{object.plural_label}</h1>
          <p className="mt-1 text-sm text-slate-600">Manage {object.plural_label.toLowerCase()} records.</p>
        </div>
        {canCreate && (
          <Button asChild><Link to={`${recordsPath(objectId)}/new`}><Plus className="mr-2 h-4 w-4" />Add {object.singular_label}</Link></Button>
        )}
      </header>
      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center gap-3 border-b p-4">
            <form
              className="flex min-w-[240px] flex-1"
              onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchInput.trim()); }}
            >
              <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={`Search ${object.plural_label.toLowerCase()}`} className="rounded-r-none" />
              <Button type="submit" variant="outline" className="rounded-l-none border-l-0" aria-label="Search"><Search className="h-4 w-4" /></Button>
            </form>
            <div className="flex items-center gap-2 text-sm"><Switch checked={includeArchived} onCheckedChange={(checked) => { setPage(1); setIncludeArchived(checked); }} />Show archived</div>
            {capability(object, "export_records") && (
              <Button variant="outline" disabled={exportRecords.isPending} onClick={() => exportRecords.mutate()}>
                {exportRecords.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Export
              </Button>
            )}
            <Dialog open={columnsOpen} onOpenChange={setColumnsOpen}>
              <DialogTrigger asChild><Button variant="outline"><Columns3 className="mr-2 h-4 w-4" />Columns</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Visible columns</DialogTitle></DialogHeader>
                <div className="max-h-80 space-y-3 overflow-auto py-2">
                  {activeFields.map((field) => (
                    <label key={field.id} className="flex items-center gap-3 text-sm">
                      <Checkbox checked={visibleIds?.includes(field.id)} onCheckedChange={(checked) => setVisibleIds((current = []) => checked ? [...new Set([...current, field.id])] : current.filter((id) => id !== field.id))} />
                      {field.label}{field.is_active === false && <Badge variant="outline">Archived field</Badge>}
                    </label>
                  ))}
                </div>
                <DialogFooter><Button onClick={() => setColumnsOpen(false)}>Done</Button></DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
          <div className="flex flex-wrap gap-2 border-b bg-slate-50/70 p-3">
            {activeFields.map((field) =>
              filters[field.id] ? (
                <div key={field.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-white p-2">
                  <span className="text-xs font-semibold">{field.label}</span>
                  <Select value={filters[field.id].op} onValueChange={(op) => updateFilter(field, { op })}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>{filterOperators(field.field_type).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                  <FilterValue field={field} value={filters[field.id].value} onChange={(value) => updateFilter(field, { value })} />
                  <Button size="icon" variant="ghost" onClick={() => setFilters((current) => { const next = { ...current }; delete next[field.id]; return next; })}><X className="h-4 w-4" /></Button>
                </div>
              ) : null,
            )}
            <Select onValueChange={(id) => updateFilter(activeFields.find((field) => field.id === id), {})}>
              <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Add filter" /></SelectTrigger>
              <SelectContent>{activeFields.filter((field) => !filters[field.id] && field.field_type !== "file").map((field) => <SelectItem key={field.id} value={field.id}>{field.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {recordsQuery.isLoading ? (
            <div className="grid h-52 place-items-center"><Loader2 className="h-7 w-7 animate-spin text-slate-400" /></div>
          ) : recordsQuery.error ? (
            <div className="py-12 text-center">
              <p className="font-medium text-rose-700">Records could not be loaded</p>
              <p className="mt-1 text-sm text-slate-600">{recordsQuery.error.message}</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setFilters({});
                  setSearch("");
                  setSearchInput("");
                }}
              >
                Clear search and filters
              </Button>
            </div>
          ) : records.length === 0 ? (
            <div className="py-16 text-center"><h2 className="font-semibold">No records found</h2><p className="mt-1 text-sm text-slate-500">{search || Object.keys(filters).length ? "Try changing your search or filters." : `Add the first ${object.singular_label.toLowerCase()} when you are ready.`}</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3"><span>Name</span></th>
                    {visibleFields.map((field) => <th key={field.id} className="px-4 py-3"><SortableHeader field={field.id} sortField={sortField} sortDir={sortDir} onSort={doSort}>{field.label}</SortableHeader></th>)}
                    <th className="px-4 py-3"><SortableHeader field="updated_at" sortField={sortField} sortDir={sortDir} onSort={doSort}>Updated</SortableHeader></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className="border-b last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium"><Link className="text-blue-700 hover:underline" to={`${recordsPath(objectId)}/${record.id}`}>{record.display_value}</Link>{record.archived_at && <Badge variant="outline" className="ml-2">Archived</Badge>}</td>
                      {visibleFields.map((field) => <td key={field.id} className="max-w-[260px] truncate px-4 py-3 text-slate-600">{formatRecordValue(field, record.data?.[field.name], countriesByCode)}</td>)}
                      <td className="whitespace-nowrap px-4 py-3 text-slate-500">{record.updated_at ? new Date(record.updated_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm">
            <span className="text-slate-500">{total} record{total === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger><SelectContent>{[10, 25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>)}</SelectContent></Select>
              <Button size="icon" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span>Page {page} of {pages}</span>
              <Button size="icon" variant="outline" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </Workspace>
  );
}

/*function MultiValueControl({ field, value, onChange, countries = false }) {
  const selected = arrayValue(value);
  const options = countries
    ? (field.all_countries !== false ? COUNTRIES : COUNTRIES.filter((item) => arrayValue(field.selected_countries).includes(item.code))).map((item) => ({ value: item.code, label: item.name }))
    : optionValues(field);
  if (field.field_type === "list") {
    return <Textarea value={selected.join("\n")} onChange={(event) => onChange(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} placeholder="One value per line" />;
  }
  return (
    <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
      {options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

function FieldControl({ field, value, onChange, disabled = false }) {
  const type = field.field_type;
  if (type === "file")
    return <CustomFieldFileUpload fieldId={field.id} formId={field.custom_object_id} value={fileDisplayValue(value)} onChange={onChange} allowedTypes={field.allowed_file_types} publicAccess={field.public_access} disabled={disabled} />;
  if (type === "textarea")
    return <Textarea disabled={disabled} minLength={field.min_length ?? undefined} maxLength={field.max_length ?? undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />;
  if (["picklist", "countries", "list"].includes(type))
    return <MultiValueControl field={field} value={value} onChange={onChange} countries={type === "countries"} />;
  if (type === "boolean")
    return <div className="flex items-center gap-2"><Switch disabled={disabled} checked={value === true || value === "true"} onCheckedChange={onChange} /><span className="text-sm">{value === true || value === "true" ? "Yes" : "No"}</span></div>;
  if (["dropdown", "country"].includes(type)) {
    const options = type === "country"
      ? (field.all_countries !== false ? COUNTRIES : COUNTRIES.filter((item) => arrayValue(field.selected_countries).includes(item.code))).map((item) => ({ value: item.code, label: item.name }))
      : optionValues(field);
    return <Select disabled={disabled} value={value || undefined} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="Choose an option" /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
  }
  return <Input disabled={disabled} type={type === "email" ? "email" : type === "url" ? "url" : type === "date" ? "date" : ["number", "decimal"].includes(type) ? "number" : "text"} step={type === "decimal" ? "any" : type === "number" ? "1" : undefined} minLength={field.min_length ?? undefined} maxLength={field.max_length ?? undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />;
}
*/

export function CustomObjectRecordForm() {
  const { objectId, recordId } = useParams();
  const editing = Boolean(recordId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { objectQuery, fieldsQuery, object, fields } = useSchema(objectId);
  const recordQuery = useQuery({
    queryKey: ["custom-object-record", objectId, recordId],
    queryFn: () => request(`/api/custom-objects/${objectId}/records/${recordId}`),
    enabled: editing,
    retry: false,
  });
  const activeFields = readableFields(fields);
  const editableFields = writableFields(fields);
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [permissionDenied, setPermissionDenied] = useState(false);
  useEffect(() => {
    if (editing && recordQuery.data) setValues(recordQuery.data.data || {});
    if (!editing && activeFields.length)
      setValues(Object.fromEntries(activeFields.map((field) => [field.name, field.field_type === "country" ? field.default_country || "" : field.field_type === "countries" ? arrayValue(field.default_countries) : field.field_type === "boolean" ? false : ""])));
  }, [editing, recordQuery.data, fieldsQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: (payload) => request(
      editing ? `/api/custom-objects/${objectId}/records/${recordId}` : `/api/custom-objects/${objectId}/records`,
      { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) },
    ),
    onSuccess: (record) => {
      qc.invalidateQueries({ queryKey: ["custom-object-records", objectId] });
      toast.success(`${object.singular_label} ${editing ? "updated" : "created"}`);
      navigate(`${recordsPath(objectId)}/${record.id || recordId}`);
    },
    onError: (error) => {
      if (error.status === 403) setPermissionDenied(true);
      if (Array.isArray(error.details))
        setErrors(Object.fromEntries(error.details.filter((item) => item.field).map((item) => [item.field, item.message])));
      toast.error(error.message);
    },
  });
  const loading = objectQuery.isLoading || fieldsQuery.isLoading || (editing && recordQuery.isLoading);
  const error = objectQuery.error || fieldsQuery.error || recordQuery.error;
  if (loading) return <Workspace object={{ id: objectId }} backToRecords><Loader2 className="mx-auto mt-24 h-8 w-8 animate-spin" /></Workspace>;
  if (error?.status === 403) return <Workspace object={{ id: objectId }} backToRecords><PageState title="Permission denied" message={`You do not have permission to ${editing ? "edit" : "create"} this record.`} /></Workspace>;
  if (permissionDenied) return <Workspace object={object} backToRecords><PageState title="Permission denied" message={`You do not have permission to ${editing ? "edit" : "create"} this record.`} /></Workspace>;
  if (error) return <Workspace object={{ id: objectId }} backToRecords><PageState title="Form could not be loaded" message={error.message} /></Workspace>;
  if (!capability(object, editing ? "edit_records" : "create_records"))
    return <Workspace object={object} backToRecords><PageState title="Permission denied" message={`You do not have permission to ${editing ? "edit" : "create"} this record.`} /></Workspace>;
  if (object.status !== "active" && !editing) return <Workspace object={object} backToRecords><PageState title="Records cannot be added" message="Only active custom objects accept new records." /></Workspace>;
  const submit = (event) => {
    event.preventDefault();
    const nextErrors = validateRecordValues(editableFields, values, { partial: editing });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    save.mutate(buildRecordPayload(editableFields, values, { partial: editing }));
  };
  return (
    <Workspace object={object} backToRecords>
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-5 text-3xl font-semibold">{editing ? `Edit ${recordQuery.data.display_value}` : `Add ${object.singular_label}`}</h1>
        <Card><CardContent className="p-6">
          <form onSubmit={submit} className="space-y-6">
            {activeFields.map((field) => (
              <div key={field.id}>
                <Label htmlFor={`field-${field.id}`}>{field.label}{field.is_required && <span className="ml-1 text-rose-600">*</span>}</Label>
                <div className="mt-2"><RecordFieldControl disabled={fieldAccess(field) !== "write"} field={field} value={values[field.name]} onChange={(value) => { setValues((current) => ({ ...current, [field.name]: value })); setErrors((current) => ({ ...current, [field.name]: undefined })); }} /></div>
                {errors[field.name] && <p className="mt-1 text-sm text-rose-600">{errors[field.name]}</p>}
              </div>
            ))}
            {activeFields.length === 0 && <p className="text-sm text-slate-600">This object has no active fields.</p>}
            <div className="flex justify-end gap-3 border-t pt-5">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
              <Button type="submit" disabled={save.isPending || !editableFields.length}>{save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save {object.singular_label}</Button>
            </div>
          </form>
        </CardContent></Card>
      </div>
    </Workspace>
  );
}

export function CustomObjectRecordDetail() {
  const { objectId, recordId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { objectQuery, fieldsQuery, object, fields } = useSchema(objectId);
  const recordQuery = useQuery({
    queryKey: ["custom-object-record", objectId, recordId],
    queryFn: () => request(`/api/custom-objects/${objectId}/records/${recordId}`),
    retry: false,
  });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [archiveDenied, setArchiveDenied] = useState(false);
  const archive = useMutation({
    mutationFn: () => request(`/api/custom-objects/${objectId}/records/${recordId}`, { method: "DELETE", body: JSON.stringify({ archive_reason: reason || null }) }),
    onSuccess: () => {
      toast.success(`${object.singular_label} archived`);
      qc.invalidateQueries({ queryKey: ["custom-object-records", objectId] });
      recordQuery.refetch();
      setArchiveOpen(false);
    },
    onError: (error) => {
      if (error.status === 403) {
        setArchiveDenied(true);
        setArchiveOpen(false);
      }
      toast.error(error.message);
    },
  });
  const loading = objectQuery.isLoading || fieldsQuery.isLoading || recordQuery.isLoading;
  const error = objectQuery.error || fieldsQuery.error || recordQuery.error;
  if (loading) return <Workspace object={{ id: objectId }} backToRecords><Loader2 className="mx-auto mt-24 h-8 w-8 animate-spin" /></Workspace>;
  if (error?.status === 403) return <Workspace object={{ id: objectId }} backToRecords><PageState title="Permission denied" message="You do not have permission to view this record." /></Workspace>;
  if (error) return <Workspace object={{ id: objectId }} backToRecords><PageState title="Record could not be loaded" message={error.message} retry={recordQuery.refetch} /></Workspace>;
  const record = recordQuery.data;
  const backTo = relationshipBackPath(location.state, recordsPath(objectId));
  const canEdit =
    !record.archived_at && capability(record.capabilities ? record : object, "edit_records");
  const canArchive =
    !record.archived_at &&
    !archiveDenied &&
    capability(record.capabilities ? record : object, "archive_records");
  return (
    <Workspace object={object} backToRecords backTo={backTo}>
      <div className="mx-auto max-w-4xl">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div><div className="flex items-center gap-2"><h1 className="text-3xl font-semibold">{record.display_value}</h1>{record.archived_at && <Badge variant="outline">Archived</Badge>}</div><p className="mt-2 text-sm text-slate-500">Updated {record.updated_at ? new Date(record.updated_at).toLocaleString() : "—"}</p></div>
          <div className="flex gap-2">
            {canEdit && <Button variant="outline" asChild><Link to={`${recordsPath(objectId)}/${recordId}/edit`}><Pencil className="mr-2 h-4 w-4" />Edit</Link></Button>}
            {canArchive && <Button variant="outline" className="text-rose-700" onClick={() => setArchiveOpen(true)}><Archive className="mr-2 h-4 w-4" />Archive</Button>}
          </div>
        </header>
        <div className="space-y-5">{detailSections(object, fields).map((section) => <Card key={section.id}><CardHeader><CardTitle className="text-lg">{section.label}</CardTitle></CardHeader><CardContent className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {section.fields.map((field) => (
            <div key={field.id} className={field.field_type === "textarea" || field.field_type === "file" ? "sm:col-span-2" : ""}>
              <div className="mb-1 flex items-center gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field.label}</p>{field.is_active === false && <Badge variant="outline">Archived field</Badge>}</div>
              {field.field_type === "file" ? <CustomFieldFileDisplay value={fileDisplayValue(record.data?.[field.name])} /> : <p className="whitespace-pre-wrap text-sm text-slate-900">{formatRecordValue(field, record.data?.[field.name], countriesByCode)}</p>}
            </div>
          ))}
        </CardContent></Card>)}</div>
        <RelatedRecordsPanel
          objectId={objectId}
          recordId={recordId}
          object={object}
          record={record}
        />
      </div>
      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent><DialogHeader><DialogTitle>Archive {record.display_value}?</DialogTitle></DialogHeader><p className="text-sm text-slate-600">The record will be hidden from the default list but remains available when archived records are shown.</p><div><Label>Reason (optional)</Label><Textarea className="mt-2" value={reason} onChange={(event) => setReason(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setArchiveOpen(false)}>Cancel</Button><Button variant="destructive" disabled={archive.isPending} onClick={() => archive.mutate()}>{archive.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Archive</Button></DialogFooter></DialogContent>
      </Dialog>
    </Workspace>
  );
}

const permissionColumns = [
  ["can_view_records", "View"],
  ["can_create_records", "Create"],
  ["can_edit_records", "Edit"],
  ["can_archive_records", "Archive"],
  ["can_export_records", "Export (future)"],
];

export function CustomObjectPermissionsEditor({ objectId, canManage, archived = false }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const pageSize = 25;
  useEffect(() => setPage(1), [objectId]);
  const permissionsQuery = useQuery({
    queryKey: ["custom-objects", objectId, "permissions"],
    queryFn: async () => {
      const first = await request(`/api/custom-objects/${objectId}/permissions?page=1&pageSize=100`);
      const total = Number(first.total) || 0;
      const pageCount = Math.max(1, Math.ceil(total / 100));
      if (pageCount > 100)
        throw new Error("There are too many permission rows to load safely. Refine the role set before editing permissions.");
      const additional = [];
      for (let nextPage = 2; nextPage <= pageCount; nextPage += 1)
        additional.push(
          await request(`/api/custom-objects/${objectId}/permissions?page=${nextPage}&pageSize=100`),
        );
      return {
        ...first,
        data: [first, ...additional].flatMap((result) => result.data || []),
      };
    },
    retry: false,
  });
  const roles = Array.isArray(permissionsQuery.data?.roles)
    ? permissionsQuery.data.roles
    : [];
  const permissions = Array.isArray(permissionsQuery.data?.data)
    ? permissionsQuery.data.data
    : Array.isArray(permissionsQuery.data)
      ? permissionsQuery.data
      : [];
  const byRole = Object.fromEntries(permissions.map((permission) => [permission.role_id, permission]));
  const pages = Math.max(1, Math.ceil(roles.length / pageSize));
  const visibleRoles = roles.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => {
    if (!permissionsQuery.isFetching && page > pages) setPage(pages);
  }, [page, pages, permissionsQuery.isFetching]);
  const save = useMutation({
    mutationFn: ({ role, key, checked }) => {
      const current = byRole[role.id] || {};
      const next = applyRecordPermissionToggle(current, key, checked);
      return request(`/api/custom-objects/${objectId}/permissions`, {
        method: "PUT",
        body: JSON.stringify({
          role_id: role.id,
          ...next,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-objects", objectId, "permissions"] });
      toast.success("Record permissions updated");
    },
    onError: (error) => toast.error(error.message),
  });
  if (permissionsQuery.error?.status === 403)
    return <PageState title="Permission denied" message="You do not have access to this object's permission settings." />;
  if (permissionsQuery.isLoading)
    return <Card><CardContent className="grid h-40 place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></CardContent></Card>;
  if (permissionsQuery.error)
    return <PageState title="Permissions could not be loaded" message={permissionsQuery.error.message} retry={permissionsQuery.refetch} />;
  return (
    <div className="space-y-5">
    <Card>
      <CardHeader><CardTitle className="text-lg">Record permissions by role</CardTitle><p className="text-sm text-slate-600">These capabilities control record work only. Manage Data Model remains a separate role feature.</p></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead><tr className="border-b text-left text-xs uppercase text-slate-500"><th className="p-3">Role</th>{permissionColumns.map(([key, label]) => <th key={key} className="p-3 text-center">{label}</th>)}</tr></thead>
           <tbody>{visibleRoles.map((role) => {
            const permission = normalizeRecordPermissions(byRole[role.id]);
             return <tr key={role.id} className="border-b last:border-0"><td className="p-3 font-medium">{role.name}</td>{permissionColumns.map(([key]) => <td key={key} className="p-3 text-center"><Checkbox disabled={!canManage || archived || save.isPending} checked={permission[key]} onCheckedChange={(checked) => save.mutate({ role, key, checked: Boolean(checked) })} /></td>)}</tr>;
          })}</tbody>
        </table>
        {!roles.length && <p className="py-8 text-center text-sm text-slate-500">No roles are available.</p>}
        {!!roles.length && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-4 text-sm">
            <span className="text-slate-500">{roles.length} role{roles.length === 1 ? "" : "s"}</span>
            <div className="flex items-center gap-2">
              <Button size="icon" variant="outline" aria-label="Previous permissions page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <span>Page {page} of {pages}</span>
              <Button size="icon" variant="outline" aria-label="Next permissions page" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    <CustomObjectFieldPermissionsEditor objectId={objectId} canManage={canManage} archived={archived} />
    </div>
  );
}

export function CustomObjectFieldPermissionsEditor({ objectId, canManage, archived = false }) {
  const qc = useQueryClient();
  const schema = useQuery({ queryKey: ["custom-objects", objectId, "record-fields"], queryFn: () => request(`/api/custom-objects/${objectId}/fields?includeInactive=false&pageSize=100`), retry: false });
  const permissions = useQuery({ queryKey: ["custom-objects", objectId, "field-permissions"], queryFn: () => request(`/api/custom-objects/${objectId}/field-permissions?pageSize=100`), retry: false });
  const rolesQuery = useQuery({ queryKey: ["custom-objects", objectId, "permissions", "roles"], queryFn: () => request(`/api/custom-objects/${objectId}/permissions?pageSize=100`), retry: false });
  const fields = readableFields(schema.data?.data || schema.data || []);
  const rows = permissions.data?.data || [];
  const roles = rolesQuery.data?.roles || [];
  const accessFor = (fieldId, roleId) => {
    const row = rows.find((item) => String(item.field_id) === String(fieldId) && String(item.role_id) === String(roleId));
    const access = row?.access || row?.access_level || row?.permission || "edit";
    return access === "edit" || access === "write" ? "write" : access;
  };
  const save = useMutation({
    mutationFn: ({ fieldId, roleId, access }) => request(`/api/custom-objects/${objectId}/field-permissions`, {
      method: "PUT", body: JSON.stringify({ field_id: fieldId, role_id: roleId, access_level: access === "write" ? "edit" : access }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custom-objects", objectId, "field-permissions"] }); toast.success("Field permission updated"); },
    onError: (error) => toast.error(error.message),
  });
  if (schema.isLoading || permissions.isLoading || rolesQuery.isLoading) return <Card><CardContent className="grid h-28 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></CardContent></Card>;
  if (schema.error || permissions.error || rolesQuery.error) return <Card className="border-rose-200"><CardContent className="py-5 text-sm text-rose-700">Field permissions could not be loaded. {(schema.error || permissions.error || rolesQuery.error).message}</CardContent></Card>;
  return <Card><CardHeader><CardTitle className="text-lg">Field access by role</CardTitle><p className="text-sm text-slate-600">No access hides a field; Read-only shows it without allowing changes; Edit allows changes. Fields without a rule retain legacy edit access.</p></CardHeader><CardContent className="overflow-x-auto">
    {!fields.length || !roles.length ? <p className="py-4 text-sm text-slate-500">Add active fields and roles to configure field access.</p> : <table className="w-full min-w-[700px] text-sm"><thead><tr className="border-b text-left text-xs uppercase text-slate-500"><th className="p-3">Field</th>{roles.map((role) => <th key={role.id} className="p-3">{role.name}</th>)}</tr></thead><tbody>{fields.map((field) => <tr key={field.id} className="border-b last:border-0"><td className="p-3 font-medium">{field.label}</td>{roles.map((role) => <td key={role.id} className="p-3"><Select disabled={!canManage || archived || save.isPending} value={accessFor(field.id, role.id)} onValueChange={(access) => save.mutate({ fieldId: field.id, roleId: role.id, access })}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No access</SelectItem><SelectItem value="read">Read-only</SelectItem><SelectItem value="write">Edit</SelectItem></SelectContent></Select></td>)}</tr>)}</tbody></table>}
  </CardContent></Card>;
}