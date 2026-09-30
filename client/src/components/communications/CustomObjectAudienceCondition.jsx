import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Input } from '../ui/input';

const noValue = ['is_empty', 'is_not_empty', 'is_true', 'is_false'];
const clearedField = { field_key: '', field_id: '', field_label: '', field_type: '', data_type: '', operator: '', value: '' };
export function customObjectSelection(condition, metadata) {
  const object = metadata?.custom_objects?.find(o => o.id === condition.custom_object_id);
  const relationship = object?.relationships?.find(r => r.id === condition.relationship_definition_id && r.object_side === condition.object_side);
  const fields = relationship ? [
    ...(relationship.record_fields || []).map(f => ({ ...f, field_type: 'record' })),
    ...(relationship.relationship_fields || []).map(f => ({ ...f, field_type: 'relationship' })),
  ] : [];
  const field = fields.find(f => f.id === condition.field_id && f.key === condition.field_key && f.field_type === condition.field_type);
  return { object, relationship, fields, field };
}

export function customObjectConditionError(condition, metadata) {
  if (!metadata) return 'Field definitions are unavailable. Retry loading before saving.';
  const { object, relationship, field } = customObjectSelection(condition, metadata);
  if (!object) return 'Select an available Custom Object. The saved object may be archived or inaccessible.';
  if (!relationship) return 'Select an available member relationship. The saved relationship may no longer be active.';
  if (!field || condition.version !== 1 || field.data_type !== condition.data_type) return 'Select an available record or relationship field. The saved field definition may have changed.';
  const operators = (field.operators || []).map(o => typeof o === 'string' ? o : o.value);
  if (!operators.includes(condition.operator)) return 'Select a supported operator for this field.';
  if (!noValue.includes(condition.operator)) {
    if (condition.value === '' || condition.value == null || (Array.isArray(condition.value) && !condition.value.length)) return 'Enter a value for this condition.';
    if (field.data_type === 'boolean' && ![true, false, 'true', 'false'].includes(condition.value)) return 'Choose Yes or No.';
    if (['number', 'integer', 'decimal', 'currency'].includes(field.data_type) && !Number.isFinite(Number(condition.value))) return 'Enter a valid number.';
  }
  return '';
}

export function customObjectSummary(condition, metadata) {
  const { object, relationship, field } = customObjectSelection(condition, metadata);
  const path = `${object?.label || condition.custom_object_label || condition.custom_object_id} → ${relationship?.label || condition.relationship_label || condition.relationship_definition_id} → ${condition.field_type === 'relationship' ? 'Relationship' : 'Record'}: ${field?.label || condition.field_label || condition.field_key}`;
  const operator = condition.operator === 'is_true' ? 'is Yes' : condition.operator === 'is_false' ? 'is No' : condition.operator?.replaceAll('_', ' ');
  const value = condition.value === true || condition.value === 'true' ? 'Yes' : condition.value === false || condition.value === 'false' ? 'No' : Array.isArray(condition.value) ? condition.value.join(', ') : condition.value;
  return `${path} ${operator}${noValue.includes(condition.operator) ? '' : ` ${value}`}`;
}

export default function CustomObjectAudienceCondition({ condition, metadata, onChange, disabled = false }) {
  const { object, relationship, fields, field } = customObjectSelection(condition, metadata);
  const change = patch => onChange({ ...condition, version: 1, ...patch });
  const select = (label, value, options, onValueChange, fallback) => (
    <Select value={value || ''} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className="h-8 text-xs w-[200px]" aria-label={label}><SelectValue placeholder={label}>{options.find(o => o.value === value)?.label || fallback || undefined}</SelectValue></SelectTrigger>
      <SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  );
  const options = (field?.options || []).map(o => typeof o === 'object' ? { value: String(o.value ?? o.id ?? o.label), label: o.label ?? o.name ?? String(o.value) } : { value: String(o), label: String(o) });
  const error = customObjectConditionError(condition, metadata);
  return <div className="flex flex-wrap items-center gap-1.5">
    {select('Custom Object', condition.custom_object_id, (metadata?.custom_objects || []).map(o => ({ value: o.id, label: o.label })), id => {
      const next = metadata.custom_objects.find(o => o.id === id);
      change({ ...clearedField, custom_object_id: id, custom_object_label: next.label, relationship_definition_id: '', relationship_label: '', object_side: '' });
    }, condition.custom_object_label || condition.custom_object_id)}
    {select('Member relationship', relationship ? `${relationship.id}:${relationship.object_side}` : condition.relationship_definition_id ? `${condition.relationship_definition_id}:${condition.object_side}` : '', (object?.relationships || []).map(r => ({ value: `${r.id}:${r.object_side}`, label: `${r.label} (${r.object_side === 'source' ? 'Object → Member' : 'Member → Object'})` })), value => {
      const next = object.relationships.find(r => `${r.id}:${r.object_side}` === value);
      change({ ...clearedField, relationship_definition_id: next.id, relationship_label: next.label, object_side: next.object_side });
    }, condition.relationship_label || condition.relationship_definition_id)}
    {select('Record or relationship field', condition.field_id ? `${condition.field_type}:${condition.field_id}` : '', fields.map(f => ({ value: `${f.field_type}:${f.id}`, label: `${f.field_type === 'record' ? 'Record' : 'Relationship'}: ${f.label}` })), value => {
      const next = fields.find(f => `${f.field_type}:${f.id}` === value);
      change({ field_id: next.id, field_key: next.key, field_label: next.label, field_type: next.field_type, data_type: next.data_type, operator: '', value: '' });
    }, condition.field_label || condition.field_key)}
    {select('Operator', condition.operator, (field?.operators || []).map(o => typeof o === 'string' ? { value: o, label: o === 'is_true' ? 'Yes' : o === 'is_false' ? 'No' : o.replaceAll('_', ' ') } : o), operator => change({ operator, value: '' }), condition.operator)}
    {condition.operator && !noValue.includes(condition.operator) && (
      field?.data_type === 'boolean'
        ? select('Value', String(condition.value), [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], value => change({ value: value === 'true' }))
        : ['is_one_of', 'is_not_one_of'].includes(condition.operator)
          ? <div className="space-y-1">{options.length ? options.map(option => <label key={option.value} className="flex gap-2 text-xs"><input type="checkbox" disabled={disabled} checked={Array.isArray(condition.value) && condition.value.includes(option.value)} onChange={e => change({ value: e.target.checked ? [...(Array.isArray(condition.value) ? condition.value : []), option.value] : condition.value.filter(v => v !== option.value) })} />{option.label}</label>) : <Input aria-label="Values (comma separated)" disabled={disabled} value={Array.isArray(condition.value) ? condition.value.join(',') : condition.value} onChange={e => change({ value: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />}</div>
          : options.length ? select('Value', String(condition.value), options, value => change({ value }))
          : <Input aria-label="Value" className="h-8 w-[180px] text-xs" disabled={disabled} type={['number', 'integer', 'decimal', 'currency'].includes(field?.data_type) ? 'number' : ['date', 'datetime'].includes(field?.data_type) ? 'date' : 'text'} value={condition.value ?? ''} onChange={e => change({ value: e.target.value })} />
    )}
    {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
  </div>;
}