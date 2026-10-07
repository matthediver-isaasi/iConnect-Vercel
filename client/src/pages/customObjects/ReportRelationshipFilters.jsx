import React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReportRelationshipSelector } from "./ReportRelationshipSelector";
import { resolveRelationshipPickerPath } from "./relationshipHelpers";
import {
  MAX_REPORT_FILTERS, MAX_FILTER_CONDITIONS, isFilterObject,
  filterFieldKey, filterFieldReference, filterOperators, makeFilterCondition,
  changeFilterOperator, reportFilterFields,
} from "./reportFilterHelpers.mjs";

const operatorLabels = {
  equals: "Equals", contains: "Contains", gt: "Greater than", gte: "Greater than or equal",
  lt: "Less than", lte: "Less than or equal", is_empty: "Is empty", is_not_empty: "Is not empty",
};

export function ReportRelationshipFilters({
  filters, onChange, canManage, start, definitions, objects, object,
  fieldsByEndpoint, metadataLoading = false, metadataError = false, onRetry, indicator = false, indicatorLabel = "Indicator",
}) {
  const list = Array.isArray(filters) ? filters : [];
  const malformed = filters !== undefined && !Array.isArray(filters);
  const update = (index, updater) => onChange(list.map((filter, i) => i === index ? updater(filter) : filter));
  const remove = (index) => onChange(list.filter((_, i) => i !== index));
  const newFilter = () => ({
    id: `filter-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
    mode: "any", path: resolveRelationshipPickerPath({ definitions, start, path: [], maxHops: 6 }).options.slice(0, 1)
      .map(({ definition, from_side }) => ({ relationship_definition_id: String(definition.id), from_side })), conditions: [],
  });
  return <section data-testid={indicator ? "report-indicator-conditions" : "report-relationship-filters"} className="min-w-0 space-y-3 rounded-md border bg-slate-50/50 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><Label>{indicator ? "Matching related records" : "Optional row filters"}</Label><p className="mt-1 text-xs text-slate-500">{indicator ? "Returns True if any related record meets every condition; otherwise False. Does not remove rows or change counts." : "Only include rows matching every filter. Filters do not calculate column values."}</p></div>
      {!indicator && <Button type="button" size="sm" variant="outline" data-testid="add-report-filter"
        disabled={!canManage || malformed || list.length >= MAX_REPORT_FILTERS || !resolveRelationshipPickerPath({ definitions, start, path: [], maxHops: 6 }).options.length || metadataLoading}
        onClick={() => onChange([...list, newFilter()])}><Plus className="mr-1 h-3 w-3" />Add filter</Button>}
    </div>
    {!indicator && <p className="text-xs text-slate-500">Any match requires a related record meeting every condition. None match keeps rows with no such record, including rows with no related records. Filters combine with AND.</p>}
    {metadataLoading && <p role="status" className="text-sm text-slate-500">Loading authorised relationship and field metadata… Saved selections are preserved.</p>}
    {metadataError && <div role="alert" className="text-sm text-amber-900">Could not load field metadata. Saved selections are preserved. <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry metadata</Button></div>}
    {malformed && <div role="alert" className="text-sm text-amber-900">Saved relationship filters are malformed. <Button type="button" size="sm" variant="outline" disabled={!canManage} onClick={() => onChange([])}>Reset relationship filters</Button></div>}
    {!malformed && !list.length && <p className="text-sm text-slate-500">No relationship filters. All rows are included before other report settings are applied.</p>}
    {list.map((filter, index) => {
      if (!isFilterObject(filter)) return <div key={index} className="flex items-center justify-between rounded border p-3 text-sm"><span>Filter {index + 1} is malformed.</span><Button type="button" variant="outline" size="sm" disabled={!canManage} onClick={() => remove(index)}>Remove malformed filter</Button></div>;
      const schema = reportFilterFields({ path: filter.path, start, definitions, fieldsByEndpoint });
      const conditionLabel = indicator ? indicatorLabel : `Filter ${index + 1}`;
      const conditions = Array.isArray(filter.conditions) ? filter.conditions : [];
      const setConditions = (updater) => update(index, (current) => ({
        ...current, conditions: typeof updater === "function" ? updater(conditions) : updater,
      }));
      const editCondition = (conditionIndex, updater) => setConditions((current) =>
        current.map((condition, i) => i === conditionIndex ? updater(condition) : condition));
      return <div key={filter.id || index} data-testid={`report-filter-${index}`} className="space-y-3 rounded border bg-background p-3">
        {!indicator && <div className="flex items-center justify-between"><Label>Filter {index + 1}</Label><Button type="button" variant="ghost" size="sm" disabled={!canManage} aria-label={`Remove filter ${index + 1}`} onClick={() => remove(index)}><Trash2 className="h-4 w-4" /></Button></div>}
        <div className={`grid min-w-0 gap-3 ${indicator ? "" : "md:grid-cols-[minmax(0,1fr)_12rem]"}`}>
          <div className="min-w-0"><Label className="text-xs">Related records (from each row)</Label>
            <ReportRelationshipSelector value={filter.path} onChange={(path) => update(index, (current) => ({ ...current, path }))}
              disabled={!canManage} metadataLoading={metadataLoading} allowRoot={false}
              label={indicator ? "Indicator related records" : `Filter ${index + 1} related path`}
              start={start} definitions={definitions} objects={objects} object={object} /></div>
          {!indicator && <div><Label className="text-xs">Match</Label><Select disabled={!canManage} value={typeof filter.mode === "string" && filter.mode ? filter.mode : "invalid"}
            onValueChange={(mode) => update(index, (current) => ({ ...current, mode }))}>
            <SelectTrigger aria-label={`Filter ${index + 1} match mode`}><SelectValue /></SelectTrigger><SelectContent className="report-condition-options">
              {!["any", "none"].includes(filter.mode) && <SelectItem value={typeof filter.mode === "string" && filter.mode ? filter.mode : "invalid"} disabled>Invalid saved mode</SelectItem>}
              <SelectItem value="any">Any match</SelectItem><SelectItem value="none">None match</SelectItem>
            </SelectContent></Select></div>}
        </div>
        <p className="text-xs text-slate-500">{indicator ? "True requires at least one matching related occurrence. Missing relationships return False, never an error disguised as False." : filter.mode === "none" ? "Keep rows with no related occurrence matching every condition. Missing row endpoints match." : "Keep rows with at least one related occurrence matching every condition. Missing row endpoints do not match."} All conditions apply to the same endpoint and final relationship occurrence.</p>
        {schema.pending && <p role="status" className="text-sm text-slate-500">Endpoint field metadata is not yet available. Saved selections are preserved; preview and export wait for metadata.</p>}
        {!Array.isArray(filter.conditions) && <div className="text-sm text-amber-900">Saved conditions are malformed. <Button type="button" size="sm" variant="outline" disabled={!canManage} onClick={() => setConditions([])}>Reset conditions</Button></div>}
        {Array.isArray(filter.conditions) && !conditions.length && <p className="text-sm text-slate-500">{filter.mode === "none" ? "No conditions: require absence of related records." : "No conditions: require existence of a related record."}</p>}
        {conditions.map((condition, conditionIndex) => {
          const key = filterFieldKey(condition);
          const field = schema.fields.find((item) => filterFieldKey(filterFieldReference(item)) === key);
          const ops = filterOperators(field?.type);
          const op = isFilterObject(condition) ? condition.op : undefined;
          const value = isFilterObject(condition) ? condition.value : undefined;
          const savedValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
           return <div key={conditionIndex} className="grid min-w-0 items-end gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" data-testid={`filter-${index}-condition-${conditionIndex}`}>
             <div className="min-w-0"><Label className="text-xs">Field</Label><Select disabled={!canManage || metadataLoading || schema.pending} value={key || "invalid"}
              onValueChange={(next) => {
                const replacement = schema.fields.find((item) => filterFieldKey(filterFieldReference(item)) === next);
                if (replacement) editCondition(conditionIndex, () => makeFilterCondition(replacement));
               }}><SelectTrigger aria-label={`${conditionLabel} condition ${conditionIndex + 1} field`}><SelectValue /></SelectTrigger><SelectContent className="report-condition-options">
              {!field && <SelectItem value={key || "invalid"} disabled>{schema.pending || metadataLoading ? "Saved field — metadata loading" : "Unavailable or unsupported saved field"}{isFilterObject(condition) && ` (${condition.relationship_field_id ?? condition.field_id ?? condition.field ?? "invalid reference"})`}</SelectItem>}
              {schema.fields.map((item) => <SelectItem key={filterFieldKey(filterFieldReference(item))} value={filterFieldKey(filterFieldReference(item))}>{item.label || item.id}</SelectItem>)}
            </SelectContent></Select></div>
             <div className="min-w-0"><Label className="text-xs">Operator</Label><Select disabled={!canManage || !field} value={typeof op === "string" && op ? op : "invalid"}
              onValueChange={(next) => editCondition(conditionIndex, (current) => changeFilterOperator(current, next, field.type))}>
               <SelectTrigger aria-label={`${conditionLabel} condition ${conditionIndex + 1} operator`}><SelectValue /></SelectTrigger><SelectContent className="report-condition-options">
                {!ops.includes(op) && <SelectItem value={typeof op === "string" && op ? op : "invalid"} disabled>Unavailable saved operator</SelectItem>}
                {ops.map((item) => <SelectItem key={item} value={item}>{operatorLabels[item]}</SelectItem>)}
              </SelectContent></Select></div>
             {!["is_empty", "is_not_empty"].includes(op) ? <div className="min-w-0"><Label className="text-xs">Value</Label>
              {field?.type === "boolean" ? <Select disabled={!canManage} value={typeof value === "boolean" ? String(value) : "invalid"}
                onValueChange={(next) => editCondition(conditionIndex, (current) => ({ ...current, value: next === "true" }))}>
                 <SelectTrigger aria-label={`${conditionLabel} condition ${conditionIndex + 1} value`}><SelectValue /></SelectTrigger><SelectContent className="report-condition-options">
                  {typeof value !== "boolean" && <SelectItem value="invalid" disabled>Invalid saved boolean — choose Yes or No</SelectItem>}
                  <SelectItem value="true">Yes</SelectItem><SelectItem value="false">No</SelectItem>
                 </SelectContent></Select> : <Input aria-label={`${conditionLabel} condition ${conditionIndex + 1} value`} data-testid={`filter-${index}-value-${conditionIndex}`}
                disabled={!canManage || !field} type={["number", "decimal"].includes(field?.type) ? "number" : "text"} step="any"
                value={savedValue} onChange={(event) => {
                  const next = event.target.value;
                  editCondition(conditionIndex, (current) => ({ ...current, value: ["number", "decimal"].includes(field?.type) && next !== "" ? Number(next) : next }));
                }} />}
            </div> : <p className="pb-2 text-xs text-slate-500">Missing, null or empty string. False and zero are not empty.</p>}
             <Button type="button" variant="ghost" size="sm" disabled={!canManage} aria-label={`Remove ${indicator ? indicatorLabel : `filter ${index + 1}`} condition ${conditionIndex + 1}`} onClick={() => setConditions((current) => current.filter((_, i) => i !== conditionIndex))}><Trash2 className="h-4 w-4" /></Button>
          </div>;
        })}
         <Button type="button" size="sm" variant="outline" data-testid={indicator ? "add-indicator-condition" : `add-filter-condition-${index}`}
          disabled={!canManage || !Array.isArray(filter.conditions) || conditions.length >= MAX_FILTER_CONDITIONS || !schema.fields.length || Boolean(schema.error) || metadataLoading || schema.pending}
          onClick={() => setConditions([...conditions, makeFilterCondition(schema.fields[0])])}><Plus className="mr-1 h-3 w-3" />Add condition</Button>
        {schema.unsupported.length > 0 && <p className="text-xs text-slate-500">Unsupported field types are not selectable: {schema.unsupported.map((field) => field.label || field.id).join(", ")}.</p>}
      </div>;
    })}
    <p className="text-xs text-slate-500">{indicator ? "Up to 10 conditions and 6 relationship steps." : "Up to 10 filters, 10 conditions per filter and 6 relationship steps."} Text equals is case-sensitive; contains is a literal, case-insensitive match.</p>
  </section>;
}