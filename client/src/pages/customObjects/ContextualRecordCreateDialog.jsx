import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RecordFieldControl } from "./RecordFieldControls";
import { buildRecordPayload, validateRecordValues } from "./recordHelpers";
import { loadRelationshipDefinitions, relationshipRequest, relationshipRoutes } from "./relationshipApi";
import { initialRelationshipSelectors, isRequiredInitialRelationship, oppositeSide, relationshipSelectorKey } from "./relationshipHelpers";

const defaultsFor = (fields) => Object.fromEntries(fields.map((field) => [
  field.name,
  field.field_type === "country" ? field.default_country || ""
    : field.field_type === "countries" ? field.default_countries || []
      : field.field_type === "boolean" ? false : "",
]));

const detailsToErrors = (details) => Object.fromEntries(
  (Array.isArray(details) ? details : []).filter((item) => item.field).map((item) => [
    String(item.field).startsWith("relationship") || String(item.field).startsWith("initial_relationship")
      ? "_relationships" : item.field,
    item.message,
  ]),
);

function InitialRelationshipSelector({ selector, objectId, value, onChange, error, fixed }) {
  const { definition, side } = selector;
  const required = isRequiredInitialRelationship(definition, side);
  const query = useQuery({
    queryKey: ["initial-relationship-candidates", objectId, definition.id, side],
    queryFn: () => relationshipRequest(relationshipRoutes.initialRelationshipCandidates(objectId, {
      definitionId: definition.id, side, page: 1, pageSize: 100,
    })),
    enabled: !fixed,
  });
  const entries = query.data?.data || [];
  const label = side === "source" ? definition.target_label : definition.source_label;
  if (fixed) return <p className="rounded-md border bg-slate-50 px-3 py-2 text-sm text-slate-600">{label || "Origin record"} will be linked when this record is created.</p>;
  return <div><Label>{label || "Related record"}{required && <span className="ml-1 text-rose-600">*</span>}</Label><Select disabled={query.isLoading || query.isError || !entries.length} value={value || undefined} onValueChange={onChange}><SelectTrigger className="mt-2"><SelectValue placeholder={query.isLoading ? "Loading eligible records…" : query.isError ? "Records could not be loaded" : !entries.length ? "No eligible records" : "Choose a record"} /></SelectTrigger><SelectContent>{entries.map((entry) => <SelectItem key={entry.id} value={String(entry.id)}>{entry.primary_label || entry.display_value || entry.name || "Untitled record"}</SelectItem>)}</SelectContent></Select>{query.isLoading && <p className="mt-1 text-sm text-slate-500">Loading eligible records…</p>}{query.error && <p className="mt-1 text-sm text-rose-600">{query.error.message} <button className="underline" type="button" onClick={() => query.refetch()}>Retry</button></p>}{!query.isLoading && !query.error && !entries.length && <p className="mt-1 text-sm text-slate-500">No eligible records are available for this relationship.</p>}{error && <p className="mt-1 text-sm text-rose-600">{error}</p>}</div>;
}

export function ContextualRecordCreateDialog({ originContext, originDefinition, originSide, targetObject, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [relationships, setRelationships] = useState({});
  const [errors, setErrors] = useState({});
  const qc = useQueryClient();
  const fieldsQuery = useQuery({ queryKey: ["custom-objects", targetObject.id, "record-fields"], queryFn: () => relationshipRequest(`/api/custom-objects/${targetObject.id}/fields?includeInactive=true&pageSize=100`), enabled: open });
  const definitionsQuery = useQuery({ queryKey: ["contextual-create-definitions", targetObject.id], queryFn: () => loadRelationshipDefinitions(targetObject.id), enabled: open });
  const fields = (fieldsQuery.data?.data || fieldsQuery.data || []).filter((field) => field.is_active !== false);
  const selectors = useMemo(() => {
    const available = initialRelationshipSelectors(definitionsQuery.data, { kind: "custom_object", objectId: targetObject.id });
    const origin = { definition: originDefinition, side: oppositeSide(originSide), fixed: true };
    const originKey = relationshipSelectorKey(originDefinition.id, origin.side);
    return [origin, ...available.filter(({ definition, side }) => relationshipSelectorKey(definition.id, side) !== originKey)];
  }, [definitionsQuery.data, targetObject.id, originDefinition, originSide]);
  useEffect(() => {
    if (open && fields.length) setValues(defaultsFor(fields));
  }, [open, fieldsQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = useMutation({
    mutationFn: (payload) => relationshipRequest(relationshipRoutes.createWithRelationships(targetObject.id), { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-object-records", targetObject.id] });
      qc.invalidateQueries({ queryKey: ["record-relationships", originContext.kind, originContext.objectId, originContext.recordId, originDefinition.id, originSide] });
      qc.invalidateQueries({ queryKey: ["related-record-definitions", originContext.kind, originContext.objectId, originContext.recordId] });
      qc.invalidateQueries({ queryKey: ["custom-object-record", originContext.objectId, originContext.recordId] });
      toast.success(`${targetObject.singular_label || "Record"} created`);
      setOpen(false);
    },
    onError: (error) => {
      const mapped = detailsToErrors(error.details);
      setErrors(Object.keys(mapped).length ? mapped : { _relationships: error.message });
      toast.error(error.message);
    },
  });
  const submit = (event) => {
    event.preventDefault();
    const fieldErrors = validateRecordValues(fields, values);
    for (const selector of selectors) {
      const key = relationshipSelectorKey(selector.definition.id, selector.side);
      if (!selector.fixed && isRequiredInitialRelationship(selector.definition, selector.side) && !relationships[key])
        fieldErrors[`relationship:${key}`] = `${selector.definition.source_label || selector.definition.target_label || "Relationship"} is required`;
    }
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;
    create.mutate({
      ...buildRecordPayload(fields, values),
      originating_relationship: {
        relationship_definition_id: originDefinition.id,
        routed_side: oppositeSide(originSide),
        related_record_id: originContext.recordId,
      },
      initial_relationships: [
        ...selectors.filter((item) => !item.fixed && relationships[relationshipSelectorKey(item.definition.id, item.side)]).map(({ definition, side }) => ({ relationship_definition_id: definition.id, routed_side: side, related_record_id: relationships[relationshipSelectorKey(definition.id, side)] })),
      ],
    });
  };
  const metadataError = fieldsQuery.error || definitionsQuery.error;
  const retryMetadata = () => {
    if (fieldsQuery.error) fieldsQuery.refetch();
    if (definitionsQuery.error) definitionsQuery.refetch();
  };
  return <Dialog open={open} onOpenChange={setOpen}><Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Create {targetObject.singular_label || "record"}</Button><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Create {targetObject.singular_label || "record"}</DialogTitle><DialogDescription>The new record will be linked to this record.</DialogDescription></DialogHeader>{fieldsQuery.isLoading || definitionsQuery.isLoading ? <div className="grid h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : metadataError ? <div className="space-y-3 py-6 text-sm text-rose-700"><p>Creation details could not be loaded. {metadataError.message}</p><Button type="button" variant="outline" onClick={retryMetadata}>Retry</Button></div> : <form onSubmit={submit} className="space-y-5">{fields.map((field) => <div key={field.id}><Label>{field.label}{field.is_required && <span className="ml-1 text-rose-600">*</span>}</Label><div className="mt-2"><RecordFieldControl field={field} value={values[field.name]} onChange={(value) => { setValues((current) => ({ ...current, [field.name]: value })); setErrors((current) => ({ ...current, [field.name]: undefined })); }} /></div>{errors[field.name] && <p className="mt-1 text-sm text-rose-600">{errors[field.name]}</p>}</div>)}{errors._relationships && <p className="text-sm text-rose-600">{errors._relationships}</p>}{selectors.map((selector) => { const key = relationshipSelectorKey(selector.definition.id, selector.side); return <InitialRelationshipSelector key={key} selector={selector} objectId={targetObject.id} fixed={selector.fixed} value={relationships[key]} onChange={(value) => { setRelationships((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [`relationship:${key}`]: undefined, _relationships: undefined })); }} error={errors[`relationship:${key}`]} />; })}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create</Button></DialogFooter></form>}</DialogContent></Dialog>;
}