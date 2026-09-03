import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RecordFieldControl } from "./RecordFieldControls";
import { buildRecordPayload, validateRecordValues } from "./recordHelpers";
import { loadRelationshipDefinitions, relationshipRequest, relationshipRoutes } from "./relationshipApi";
import { initialRelationshipAllowsMultiple, initialRelationshipLabel, initialRelationshipSelectors, isRequiredInitialRelationship, oppositeSide, relationshipSelectorKey } from "./relationshipHelpers";

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
  const label = initialRelationshipLabel(definition, side);
  const allowsMultiple = initialRelationshipAllowsMultiple(definition, side);
  if (fixed) return <div className="rounded-md border bg-slate-50 px-3 py-2"><p className="text-sm font-medium text-slate-800">{label}</p><p className="mt-1 text-sm text-slate-600">This parent relationship is fixed and will be linked when the new record is created.</p></div>;
  const selected = Array.isArray(value) ? value : [];
  return <div><div className="flex items-center gap-2"><Label>{label}{required && <span className="ml-1 text-rose-600">*</span>}</Label><span className="text-xs text-slate-500">{required ? "Required" : "Optional"}</span></div><p className="mt-1 text-sm text-slate-500">{required ? `Choose ${allowsMultiple ? "at least one record" : "one record"} to create this required relationship.` : `Optionally select ${allowsMultiple ? "records" : "a record"} to link as initial ${label.toLowerCase()}. You can leave this empty.`}</p>{query.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading eligible records…</p> : query.error ? <p className="mt-2 text-sm text-rose-600">{query.error.message} <button className="underline" type="button" onClick={() => query.refetch()}>Retry</button></p> : !entries.length ? <p className="mt-2 text-sm text-slate-500">No eligible records are available for this relationship.</p> : <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">{entries.map((entry) => { const id = String(entry.id); const checked = selected.includes(id); return <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50"><Checkbox checked={checked} onCheckedChange={(next) => onChange(next ? (allowsMultiple ? [...selected, id] : [id]) : selected.filter((item) => item !== id))} /><span>{entry.primary_label || entry.display_value || entry.name || "Untitled record"}</span></label>; })}</div>}{error && <p className="mt-1 text-sm text-rose-600">{error}</p>}</div>;
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
      if (!selector.fixed && isRequiredInitialRelationship(selector.definition, selector.side) && !(relationships[key]?.length))
        fieldErrors[`relationship:${key}`] = `${initialRelationshipLabel(selector.definition, selector.side)} is required`;
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
        ...selectors.filter((item) => !item.fixed).flatMap(({ definition, side }) =>
          (relationships[relationshipSelectorKey(definition.id, side)] || []).map((relatedRecordId) => ({
            relationship_definition_id: definition.id,
            routed_side: side,
            related_record_id: relatedRecordId,
          }))),
      ],
    });
  };
  const metadataError = fieldsQuery.error || definitionsQuery.error;
  const retryMetadata = () => {
    if (fieldsQuery.error) fieldsQuery.refetch();
    if (definitionsQuery.error) definitionsQuery.refetch();
  };
  const fixedSelector = selectors.find((selector) => selector.fixed);
  const additionalSelectors = selectors.filter((selector) => !selector.fixed);
  return <Dialog open={open} onOpenChange={setOpen}><Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Create {targetObject.singular_label || "record"}</Button><DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Create {targetObject.singular_label || "record"}</DialogTitle><DialogDescription>Add the record details, then choose any initial relationships.</DialogDescription></DialogHeader>{fieldsQuery.isLoading || definitionsQuery.isLoading ? <div className="grid h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : metadataError ? <div className="space-y-3 py-6 text-sm text-rose-700"><p>Creation details could not be loaded. {metadataError.message}</p><Button type="button" variant="outline" onClick={retryMetadata}>Retry</Button></div> : <form onSubmit={submit} className="space-y-6"><section className="space-y-4"><div><h3 className="font-medium text-slate-900">Record details</h3><p className="text-sm text-slate-500">Fields stored on the new {targetObject.singular_label || "record"}.</p></div>{fields.map((field) => <div key={field.id}><Label>{field.label}{field.is_required && <span className="ml-1 text-rose-600">*</span>}</Label><div className="mt-2"><RecordFieldControl field={field} value={values[field.name]} onChange={(value) => { setValues((current) => ({ ...current, [field.name]: value })); setErrors((current) => ({ ...current, [field.name]: undefined })); }} /></div>{errors[field.name] && <p className="mt-1 text-sm text-rose-600">{errors[field.name]}</p>}</div>)}</section><section className="space-y-4 border-t pt-5"><div><h3 className="font-medium text-slate-900">Parent relationship</h3><p className="text-sm text-slate-500">The record you started from is linked automatically.</p></div>{fixedSelector && <InitialRelationshipSelector selector={fixedSelector} objectId={targetObject.id} fixed value={[]} onChange={() => {}} />}</section>{additionalSelectors.length > 0 && <section className="space-y-4 border-t pt-5"><div><h3 className="font-medium text-slate-900">Additional relationships</h3><p className="text-sm text-slate-500">These links are created at the same time as the new record.</p></div>{errors._relationships && <p className="text-sm text-rose-600">{errors._relationships}</p>}{additionalSelectors.map((selector) => { const key = relationshipSelectorKey(selector.definition.id, selector.side); return <InitialRelationshipSelector key={key} selector={selector} objectId={targetObject.id} value={relationships[key] || []} onChange={(value) => { setRelationships((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [`relationship:${key}`]: undefined, _relationships: undefined })); }} error={errors[`relationship:${key}`]} />; })}</section>}<DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create</Button></DialogFooter></form>}</DialogContent></Dialog>;
}