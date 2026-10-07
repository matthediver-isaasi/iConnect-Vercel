import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { customFieldType } from '@/lib/memberGroupCustomFields.mjs';

export default function CustomFieldInputs({ definitions, values = {}, onChange }) {
  if (!definitions.allowed) return <p role="alert" className="text-sm text-red-600">A verified administrator session is required to load custom fields. Group saving is unavailable.</p>;
  if (definitions.isError) return (
    <div role="alert" className="space-y-2 text-sm text-red-600">
      <p>Custom fields could not be loaded. Your group draft has been kept; saving is unavailable.</p>
      <Button type="button" variant="outline" onClick={() => definitions.refetch()}>Retry loading fields</Button>
    </div>
  );
  if (!definitions.ready) return <div role="status" aria-label="Loading custom fields" className="space-y-2"><div className="h-4 w-36 rounded bg-slate-100" /><div className="h-10 rounded bg-slate-100" /></div>;
  if (definitions.data.available === false) return <p className="text-sm text-slate-600">Custom fields are awaiting a database upgrade. Other group details can still be saved.</p>;
  if (!definitions.data.fields.length) return null;
  return <section className="space-y-4 border-t pt-4">
    <h3 className="text-sm font-semibold text-slate-900">Custom fields</h3>
    {definitions.data.fields.map((field) => {
      const id = `group-custom-field-${field.id}`;
      const type = customFieldType(field.type);
      const value = values[field.id] ?? '';
      const change = (next) => onChange({ ...values, [field.id]: next });
      return <div key={field.id} className="space-y-2">
        <Label htmlFor={id}>{field.name}</Label>
        {type === 'textarea' ? <Textarea id={id} value={value} onChange={(event) => change(event.target.value)} />
          : type === 'boolean' || type === 'select' ? (
            <Select value={value === '' ? '__unset__' : type === 'boolean' ? (value ? 'yes' : 'no') : `choice:${value}`}
              onValueChange={(next) => change(next === '__unset__' ? '' : type === 'boolean' ? next === 'yes' : next.slice(7))}>
              <SelectTrigger id={id}><SelectValue>{value === '' ? 'Not set' : type === 'boolean' ? (value ? 'Yes' : 'No') : value}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__">Not set</SelectItem>
                {type === 'boolean' ? <><SelectItem value="yes">Yes</SelectItem><SelectItem value="no">No</SelectItem></>
                  : field.choices.map((choice) => <SelectItem key={choice} value={`choice:${choice}`}>{choice}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : <Input id={id} type={['number', 'date', 'email', 'url'].includes(type) ? type : 'text'}
            step={type === 'number' ? 'any' : undefined} value={value} onChange={(event) => change(event.target.value)} />}
      </div>;
    })}
  </section>;
}
