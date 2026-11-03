import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadCustomObjectFields, relationshipRequest } from "./relationshipApi";
import { relationshipFieldsForSide } from "./relationshipHelpers";
import { relationshipColumnDescriptors, relationshipSortPreviewColumns } from "./relationshipColumnHelpers.mjs";

export function RelationshipDefaultSortSettings({ side, form, update }) {
  const opposite = side === "source" ? "target" : "source";
  const objectId = form[`${opposite}_kind`] === "custom_object"
    ? form[`${opposite}_custom_object_id`] : null;
  const fields = useQuery({
    queryKey: ["custom-objects", objectId, "compact-preview-fields"],
    queryFn: () => loadCustomObjectFields(objectId),
    enabled: Boolean(objectId),
  });
  const object = useQuery({
    queryKey: ["custom-objects", objectId],
    queryFn: () => relationshipRequest(`/api/custom-objects/${objectId}`),
    enabled: Boolean(objectId),
  });
  const columns = relationshipColumnDescriptors({
    relationshipFields: relationshipFieldsForSide(form, side),
    previewColumns: objectId ? relationshipSortPreviewColumns(
      form.configuration, opposite, object.data,
      fields.data?.data || fields.data || [],
    ) : [],
  });
  const saved = form.configuration?.default_sort?.[side];
  const value = columns.some((column) => column.sortField === saved?.sortField)
    ? saved.sortField : "none";
  const setSort = (sort) => update("configuration", {
    ...form.configuration,
    default_sort: { ...form.configuration?.default_sort, [side]: sort },
  });
  const pending = objectId && (fields.isPending || object.isPending);
  const failed = objectId && (fields.error || object.error);
  return <div className="mt-3 border-t pt-3">
    <p className="mb-3 text-xs text-slate-500">Default order when viewing this side. Personal heading sorts take precedence.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor={`default-sort-${side}`}>Default sort column</Label>
        <Select value={value} disabled={Boolean(pending || failed)} onValueChange={(sortField) => {
          if (!sortField) return;
          setSort(sortField === "none" ? null : { sortField, sortDir: saved?.sortDir || "asc" });
        }}>
          <SelectTrigger id={`default-sort-${side}`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">Unset (existing order)</SelectItem>
            {columns.map((column) => <SelectItem key={column.id} value={column.sortField}>{column.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div><Label htmlFor={`default-sort-direction-${side}`}>Sort direction</Label>
        <Select value={saved?.sortDir === "desc" ? "desc" : "asc"} disabled={value === "none" || Boolean(pending || failed)}
          onValueChange={(sortDir) => { if (sortDir) setSort({ sortField: value, sortDir }); }}>
          <SelectTrigger id={`default-sort-direction-${side}`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="asc">Ascending</SelectItem><SelectItem value="desc">Descending</SelectItem></SelectContent>
        </Select>
      </div>
    </div>
    {pending && <p className="mt-2 text-xs text-slate-500">Loading sort columns…</p>}
    {failed && <p role="alert" className="mt-2 text-xs text-rose-600">Sort columns could not be loaded.</p>}
    {!pending && !failed && saved?.sortField && value === "none" && <p className="mt-2 text-xs text-amber-700">The saved column is no longer shown. Existing ordering will be used until another column is selected.</p>}
  </div>;
}
