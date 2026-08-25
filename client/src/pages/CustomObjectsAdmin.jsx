import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import {
  Archive,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Database,
  FileText,
  GripVertical,
  Layers3,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  Tag,
  TextCursorInput,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { COUNTRIES } from "@/data/countries";
import {
  ALLOWED_FILE_TYPES,
  FIELD_TYPES,
  activationReadiness,
  createFieldPayload,
  normaliseOptions,
  parseArray,
  validateFieldDefinition,
} from "./customObjects/fieldDefinition";
import { RelationshipDefinitions } from "./customObjects/RelationshipDefinitions";
import { AuditHistory } from "./customObjects/AuditHistory";
import { CustomObjectPermissionsEditor } from "./CustomObjectRecords";
const ICONS = [
  { key: "Boxes", Icon: Boxes },
  { key: "Database", Icon: Database },
  { key: "Layers3", Icon: Layers3 },
  { key: "FileText", Icon: FileText },
  { key: "Tag", Icon: Tag },
  { key: "Network", Icon: Network },
];
const listKey = ["custom-objects"];
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.message || body.error || `Request failed (${response.status})`,
    );
  return body;
};
const keyFromLabel = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
const statusClass = (status) =>
  status === "active"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : status === "draft"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-slate-100 text-slate-600 border-slate-200";

function AccessGate({ children }) {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!isAccessReady) return;
    if (
      isFeatureExcluded("data.custom-objects") ||
      isFeatureExcluded("page_CustomObjectsAdmin")
    )
      window.location.href = createPageUrl("Events");
    else setChecked(true);
  }, [isAccessReady, isFeatureExcluded]);
  if (!checked)
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-7 w-7 animate-spin text-slate-400" />
      </div>
    );
  return children;
}

function ErrorState({ error, retry }) {
  return (
    <Card className="border-rose-200 bg-rose-50/50">
      <CardContent className="py-10 text-center">
        <CircleAlert className="mx-auto mb-3 h-7 w-7 text-rose-600" />
        <p className="font-medium text-slate-900">
          We could not load this schema.
        </p>
        <p className="mt-1 text-sm text-slate-600">{error.message}</p>
        <Button className="mt-4" variant="outline" onClick={retry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function ObjectDialog({ open, onOpenChange }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    singular_label: "",
    plural_label: "",
    object_key: "",
    description: "",
    icon: "Boxes",
  });
  const create = useMutation({
    mutationFn: () =>
      api("/api/custom-objects", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          object_key: keyFromLabel(form.object_key),
          status: "draft",
        }),
      }),
    onSuccess: (object) => {
      qc.invalidateQueries({ queryKey: listKey });
      toast.success("Draft object created");
      onOpenChange(false);
      navigate(`/CustomObjectsAdmin/${object.id}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const update = (name, value) =>
    setForm((current) => ({
      ...current,
      [name]: value,
      ...(name === "singular_label" && !current.object_key
        ? { object_key: keyFromLabel(value) }
        : {}),
    }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create a custom object</DialogTitle>
          <DialogDescription>
            Start with a draft. You can add fields, review readiness, then
            activate when the model is safe to use.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="singular">Singular label</Label>
              <Input
                id="singular"
                value={form.singular_label}
                onChange={(event) =>
                  update("singular_label", event.target.value)
                }
                placeholder="Committee"
              />
            </div>
            <div>
              <Label htmlFor="plural">Plural label</Label>
              <Input
                id="plural"
                value={form.plural_label}
                onChange={(event) => update("plural_label", event.target.value)}
                placeholder="Committees"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="object-key">Object key</Label>
            <Input
              id="object-key"
              value={form.object_key}
              onChange={(event) =>
                update("object_key", keyFromLabel(event.target.value))
              }
              placeholder="committee"
            />
            <p className="mt-1 text-xs text-slate-500">
              Lowercase underscore key. It is permanent after creation.
            </p>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={form.description}
              onChange={(event) => update("description", event.target.value)}
              placeholder="What does this object help your association track?"
            />
          </div>
          <div>
            <Label>Marker icon</Label>
            <div className="mt-2 flex gap-2">
              {ICONS.map(({ key, Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => update("icon", key)}
                  className={`grid h-10 w-10 place-items-center rounded-md border transition-colors ${form.icon === key ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !form.singular_label ||
              !form.plural_label ||
              !form.object_key ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {create.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomObjectsAdmin() {
  return (
    <AccessGate>
      <Catalogue />
    </AccessGate>
  );
}
function Catalogue() {
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [newOpen, setNewOpen] = useState(false);
  const { isFeatureExcluded } = useMemberAccess();
  const canManage = !isFeatureExcluded("data.custom-objects.manage-data-model");
  const query = useQuery({
    queryKey: [...listKey, "catalogue", status, page, pageSize],
    queryFn: () => {
      const params = new URLSearchParams({
        includeArchived: "true",
        page: String(page),
        pageSize: String(pageSize),
      });
      if (status !== "all") params.set("status", status);
      return api(`/api/custom-objects?${params}`);
    },
    placeholderData: (previous) => previous,
  });
  const objects = query.data?.data || [];
  const visible = objects;
  const total = query.data?.total ?? objects.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <main className="min-h-screen bg-slate-50/70 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
              <Database className="h-4 w-4" />
              Data studio
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
              Custom objects
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Shape the records unique to your association. Draft changes stay
              contained until you decide the structure is ready.
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New custom object
            </Button>
          )}
        </header>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["all", "All objects"],
            ["active", "Active"],
            ["draft", "Drafts"],
            ["archived", "Archived"],
          ].map(([key, label]) => (
            <button
              onClick={() => {
                setStatus(key);
                setPage(1);
              }}
              key={key}
              className={`rounded-lg border p-3 text-left transition-all ${status === key ? "border-blue-300 bg-blue-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300"}`}
            >
              <span className="block text-2xl font-semibold text-slate-900">
                {status === key ? total : "—"}
              </span>
              <span className="text-xs font-medium text-slate-500">
                {label}
              </span>
            </button>
          ))}
        </section>
        {query.isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-20 animate-pulse rounded-lg border border-slate-200 bg-white"
              />
            ))}
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} retry={query.refetch} />
        ) : total === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-16 text-center">
              <Boxes className="mx-auto mb-4 h-9 w-9 text-slate-400" />
              <h2 className="font-semibold text-slate-900">
                {status === "all"
                  ? "Your data studio is ready for its first object"
                  : `No ${status} objects`}
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
                {status === "all"
                  ? "Create a draft to define a new type of association record without affecting existing data."
                  : "Try another lifecycle filter to review your object catalogue."}
              </p>
              {canManage && status === "all" && (
                <Button className="mt-5" onClick={() => setNewOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create custom object
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="hidden grid-cols-[minmax(250px,1fr)_120px_110px_130px_36px] gap-4 border-b bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid">
                <span>Object</span>
                <span>Status</span>
                <span>Records</span>
                <span>Model</span>
                <span />
              </div>
              {visible.map((object) => {
                const Icon =
                  ICONS.find((item) => item.key === object.icon)?.Icon || Boxes;
                return (
                  <Link
                    to={
                      object.status === "active"
                        ? `/CustomObjectsAdmin/${object.id}/records`
                        : `/CustomObjectsAdmin/${object.id}`
                    }
                    key={object.id}
                    className="grid items-center gap-3 border-b px-4 py-4 last:border-0 transition-colors hover:bg-slate-50 md:grid-cols-[minmax(250px,1fr)_120px_110px_130px_36px] md:px-5"
                  >
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-100 text-slate-600">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">
                          {object.plural_label}
                        </p>
                        <p className="font-mono text-xs text-slate-500">
                          {object.object_key}
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={`w-fit capitalize ${statusClass(object.status)}`}
                    >
                      {object.status}
                    </Badge>
                    <span className="text-sm text-slate-700">
                      {object.record_count || 0} records
                    </span>
                    <span className="text-sm text-slate-600">
                      {object.field_count || 0} fields{" "}
                      <span className="text-slate-300">/</span>{" "}
                      {object.relationship_count || 0} relationships
                    </span>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </Link>
                );
              })}
              {visible.length === 0 && (
                <div className="border-b px-5 py-12 text-center">
                  <p className="font-medium text-slate-900">No {status} objects</p>
                  <p className="mt-1 text-sm text-slate-500">Choose another lifecycle filter.</p>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-sm">
                <span className="text-slate-500">{total} object{total === 1 ? "" : "s"}</span>
                <div className="flex items-center gap-2">
                  <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1); }}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>{[10, 25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="icon" variant="outline" aria-label="Previous catalogue page" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                  <span>Page {page} of {pages}</span>
                  <Button size="icon" variant="outline" aria-label="Next catalogue page" disabled={page >= pages || query.isFetching} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}{" "}
        {!canManage && (
          <p className="text-center text-xs text-slate-500">
            You have read-only access to this data model.
          </p>
        )}
      </div>
      <ObjectDialog open={newOpen} onOpenChange={setNewOpen} />
    </main>
  );
}

export function CustomObjectDetail() {
  return (
    <AccessGate>
      <Detail />
    </AccessGate>
  );
}
function Detail() {
  const { objectId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isFeatureExcluded } = useMemberAccess();
  const canManage = !isFeatureExcluded("data.custom-objects.manage-data-model");
  const objectQuery = useQuery({
    queryKey: [...listKey, objectId],
    queryFn: () => api(`/api/custom-objects/${objectId}`),
  });
  const fieldsQuery = useQuery({
    queryKey: [...listKey, objectId, "fields"],
    queryFn: () =>
      api(`/api/custom-objects/${objectId}/fields?includeInactive=true`),
  });
  const relationshipsQuery = useQuery({
    queryKey: [...listKey, objectId, "relationships"],
    queryFn: () =>
      api(`/api/custom-objects/${objectId}/relationship-definitions`),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: listKey });
  };
  const archive = useMutation({
    mutationFn: () =>
      api(`/api/custom-objects/${objectId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Object archived. Its record data was preserved.");
      invalidate();
      navigate("/CustomObjectsAdmin");
    },
    onError: (error) => toast.error(error.message),
  });
  const activate = useMutation({
    mutationFn: () =>
      api(`/api/custom-objects/${objectId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      }),
    onSuccess: () => {
      toast.success("Custom object activated");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  if (objectQuery.isLoading)
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="h-8 w-48 animate-pulse rounded bg-slate-200" />
          <div className="h-72 animate-pulse rounded-lg bg-white" />
        </div>
      </main>
    );
  if (objectQuery.error)
    return (
      <main className="min-h-screen bg-slate-50 p-4 md:p-8">
        <div className="mx-auto max-w-5xl">
          <ErrorState error={objectQuery.error} retry={objectQuery.refetch} />
        </div>
      </main>
    );
  const object = objectQuery.data;
  const fields = fieldsQuery.data?.data || fieldsQuery.data || [];
  const relationshipCount = Array.isArray(relationshipsQuery.data)
    ? relationshipsQuery.data.length
    : (relationshipsQuery.data?.total ?? object.relationship_count ?? 0);
  const activeFields = fields.filter((field) => field.is_active !== false);
  const readiness = activationReadiness(object, activeFields);
  const ready = readiness.every((item) => item.done);
  return (
    <main className="min-h-screen bg-slate-50/70 p-4 md:p-8">
      <div className="mx-auto max-w-6xl">
        <Link
          to="/CustomObjectsAdmin"
          className="mb-5 inline-flex items-center text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          All custom objects
        </Link>
        <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                {object.plural_label}
              </h1>
              <Badge
                variant="outline"
                className={`capitalize ${statusClass(object.status)}`}
              >
                {object.status}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {object.description || "No description has been added."}
            </p>
            <p className="mt-2 font-mono text-xs text-slate-500">
              Permanent key: {object.object_key}
            </p>
          </div>
          {canManage && object.status !== "archived" && (
            <Button
              variant="outline"
              className="text-rose-700 hover:bg-rose-50 hover:text-rose-800"
              disabled={archive.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Archive ${object.plural_label}? Existing records will be kept.`,
                  )
                )
                  archive.mutate();
              }}
            >
              <Archive className="mr-2 h-4 w-4" />
              Archive object
            </Button>
          )}
        </header>
        <Tabs defaultValue="overview" className="mt-6">
          <TabsList className="bg-white">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="records">Records</TabsTrigger>
            <TabsTrigger value="fields">
              Fields{" "}
              <span className="ml-1 text-xs text-slate-500">
                {fields.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="relationships">
              Relationships{" "}
              <span className="ml-1 text-xs text-slate-500">
                {relationshipCount}
              </span>
            </TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="audit">Audit history</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-5">
            <Overview
              object={object}
              fields={activeFields}
              canManage={canManage && object.status !== "archived"}
              onSaved={invalidate}
              readiness={readiness}
              ready={ready}
              onActivate={() => activate.mutate()}
              activating={activate.isPending}
            />
          </TabsContent>
          <TabsContent value="fields" className="mt-5">
            <Fields
              objectId={objectId}
              fields={fields}
              loading={fieldsQuery.isLoading}
              error={fieldsQuery.error}
              retry={fieldsQuery.refetch}
              canManage={canManage && object.status !== "archived"}
              primaryDisplayFieldId={object.primary_display_field_id}
              onChanged={invalidate}
            />
          </TabsContent>
          <TabsContent value="records" className="mt-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Record workspace</CardTitle>
                <CardDescription>
                  Search, filter, add, edit, and archive records using this
                  object&apos;s field definitions.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link to={`/CustomObjectsAdmin/${objectId}/records`}>
                    Open {object.plural_label}
                    <ChevronRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="relationships" className="mt-5">
            <RelationshipDefinitions
              objectId={objectId}
              object={object}
              canManage={canManage && object.status !== "archived"}
            />
          </TabsContent>
          <TabsContent value="permissions" className="mt-5">
            <CustomObjectPermissionsEditor
              objectId={objectId}
              canManage={canManage}
              archived={object.status === "archived"}
            />
          </TabsContent>
          <TabsContent value="audit" className="mt-5">
            <AuditHistory objectId={objectId} request={api} />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function Overview({
  object,
  fields,
  canManage,
  onSaved,
  readiness,
  ready,
  onActivate,
  activating,
}) {
  const [form, setForm] = useState({
    singular_label: object.singular_label || "",
    plural_label: object.plural_label || "",
    description: object.description || "",
    icon: object.icon || "Boxes",
    primary_display_field_id: object.primary_display_field_id || "",
  });
  useEffect(
    () =>
      setForm({
        singular_label: object.singular_label || "",
        plural_label: object.plural_label || "",
        description: object.description || "",
        icon: object.icon || "Boxes",
        primary_display_field_id: object.primary_display_field_id || "",
      }),
    [object],
  );
  const save = useMutation({
    mutationFn: () =>
      api(`/api/custom-objects/${object.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...form,
          primary_display_field_id: form.primary_display_field_id || null,
        }),
      }),
    onSuccess: () => {
      toast.success("Object details saved");
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_290px]">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Object identity</CardTitle>
          <CardDescription>
            Labels and descriptions can evolve. The system key cannot.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Singular label</Label>
              <Input
                disabled={!canManage}
                value={form.singular_label}
                onChange={(e) =>
                  setForm({ ...form, singular_label: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Plural label</Label>
              <Input
                disabled={!canManage}
                value={form.plural_label}
                onChange={(e) =>
                  setForm({ ...form, plural_label: e.target.value })
                }
              />
            </div>
          </div>
          <div>
            <Label>Object key</Label>
            <Input
              value={object.object_key}
              disabled
              className="font-mono bg-slate-50 text-slate-500"
            />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              disabled={!canManage}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>
          <div>
            <Label>Marker icon</Label>
            <div className="mt-2 flex gap-2">
              {ICONS.map(({ key, Icon }) => (
                <button
                  disabled={!canManage}
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, icon: key })}
                  className={`grid h-9 w-9 place-items-center rounded-md border ${form.icon === key ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500"} disabled:opacity-60`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Primary display field</Label>
            <Select
              disabled={!canManage || fields.length === 0}
              value={form.primary_display_field_id || "none"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  primary_display_field_id: value === "none" ? "" : value,
                })
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    fields.length
                      ? "Choose a field"
                      : "Add an active field first"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No primary field yet</SelectItem>
                {fields.map((field) => (
                  <SelectItem key={field.id} value={field.id}>
                    {field.label}{" "}
                    <span className="text-slate-400">({field.field_type})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canManage && (
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save changes
            </Button>
          )}
        </CardContent>
      </Card>
      <div className="space-y-5">
        <Card
          className={
            object.status === "active"
              ? "border-emerald-200"
              : "border-amber-200"
          }
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Activation readiness
            </CardTitle>
            <CardDescription>
              {object.status === "active"
                ? "This object is available for records."
                : "Draft objects are invisible to everyday record work."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {readiness.map((item) => (
              <div key={item.label} className="flex items-center gap-2 text-sm">
                <CheckCircle2
                  className={`h-4 w-4 ${item.done ? "text-emerald-600" : "text-slate-300"}`}
                />
                <span
                  className={item.done ? "text-slate-700" : "text-slate-500"}
                >
                  {item.label}
                </span>
              </div>
            ))}
            {canManage && object.status === "draft" && (
              <Button
                className="mt-2 w-full"
                disabled={!ready || activating}
                onClick={onActivate}
              >
                {activating && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Activate object
              </Button>
            )}
            {object.status === "draft" && !ready && (
              <p className="text-xs text-slate-500">
                Complete both checks before activation.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Current model
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div>
                <strong className="block text-lg">
                  {object.record_count || 0}
                </strong>
                <span className="text-xs text-slate-500">records</span>
              </div>
              <div>
                <strong className="block text-lg">
                  {object.field_count || 0}
                </strong>
                <span className="text-xs text-slate-500">fields</span>
              </div>
              <div>
                <strong className="block text-lg">
                  {object.relationship_count || 0}
                </strong>
                <span className="text-xs text-slate-500">relations</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Fields({
  objectId,
  fields,
  loading,
  error,
  retry,
  canManage,
  primaryDisplayFieldId,
  onChanged,
}) {
  const [dialog, setDialog] = useState(null);
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: [...listKey, objectId, "fields"] });
    onChanged();
  };
  const archive = useMutation({
    mutationFn: (fieldId) =>
      api(`/api/custom-objects/${objectId}/fields/${fieldId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Field archived. Existing record values were preserved.");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const reorder = async (result) => {
    if (!result.destination || !canManage) return;
    const items = [...fields];
    const [moved] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, moved);
    try {
      await Promise.all(
        items.map((field, index) =>
          field.display_order === index
            ? Promise.resolve()
            : api(`/api/custom-objects/${objectId}/fields/${field.id}`, {
                method: "PATCH",
                body: JSON.stringify({ display_order: index }),
              }),
        ),
      );
      refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-lg">Fields</CardTitle>
          <CardDescription>
            Drag to define display order. Field keys are permanent once created.
          </CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setDialog({})}>
            <Plus className="mr-2 h-4 w-4" />
            Add field
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((item) => (
              <div
                className="h-14 animate-pulse rounded bg-slate-100"
                key={item}
              />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} retry={retry} />
        ) : fields.length === 0 ? (
          <div className="rounded-lg border border-dashed py-12 text-center">
            <TextCursorInput className="mx-auto mb-3 h-8 w-8 text-slate-400" />
            <p className="font-medium text-slate-800">No fields yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
              Add the first field to give this object a usable record structure.
            </p>
            {canManage && (
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setDialog({})}
              >
                Add first field
              </Button>
            )}
          </div>
        ) : (
          <DragDropContext onDragEnd={reorder}>
            <Droppable droppableId="fields">
              {(provided) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className="divide-y rounded-lg border"
                >
                  {fields
                    .slice()
                    .sort(
                      (a, b) => (a.display_order || 0) - (b.display_order || 0),
                    )
                    .map((field, index) => (
                      <Draggable
                        draggableId={String(field.id)}
                        index={index}
                        key={field.id}
                        isDragDisabled={!canManage}
                      >
                        {(drag) => (
                          <div
                            ref={drag.innerRef}
                            {...drag.draggableProps}
                            className={`flex items-center gap-3 p-3 ${field.is_active === false ? "bg-slate-50 opacity-60" : "bg-white"}`}
                          >
                            <span
                              {...drag.dragHandleProps}
                              className="text-slate-400"
                            >
                              <GripVertical className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="font-medium text-sm text-slate-900">
                                  {field.label}
                                </p>
                                {field.id === primaryDisplayFieldId && (
                                  <Badge
                                    variant="outline"
                                    className="border-blue-200 bg-blue-50 text-blue-700"
                                  >
                                    Primary display
                                  </Badge>
                                )}
                                {field.is_required && (
                                  <Badge
                                    variant="outline"
                                    className="border-amber-200 bg-amber-50 text-amber-700"
                                  >
                                    Required
                                  </Badge>
                                )}
                                {field.is_active === false && (
                                  <Badge variant="outline">Archived</Badge>
                                )}
                              </div>
                              <p className="font-mono text-xs text-slate-500">
                                {field.name}{" "}
                                <span className="font-sans">
                                  ·{" "}
                                  {FIELD_TYPES.find(
                                    ([value]) => value === field.field_type,
                                  )?.[1] || field.field_type}
                                </span>
                              </p>
                            </div>
                            {canManage && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setDialog(field)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                {field.id !== primaryDisplayFieldId && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-rose-600 hover:text-rose-700"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `Archive ${field.label}? Existing values will be kept.`,
                                        )
                                      )
                                        archive.mutate(field.id);
                                    }}
                                  >
                                    <Archive className="h-4 w-4" />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </Draggable>
                    ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </CardContent>
      {dialog && (
        <FieldDialog
          objectId={objectId}
          field={dialog.id ? dialog : null}
          order={fields.length}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function FieldDialog({ objectId, field, order, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: field?.name || "",
    label: field?.label || "",
    field_type: field?.field_type || "text",
    is_required: field?.is_required || false,
    options: normaliseOptions(field?.options),
    min_selections: field?.min_selections ?? "",
    max_selections: field?.max_selections ?? "",
    min_length: field?.min_length ?? "",
    max_length: field?.max_length ?? "",
    allowed_file_types: parseArray(field?.allowed_file_types),
    public_access: field?.public_access === true,
    all_countries: field?.all_countries !== false,
    selected_countries: parseArray(field?.selected_countries),
    default_country: field?.default_country || "",
    default_countries: parseArray(field?.default_countries),
    is_active: field?.is_active !== false,
  }));
  const mutation = useMutation({
    mutationFn: () => {
      const error = validateFieldDefinition(form);
      if (error) throw new Error(error);
      const data = createFieldPayload(form, field, order);
      return field
        ? api(`/api/custom-objects/${objectId}/fields/${field.id}`, {
            method: "PATCH",
            body: JSON.stringify(data),
          })
        : api(`/api/custom-objects/${objectId}/fields`, {
            method: "POST",
            body: JSON.stringify(data),
          });
    },
    onSuccess: () => {
      toast.success(field ? "Field updated" : "Field created");
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });
  const optionType = ["picklist", "dropdown"].includes(form.field_type);
  const toggleCountry = (code) =>
    setForm({
      ...form,
      selected_countries: form.selected_countries.includes(code)
        ? form.selected_countries.filter((item) => item !== code)
        : [...form.selected_countries, code],
    });
  const availableCountries = COUNTRIES.filter(
    (country) =>
      form.all_countries || form.selected_countries.includes(country.code),
  );
  const toggleDefaultCountry = (code) =>
    setForm((current) => ({
      ...current,
      default_countries: current.default_countries.includes(code)
        ? current.default_countries.filter(
            (countryCode) => countryCode !== code,
          )
        : [...current.default_countries, code],
    }));
  useEffect(() => {
    if (!form.all_countries) {
      const allowed = new Set(form.selected_countries);
      const defaultCountries = form.default_countries.filter((code) =>
        allowed.has(code),
      );
      if (
        defaultCountries.length !== form.default_countries.length ||
        (form.default_country && !allowed.has(form.default_country))
      ) {
        setForm((current) => ({
          ...current,
          default_country: allowed.has(current.default_country)
            ? current.default_country
            : "",
          default_countries: current.default_countries.filter((code) =>
            allowed.has(code),
          ),
        }));
      }
    }
  }, [
    form.all_countries,
    form.selected_countries,
    form.default_country,
    form.default_countries,
  ]);
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{field ? "Edit field" : "Add field"}</DialogTitle>
          <DialogDescription>
            {field
              ? "The field key stays fixed to protect record data."
              : "Choose a clear label and a stable key before saving."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Label</Label>
              <Input
                value={form.label}
                onChange={(event) =>
                  setForm({
                    ...form,
                    label: event.target.value,
                    ...(!field && !form.name
                      ? { name: keyFromLabel(event.target.value) }
                      : {}),
                  })
                }
              />
            </div>
            <div>
              <Label>Field key</Label>
              <Input
                disabled={!!field}
                className={field ? "font-mono bg-slate-50" : "font-mono"}
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: keyFromLabel(event.target.value) })
                }
              />
            </div>
          </div>
          <div>
            <Label>Field type</Label>
            <Select
              disabled={!!field}
              value={form.field_type}
              onValueChange={(field_type) => setForm({ ...form, field_type })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label>Required on future saves</Label>
              <p className="mt-1 text-xs text-slate-500">
                Required fields do not populate existing records. New and
                updated records must supply a value.
              </p>
            </div>
            <Switch
              checked={form.is_required}
              onCheckedChange={(is_required) =>
                setForm({ ...form, is_required })
              }
            />
          </div>
          {optionType && (
            <div className="space-y-2">
              <Label>Ordered options</Label>
              {form.options.map((option, index) => (
                <div className="flex gap-2" key={index}>
                  <Input
                    value={option.value}
                    placeholder="Stored value"
                    onChange={(event) =>
                      setForm({
                        ...form,
                        options: form.options.map((item, position) =>
                          position === index
                            ? { ...item, value: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <Input
                    value={option.label}
                    placeholder="Visible label"
                    onChange={(event) =>
                      setForm({
                        ...form,
                        options: form.options.map((item, position) =>
                          position === index
                            ? { ...item, label: event.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setForm({
                        ...form,
                        options: form.options.filter(
                          (_, position) => position !== index,
                        ),
                      })
                    }
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm({
                    ...form,
                    options: [...form.options, { value: "", label: "" }],
                  })
                }
              >
                <Plus className="mr-2 h-3 w-3" />
                Add option
              </Button>
            </div>
          )}
          {form.field_type === "picklist" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Minimum selections</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.min_selections}
                  onChange={(event) =>
                    setForm({ ...form, min_selections: event.target.value })
                  }
                />
              </div>
              <div>
                <Label>Maximum selections</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.max_selections}
                  onChange={(event) =>
                    setForm({ ...form, max_selections: event.target.value })
                  }
                />
              </div>
            </div>
          )}
          {form.field_type === "textarea" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Minimum length</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.min_length}
                  onChange={(event) =>
                    setForm({ ...form, min_length: event.target.value })
                  }
                />
              </div>
              <div>
                <Label>Maximum length</Label>
                <Input
                  type="number"
                  min="0"
                  value={form.max_length}
                  onChange={(event) =>
                    setForm({ ...form, max_length: event.target.value })
                  }
                />
              </div>
            </div>
          )}
          {form.field_type === "file" && (
            <div className="space-y-3 rounded-md border p-3">
              <Label>Allowed file types</Label>
              <div className="grid grid-cols-2 gap-2">
                {ALLOWED_FILE_TYPES.map(([value, label]) => (
                  <label
                    key={value}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.allowed_file_types.includes(value)}
                      onChange={() =>
                        setForm({
                          ...form,
                          allowed_file_types: form.allowed_file_types.includes(
                            value,
                          )
                            ? form.allowed_file_types.filter(
                                (item) => item !== value,
                              )
                            : [...form.allowed_file_types, value],
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <span className="text-sm">Public file access</span>
                <Switch
                  checked={form.public_access}
                  onCheckedChange={(public_access) =>
                    setForm({ ...form, public_access })
                  }
                />
              </div>
            </div>
          )}
          {["country", "countries"].includes(form.field_type) && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Available countries</Label>
                  <p className="text-xs text-slate-500">
                    Limit choices or include all countries.
                  </p>
                </div>
                <Switch
                  checked={form.all_countries}
                  onCheckedChange={(all_countries) =>
                    setForm({ ...form, all_countries })
                  }
                />
              </div>
              {!form.all_countries && (
                <div className="max-h-40 space-y-1 overflow-y-auto border-t pt-2">
                  {COUNTRIES.map((country) => (
                    <label
                      key={country.code}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={form.selected_countries.includes(country.code)}
                        onChange={() => toggleCountry(country.code)}
                      />
                      {country.name}
                    </label>
                  ))}
                </div>
              )}
              <Label>
                Default{" "}
                {form.field_type === "country" ? "country" : "countries"}
              </Label>
              {form.field_type === "country" ? (
                <Select
                  value={form.default_country || "none"}
                  onValueChange={(default_country) =>
                    setForm({
                      ...form,
                      default_country:
                        default_country === "none" ? "" : default_country,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No default</SelectItem>
                    {availableCountries.map((country) => (
                      <SelectItem value={country.code} key={country.code}>
                        {country.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="max-h-32 space-y-1 overflow-y-auto rounded border p-2">
                  {availableCountries.map((country) => (
                    <label
                      key={country.code}
                      className="flex items-center gap-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={form.default_countries.includes(country.code)}
                        onChange={() => toggleDefaultCountry(country.code)}
                      />
                      {country.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {form.field_type === "list" && (
            <div className="rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
              List fields accept user-defined values per record. They do not
              have a central option catalogue.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!form.name || !form.label || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {field ? "Save field" : "Create field"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
