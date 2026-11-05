import React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { popupOperators } from "@shared/cmsPopupContract.js";

export const blankFieldCondition = () => ({ entity_scope: "member", field_key: "", field_type: "", data_type: "", operator: "", value: "", field_label: "" });
export function getFieldOperators(type) {
  const base = [["equals", "Equals"], ["not_equals", "Not equals"], ["is_empty", "Is empty"], ["is_not_empty", "Is not empty"]];
  if (type === "boolean") return [["is_true", "Is true"], ["is_false", "Is false"]];
  if (["list", "multiselect", "multi_select", "country", "countries"].includes(type)) return [["contains", "Contains any of"], ...base.slice(2)];
  if (type === "event_id") return [["is_one_of", "Is one of"], ["is_not_one_of", "Is not one of"]];
  if (["number", "decimal"].includes(type)) return [...base, ["greater_than", "Greater than"], ["less_than", "Less than"]];
  if (type === "date") return [...base, ["before", "Before"], ["after", "After"]];
  if (["picklist", "dropdown"].includes(type)) return [...base, ["is_one_of", "Is one of"]];
  return [...base, ["contains", "Contains"]];
}
export function FieldConditionRow({ condition: cond, metadata, onChange, onRemove, disabled = false, scopes = ["member", "organization"], onScopeChange, testPrefix = "popup-condition" }) {
  const fields = [...(metadata?.[cond.entity_scope]?.core || []), ...(metadata?.[cond.entity_scope]?.custom || [])];
  const field = fields.find((f) => f.key === cond.field_key);
  const type = field?.data_type || cond.data_type;
  const options = Array.isArray(field?.options) ? field.options : [];
  const hasChoices = field?.choice_only || options.length > 0
    || ["picklist", "dropdown", "multiselect", "multi_select"].includes(type);
  const multi = ["list", "multiselect", "multi_select", "country", "countries"].includes(type) || cond.operator === "is_one_of";
  const needsValue = !["is_empty", "is_not_empty", "is_true", "is_false"].includes(cond.operator);
  const operatorLabels = Object.fromEntries([...getFieldOperators(type), ["is_true", "Is true"], ["is_false", "Is false"]]);
  const allOperators = scopes.length === 2 ? popupOperators(type).map((value) => [value, operatorLabels[value] || value.replaceAll("_", " ")]) : getFieldOperators(type);
  const operators = field?.choice_only ? allOperators.filter(([op]) => ["equals", "not_equals", "is_empty", "is_not_empty"].includes(op)) : allOperators;
  const change = (patch) => onChange({ ...cond, ...patch });
  return <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2">
    <Select value={cond.entity_scope} disabled={disabled} onValueChange={(scope) => onScopeChange ? onScopeChange(scope) : onChange({ ...blankFieldCondition(), entity_scope: scope })}>
      <SelectTrigger className="w-36" aria-label="Condition scope" data-testid={`select-filter-scope-${testPrefix}`}><SelectValue /></SelectTrigger>
      <SelectContent>{scopes.map((scope) => <SelectItem value={scope} key={scope}>{({ member: "Member", organization: "Organisation", event: "Event", custom_object: "Custom Object" })[scope]}</SelectItem>)}</SelectContent>
    </Select>
    <Select value={cond.field_key} disabled={disabled} onValueChange={(key) => {
      const next = fields.find((f) => f.key === key);
      change({ field_key: key, field_type: next.field_type || "core", data_type: next.data_type, field_label: next.label, operator: "", value: "" });
    }}>
      <SelectTrigger className="min-w-40 flex-1" aria-label="Condition field" data-testid={`select-filter-field-${testPrefix}`}><SelectValue placeholder={cond.field_label || "Select field"} /></SelectTrigger>
      <SelectContent>{fields.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
    </Select>
    {cond.field_key && <Select disabled={disabled} value={cond.operator} onValueChange={(operator) => change({ operator, value: ["is_empty", "is_not_empty", "is_true", "is_false"].includes(operator) ? "" : cond.value })}>
      <SelectTrigger className="w-40" aria-label="Condition operator" data-testid={`select-filter-operator-${testPrefix}`}><SelectValue placeholder="Operator" /></SelectTrigger>
      <SelectContent>{operators.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
    </Select>}
    {cond.operator && needsValue && (hasChoices && !multi ? <div className="min-w-40 flex-1">
      <select aria-label="Condition value" disabled={disabled || !options.length}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={cond.value || ""} onChange={(e) => change({ value: e.target.value })}>
        <option value="" disabled>{options.length ? "Select a value" : "No choices available"}</option>
        {cond.value && !options.some(o => String(typeof o === "object" ? o.value ?? o.label : o) === String(cond.value))
          && <option value={cond.value} disabled>Unavailable selection — choose again</option>}
        {options.map(o => {
          const value = String(typeof o === "object" ? o.value ?? o.label : o);
          return <option key={value} value={value}>{typeof o === "object" ? o.label ?? o.value : o}</option>;
        })}
      </select>
      {cond.value && !options.some(o => String(typeof o === "object" ? o.value ?? o.label : o) === String(cond.value))
        && <p role="alert" className="text-xs text-destructive">The saved value is not an available choice. Select the correct value and save.</p>}
    </div> : hasChoices ? <div className="max-h-28 min-w-40 overflow-auto border rounded p-2 text-sm">
      {!options.length && <p>No choices available.</p>}
      {options.map((option) => {
        const value = String(typeof option === "object" ? option.value ?? option.label : option);
        const label = typeof option === "object" ? option.label ?? option.value : option;
        const values = Array.isArray(cond.value) ? cond.value : [cond.value];
        return <label key={value} className="flex items-center gap-2"><input disabled={disabled} type={multi ? "checkbox" : "radio"} checked={values.includes(value)} onChange={(e) => change({ value: multi ? e.target.checked ? [...values.filter(Boolean), value] : values.filter((v) => v !== value) : value })} />{label}</label>;
      })}
    </div> : <Input disabled={disabled} className="w-40" aria-label="Condition value" data-testid={`input-filter-value-${testPrefix}`}
      type={type === "date" ? "date" : ["number", "decimal"].includes(type) ? "number" : "text"}
      value={cond.value ?? ""} onChange={(e) => change({ value: e.target.value })} />)}
    {cond.field_key && !field && <p role="alert" className="text-xs text-destructive">Field unavailable. Reselect it; this rule cannot qualify visitors.</p>}
    {onRemove && <Button type="button" variant="ghost" size="icon" aria-label="Remove condition" onClick={onRemove}><X className="h-4 w-4" /></Button>}
  </div>;
}
export default function FieldConditionEditor({ groups, onChange, metadata, disabled = false }) {
  const update = (gi, ci, condition) => onChange(groups.map((g, i) => i === gi ? { ...g, conditions: g.conditions.map((c, j) => j === ci ? condition : c) } : g));
  return <div className="space-y-4">
    {groups.map((group, gi) => <div key={gi} className="space-y-2">
      {gi > 0 && <div className="text-center text-xs font-semibold text-muted-foreground">OR</div>}
      {group.conditions.map((condition, ci) => <React.Fragment key={ci}>
        {ci > 0 && <p className="text-xs font-medium">AND</p>}
        <FieldConditionRow condition={condition} metadata={metadata} disabled={disabled} onChange={(next) => update(gi, ci, next)}
          onRemove={() => onChange(groups.map((g, i) => i === gi ? { ...g, conditions: g.conditions.filter((_, j) => j !== ci) } : g).filter((g) => g.conditions.length))} />
      </React.Fragment>)}
      <Button disabled={disabled} variant="outline" size="sm" onClick={() => onChange(groups.map((g, i) => i === gi ? { ...g, conditions: [...g.conditions, blankFieldCondition()] } : g))}>AND condition</Button>
    </div>)}
    <Button disabled={disabled} variant="outline" size="sm" onClick={() => onChange([...groups, { conditions: [blankFieldCondition()] }])}><Plus className="mr-2 h-4 w-4" />{groups.length ? "OR group" : "Add targeting rule"}</Button>
  </div>;
}
