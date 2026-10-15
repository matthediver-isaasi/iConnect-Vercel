import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function EngagementSettings({ settings, save, saving, error, reload }) {
  const [values, setValues] = useState(settings.configured ? settings.values : settings.options.map(o => o.value));
  const [changed, setChanged] = useState(false);
  const choose = next => { setValues(next); setChanged(true); };
  const editable = settings.canManage && !!settings.field && settings.options.length > 0;
  const stale = values.filter(v => !settings.options.some(o => o.value === v));
  return <Card><CardContent className="pt-6 space-y-4">
    <h2 className="font-semibold">Organisation types</h2>
    <p>These settings are shared by everyone viewing this tenant’s report. Changes apply only after saving.</p>
    <p>Before the first save, all organisations are included. Saving no selected types produces an empty report. Selecting all includes only organisations with a matching type.</p>
    {!settings.canManage && <p>Only tenant administrators can change these settings.</p>}
    {settings.warning && <p role="alert">{settings.warning}</p>}
    <fieldset disabled={!editable || saving} className="space-y-3">
      <legend className="sr-only">{settings.field?.label || 'Organisation types'}</legend>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => choose([...new Set([...values, ...settings.options.map(o => o.value)])])}>Select all</Button>
        <Button variant="outline" onClick={() => choose([])}>Clear all</Button>
      </div>
      {[...settings.options, ...stale.map(value => ({ value, label: `${value} (removed option)` }))].map(option =>
        <label key={option.value} className="flex items-center gap-2">
          <input type="checkbox" checked={values.includes(option.value)}
            onChange={e => choose(e.target.checked ? [...values, option.value] : values.filter(v => v !== option.value))} />
          {option.label}
        </label>)}
    </fieldset>
    {changed && <p role="status">Unsaved changes</p>}
    {error && <p role="alert">{error.message}</p>}
    <div className="flex gap-2">
      <Button disabled={!editable || saving || stale.length > 0 || (settings.configured && !changed)}
        onClick={() => save({ fieldId: settings.field.id, values, revision: settings.revision })}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="outline" disabled={saving} onClick={reload}>Reload settings</Button>
    </div>
  </CardContent></Card>;
}
