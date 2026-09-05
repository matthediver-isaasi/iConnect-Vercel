import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { InitialRelationshipSelector } from "./InitialRelationshipSelector";
import { RecordFieldControl } from "./RecordFieldControls";
import { buildRecordPayload, fieldAccess, readableFields, validateRecordValues, writableFields } from "./recordHelpers";
import {
  loadCustomObjectFields,
  loadRelationshipDefinitions,
  relationshipRequest,
  relationshipRoutes,
} from "./relationshipApi";
import {
  contextualOriginLabel,
  contextualPrimaryNameSuggestion,
  initialRelationshipLabel,
  initialRelationshipSelectors,
  isRequiredInitialRelationship,
  oppositeSide,
  relationshipSelectorKey,
  shouldApplyContextualNameSuggestion,
} from "./relationshipHelpers";

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

export function ContextualRecordCreateDialog({
  originContext,
  originRecord,
  originDefinition,
  originSide,
  targetObject,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [relationships, setRelationships] = useState({});
  const [errors, setErrors] = useState({});
  const [primaryNameOverridden, setPrimaryNameOverridden] = useState(false);
  const qc = useQueryClient();
  const fieldsQuery = useQuery({
    queryKey: ["custom-objects", targetObject.id, "record-fields"],
    queryFn: () => loadCustomObjectFields(targetObject.id, { includeInactive: true }),
    enabled: open,
  });
  const definitionsQuery = useQuery({ queryKey: ["contextual-create-definitions", targetObject.id], queryFn: () => loadRelationshipDefinitions(targetObject.id), enabled: open });
  const fields = readableFields(fieldsQuery.data?.data || fieldsQuery.data || []);
  const editableFields = writableFields(fields);
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
    const fieldErrors = validateRecordValues(editableFields, values);
    for (const selector of selectors) {
      const key = relationshipSelectorKey(selector.definition.id, selector.side);
      if (!selector.fixed && isRequiredInitialRelationship(selector.definition, selector.side) && !(relationships[key]?.length))
        fieldErrors[`relationship:${key}`] = `${initialRelationshipLabel(selector.definition, selector.side)} is required`;
    }
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;
    create.mutate({
      ...buildRecordPayload(editableFields, values),
      originating_relationship: {
        relationship_definition_id: originDefinition.id,
        routed_side: oppositeSide(originSide),
        related_record_id: originContext.recordId,
      },
      initial_relationships: [
        ...selectors.filter((item) => !item.fixed).flatMap(({ definition, side }) =>
          (relationships[relationshipSelectorKey(definition.id, side)] || []).map((relatedRecord) => ({
            relationship_definition_id: definition.id,
            routed_side: side,
            related_record_id: relatedRecord.id,
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
  const primaryNameField = editableFields.find((field) =>
    String(field.id) === String(targetObject.primary_display_field_id)
    && field.field_type === "text");
  const suggestedPrimaryName = contextualPrimaryNameSuggestion({
    originLabel: contextualOriginLabel(originContext, originRecord),
    selectors,
    relationships,
  });

  useEffect(() => {
    if (!open || !primaryNameField || primaryNameOverridden) return;
    setValues((current) => (
      shouldApplyContextualNameSuggestion({
        manuallyOverridden: primaryNameOverridden,
        currentValue: current[primaryNameField.name],
        suggestedValue: suggestedPrimaryName,
      })
        ? { ...current, [primaryNameField.name]: suggestedPrimaryName }
        : current
    ));
  }, [open, primaryNameField, primaryNameOverridden, suggestedPrimaryName]);

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setRelationships({});
      setErrors({});
      setPrimaryNameOverridden(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => handleOpenChange(true)}>
        <Plus className="mr-2 h-4 w-4" />
        Create {targetObject.singular_label || "record"}
      </Button>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create {targetObject.singular_label || "record"}</DialogTitle>
          <DialogDescription>Add the record details, then choose any initial relationships.</DialogDescription>
        </DialogHeader>
        {fieldsQuery.isLoading || definitionsQuery.isLoading ? (
          <div className="grid h-40 place-items-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : metadataError ? (
          <div className="space-y-3 py-6 text-sm text-rose-700">
            <p>Creation details could not be loaded. {metadataError.message}</p>
            <Button type="button" variant="outline" onClick={retryMetadata}>Retry</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-6">
            <section className="space-y-4">
              <div>
                <h3 className="font-medium text-slate-900">Record details</h3>
                <p className="text-sm text-slate-500">
                  Fields stored on the new {targetObject.singular_label || "record"}.
                </p>
              </div>
              {fields.map((field) => {
                const isGeneratedName = primaryNameField?.id === field.id;
                return (
                  <div key={field.id}>
                    <Label>
                      {field.label}
                      {field.is_required && fieldAccess(field) === "write" && <span className="ml-1 text-rose-600">*</span>}
                    </Label>
                    <div className="mt-2">
                      <RecordFieldControl
                        disabled={fieldAccess(field) !== "write"}
                        field={field}
                        value={values[field.name]}
                        onChange={(value) => {
                          if (isGeneratedName) setPrimaryNameOverridden(true);
                          setValues((current) => ({ ...current, [field.name]: value }));
                          setErrors((current) => ({ ...current, [field.name]: undefined }));
                        }}
                      />
                    </div>
                    {isGeneratedName && (
                      <p className="mt-1 text-sm text-slate-500">
                        Suggested from the linked records. You can change this name.
                      </p>
                    )}
                    {errors[field.name] && <p className="mt-1 text-sm text-rose-600">{errors[field.name]}</p>}
                  </div>
                );
              })}
            </section>
            <section className="space-y-4 border-t pt-5">
              <div>
                <h3 className="font-medium text-slate-900">Parent relationship</h3>
                <p className="text-sm text-slate-500">The record you started from is linked automatically.</p>
              </div>
              {fixedSelector && (
                <InitialRelationshipSelector
                  selector={fixedSelector}
                  objectId={targetObject.id}
                  fixed
                  value={[]}
                  onChange={() => {}}
                />
              )}
            </section>
            {additionalSelectors.length > 0 && (
              <section className="space-y-4 border-t pt-5">
                <div>
                  <h3 className="font-medium text-slate-900">Additional relationships</h3>
                  <p className="text-sm text-slate-500">These links are created at the same time as the new record.</p>
                </div>
                {errors._relationships && <p className="text-sm text-rose-600">{errors._relationships}</p>}
                {additionalSelectors.map((selector) => {
                  const key = relationshipSelectorKey(selector.definition.id, selector.side);
                  return (
                    <InitialRelationshipSelector
                      key={key}
                      selector={selector}
                      objectId={targetObject.id}
                      value={relationships[key] || []}
                      onChange={(value) => {
                        setRelationships((current) => ({ ...current, [key]: value }));
                        setErrors((current) => ({
                          ...current,
                          [`relationship:${key}`]: undefined,
                          _relationships: undefined,
                        }));
                      }}
                      error={errors[`relationship:${key}`]}
                    />
                  );
                })}
              </section>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || !editableFields.length}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}