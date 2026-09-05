import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronRight, CircleAlert, Loader2, Network, Pencil, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  loadActiveRelationshipObjects,
  loadCustomObjectFields,
  loadRelationshipDefinitions,
  relationshipRequest,
  relationshipRoutes,
} from "./relationshipApi";
import { canDefineRelationships, CARDINALITIES, defaultDefinitionForm, definitionList, definitionPayload, ENTITY_KINDS, labelForSide, relationshipSourceName, resolveRelationshipSourceObject } from "./relationshipHelpers";

const kindName = (kind) => ENTITY_KINDS.find(([value]) => value === kind)?.[1] || kind;

function DefinitionDialog({ objectId, object, definition, open, onOpenChange }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(defaultDefinitionForm(objectId));
  const objectsQuery = useQuery({
    queryKey: ["custom-objects", "active-for-relationships"],
    queryFn: () => loadActiveRelationshipObjects(),
    enabled: open,
  });
  useEffect(() => {
    setForm(definition ? { ...defaultDefinitionForm(objectId), ...definition, configuration: definition.configuration || {} } : defaultDefinitionForm(objectId));
  }, [definition, objectId, open]);
  const save = useMutation({
    mutationFn: () => relationshipRequest(
      definition ? relationshipRoutes.definition(objectId, definition.id) : relationshipRoutes.definitions(objectId),
      { method: definition ? "PATCH" : "POST", body: JSON.stringify(definitionPayload(form)) },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-objects", objectId, "relationships"] });
      toast.success(definition ? "Relationship definition saved" : "Relationship definition created");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const objects = objectsQuery.data?.data || objectsQuery.data || [];
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const valid = form.relationship_key.trim() && form.source_label.trim() && form.target_label.trim() &&
    (form.source_kind !== "custom_object" || form.source_custom_object_id) &&
    (form.target_kind !== "custom_object" || form.target_custom_object_id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{definition ? "Edit relationship" : "Define a relationship"}</DialogTitle>
          <DialogDescription>Describe each direction in the language your administrators use. The definition governs what record editors can see and change.</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <div className="grid gap-4 sm:grid-cols-[1fr_190px]">
            <div><Label>Relationship key</Label><Input disabled={Boolean(definition)} value={form.relationship_key} onChange={(e) => update("relationship_key", e.target.value)} placeholder="committee_membership" /><p className="mt-1 text-xs text-slate-500">{definition ? "Keys are immutable after creation." : "Stable lowercase key; spaces become underscores."}</p></div>
            <div><Label>Cardinality</Label><Select disabled={Boolean(definition)} value={form.cardinality} onValueChange={(value) => update("cardinality", value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{CARDINALITIES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Direction A — source</p>
            <DirectionFields side="source" form={form} update={update} objects={objects} objectsQuery={objectsQuery} currentObject={object} lockedKind="custom_object" immutable={Boolean(definition)} />
          </div>
          <div className="flex items-center gap-2 px-2 text-xs font-medium text-slate-400"><span className="h-px flex-1 bg-slate-200" /><ChevronRight className="h-4 w-4" /><span className="h-px flex-1 bg-slate-200" /></div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Direction B — target</p>
            <DirectionFields side="target" form={form} update={update} objects={objects} objectsQuery={objectsQuery} currentObject={object} immutable={Boolean(definition)} />
          </div>
          <div className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
            <Toggle label="Required link" hint="A record must have this relationship before it is complete." checked={form.is_required} onChange={(value) => update("is_required", value)} />
            <div className="border-l-0 sm:border-l sm:pl-5"><p className="text-sm font-medium text-slate-800">Availability</p><p className="mt-1 text-xs text-slate-500">Archived definitions remain in historic data but cannot be used for new links.</p><Select value={form.status} onValueChange={(value) => update("status", value)}><SelectTrigger className="mt-3"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent></Select></div>
          </div>
          <div><Label>Administrator note</Label><Textarea value={form.configuration?.note || ""} onChange={(e) => update("configuration", { ...form.configuration, note: e.target.value })} placeholder="Optional guidance for future model editors" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}{definition ? "Save changes" : "Create relationship"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DirectionFields({ side, form, update, objects, objectsQuery, currentObject, lockedKind, immutable }) {
  const kindKey = `${side}_kind`; const objectKey = `${side}_custom_object_id`; const labelKey = `${side}_label`;
  const otherSide = side === "source" ? "target" : "source";
  const activeObjects = objects.filter((item) => item.status === "active");
  const isFixedSource = side === "source" && lockedKind === "custom_object";
  const sourceObject = isFixedSource ? resolveRelationshipSourceObject({
    currentObject,
    sourceObjectId: form.source_custom_object_id,
    objects: activeObjects,
  }) : null;
  return <><div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]">
    <div><Label>Record type</Label><Select disabled={Boolean(lockedKind || immutable)} value={form[kindKey]} onValueChange={(value) => update(kindKey, value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ENTITY_KINDS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
    <div>{form[kindKey] === "custom_object" ? isFixedSource ? <><Label>Custom object</Label>{sourceObject ? <div className="flex h-9 items-center rounded-md border bg-white px-3 text-sm font-medium text-slate-700">{relationshipSourceName(sourceObject)}</div> : objectsQuery.isLoading ? <div className="flex h-9 items-center gap-2 rounded-md border bg-white px-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading source object…</div> : objectsQuery.error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700"><p>{objectsQuery.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => objectsQuery.refetch()}>Try again</Button></div> : <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">The source Custom Object is no longer available.</div>}<p className="mt-1 text-xs text-slate-500">The source endpoint is fixed for this relationship.</p></> : <><Label>Custom object</Label>{objectsQuery.isLoading ? <div className="flex h-9 items-center gap-2 rounded-md border bg-white px-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading active objects…</div> : objectsQuery.error ? <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700"><p>{objectsQuery.error.message}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => objectsQuery.refetch()}>Try again</Button></div> : activeObjects.length === 0 ? <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">No active Custom Objects are available. Activate a target object or check your access.</div> : <Select disabled={immutable} value={String(form[objectKey] || "")} onValueChange={(value) => update(objectKey, value)}><SelectTrigger><SelectValue placeholder="Choose active object" /></SelectTrigger><SelectContent>{activeObjects.map((item) => <SelectItem key={item.id} value={String(item.id)}>{item.plural_label}</SelectItem>)}</SelectContent></Select>}</> : <><Label>Endpoint</Label><div className="flex h-9 items-center rounded-md border bg-white px-3 text-sm text-slate-600">{kindName(form[kindKey])}</div></>}</div>
    <div><Label>Panel label</Label><Input value={form[labelKey]} onChange={(e) => update(labelKey, e.target.value)} placeholder={side === "source" ? "Members" : "Committees"} /></div>
    <div className="sm:col-span-3 grid gap-2 border-t pt-3 sm:grid-cols-2">
      <Toggle label={`Show ${side === "source" ? "this" : otherSide} panel`} hint="Visible on this endpoint's record page." checked={side === "source" ? form.show_on_source : form.show_on_target} onChange={(value) => update(side === "source" ? "show_on_source" : "show_on_target", value)} />
      <Toggle label={`Allow editing here`} hint="Administrators may add or remove links from this side." checked={side === "source" ? form.edit_from_source : form.edit_from_target} onChange={(value) => update(side === "source" ? "edit_from_source" : "edit_from_target", value)} />
    </div>
  </div><CompactPreviewSettings side={side} form={form} update={update} /></>;
}

// The configured side is the page being viewed; consequently its selected
// fields always belong to the *opposite* custom-object endpoint.
function CompactPreviewSettings({ side, form, update }) {
  const opposite = side === "source" ? "target" : "source";
  const objectId = form[`${opposite}_kind`] === "custom_object" ? form[`${opposite}_custom_object_id`] : null;
  const query = useQuery({
    queryKey: ["custom-objects", objectId, "compact-preview-fields"],
    queryFn: () => loadCustomObjectFields(objectId),
    enabled: Boolean(objectId),
  });
  if (!objectId) return <p className="mt-3 border-t pt-3 text-xs text-slate-500">Compact previews for {side} are supplied by the connected {kindName(form[`${opposite}_kind`])} record type.</p>;
  const fields = (query.data?.data || query.data || []).filter((field) => field.is_active !== false);
  const selected = form.configuration?.compact_preview?.[`${opposite}_field_ids`] || form.configuration?.compact_preview?.[opposite] || [];
  const setSelected = (fieldIds) => update("configuration", {
    ...form.configuration,
    compact_preview: { ...form.configuration?.compact_preview, [`${opposite}_field_ids`]: fieldIds },
  });
  return <div className="mt-3 border-t pt-3"><p className="text-sm font-medium text-slate-800">Related record preview</p><p className="mt-1 text-xs text-slate-500">Supporting values shown beneath the primary record label when viewing this side.</p>{query.isLoading ? <p className="mt-2 text-xs text-slate-500">Loading fields…</p> : query.error ? <p className="mt-2 text-xs text-rose-600">Preview fields could not be loaded.</p> : <div className="mt-2 grid gap-1 sm:grid-cols-2">{fields.map((field) => <label key={field.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.map(String).includes(String(field.id))} onChange={(event) => setSelected(event.target.checked ? [...selected, String(field.id)] : selected.filter((id) => String(id) !== String(field.id)))} />{field.label}</label>)}</div>}</div>;
}

function Toggle({ label, hint, checked, onChange }) {
  return <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-800">{label}</p><p className="mt-0.5 text-xs text-slate-500">{hint}</p></div><Switch checked={Boolean(checked)} onCheckedChange={onChange} /></div>;
}

export function RelationshipDefinitions({ objectId, object, canManage }) {
  const qc = useQueryClient(); const [open, setOpen] = useState(false); const [editing, setEditing] = useState(null);
  const relationshipReady = canDefineRelationships(object);
  const canCreate = canManage && relationshipReady;
  const query = useQuery({
    queryKey: ["custom-objects", objectId, "relationships", "all"],
    queryFn: () => loadRelationshipDefinitions(
      objectId,
      relationshipRequest,
      100,
      true,
    ),
  });
  const archive = useMutation({
    mutationFn: (definition) => relationshipRequest(relationshipRoutes.definition(objectId, definition.id), { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["custom-objects", objectId, "relationships"] }); toast.success("Relationship definition archived"); },
    onError: (error) => toast.error(error.message),
  });
  const definitions = useMemo(() => definitionList(query.data), [query.data]);
  if (query.isLoading) return <div className="space-y-3">{[1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg border bg-slate-100" />)}</div>;
  if (query.error) return <Card className="border-rose-200"><CardContent className="py-12 text-center"><CircleAlert className="mx-auto mb-3 h-7 w-7 text-rose-600" /><p className="font-medium">Relationship definitions could not be loaded</p><p className="mt-1 text-sm text-slate-600">{query.error.message}</p><Button variant="outline" className="mt-4" onClick={() => query.refetch()}>Try again</Button></CardContent></Card>;
  return <section className="space-y-4">
    <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-semibold text-slate-950">Relationship definitions</h2><p className="mt-1 text-sm text-slate-600">Configure trusted links and exactly where administrators can manage them.</p></div>{canCreate && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="mr-2 h-4 w-4" />New relationship</Button>}</div>
    {!relationshipReady && <Card className="border-amber-200 bg-amber-50/70"><CardContent className="flex gap-3 py-5"><CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><h3 className="font-semibold text-amber-950">{object?.status === "archived" ? "Archived objects cannot define relationships" : "Activate this Custom Object first"}</h3><p className="mt-1 text-sm text-amber-900">{object?.status === "archived" ? "Existing relationship history is preserved, but archived objects cannot create or change relationship definitions." : "Choose an active primary display field on the Overview tab and activate this object before defining relationships."}</p></div></CardContent></Card>}
    {!definitions.length ? <Card className="border-dashed"><CardContent className="py-14 text-center"><Network className="mx-auto mb-4 h-9 w-9 text-slate-400" /><h3 className="font-semibold text-slate-900">No relationships defined</h3><p className="mx-auto mt-2 max-w-md text-sm text-slate-600">Define how this object connects to members, organizations, groups, or another active custom object.</p>{canCreate && <Button variant="outline" className="mt-5" onClick={() => setOpen(true)}>Define first relationship</Button>}</CardContent></Card> : definitions.map((definition) => <Card key={definition.id} className={definition.status === "archived" ? "opacity-70" : ""}><CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-slate-900">{labelForSide(definition, "source")} <span className="mx-1 text-slate-300">to</span> {labelForSide(definition, "target")}</p><Badge variant="outline" className="capitalize">{definition.status || "active"}</Badge><Badge variant="outline">{CARDINALITIES.find(([v]) => v === definition.cardinality)?.[1] || definition.cardinality}</Badge></div><p className="mt-2 font-mono text-xs text-slate-500">{definition.relationship_key}</p><p className="mt-2 text-sm text-slate-600">{kindName(definition.source_kind)} <ChevronRight className="inline h-3.5 w-3.5" /> {kindName(definition.target_kind)} <span className="ml-2 text-slate-400">Visible: {definition.show_on_source !== false ? "source" : ""}{definition.show_on_source !== false && definition.show_on_target !== false ? " + " : ""}{definition.show_on_target !== false ? "target" : ""}</span></p></div>{canManage && relationshipReady && definition.status !== "archived" && <div className="flex shrink-0 gap-2"><Button variant="outline" size="sm" onClick={() => { setEditing(definition); setOpen(true); }}><Pencil className="mr-2 h-4 w-4" />Edit</Button><Button variant="outline" size="sm" className="text-rose-700 hover:bg-rose-50" disabled={archive.isPending} onClick={() => { if (window.confirm(`Archive “${definition.relationship_key}”? Existing links remain available for audit.`)) archive.mutate(definition); }}><Archive className="mr-2 h-4 w-4" />Archive</Button></div>}</CardContent></Card>)}
    <DefinitionDialog objectId={objectId} object={object} definition={editing} open={open && relationshipReady} onOpenChange={setOpen} />
  </section>;
}