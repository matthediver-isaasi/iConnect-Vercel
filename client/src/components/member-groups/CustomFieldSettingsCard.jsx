import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMemberGroupCustomFields } from '@/hooks/useMemberGroupCustomFields';
import { CUSTOM_FIELD_TYPES, customFieldType, buildCustomFieldDefinitions } from '@/lib/memberGroupCustomFields.mjs';

function DefinitionsEditor({ definitions }) {
  const [draft, setDraft] = useState(() => definitions.data.fields.map((field) => ({ ...field, choices: [...field.choices] })));
  const [revision, setRevision] = useState(definitions.data.revision);
  const [deletedIds, setDeletedIds] = useState([]);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState(definitions.data.fields);
  const pending = definitions.save.isPending;
  const update = (key, patch) => setDraft((fields) => fields.map((field) => (field.id || field._key) === key ? { ...field, ...patch } : field));
  const reset = (data) => {
    setDraft(data.fields.map((field) => ({ ...field, choices: [...field.choices] })));
    setBaseline(data.fields);
    setRevision(data.revision);
    setDeletedIds([]);
    setError('');
  };
  const handleSave = async () => {
    setError('');
    try {
      const fields = buildCustomFieldDefinitions(draft);
      const result = await definitions.save.mutateAsync({ fields, revision, confirmedDeletedIds: deletedIds });
      reset(result);
      toast.success('Custom fields saved');
    } catch (failure) {
      setError(failure.status === 409
        ? 'Custom fields were changed by another administrator. Your draft is kept. Reload the latest definitions before applying your changes again.'
        : failure.message || 'Custom fields could not be saved. Your draft is kept.');
    }
  };
  return <div className="space-y-5">
    {(error || definitions.isError) && <div role="alert" className="space-y-2 text-sm text-red-600">
      <p>{error || 'Custom fields could not be refreshed. Your draft is kept; retry before saving.'}</p>
      {definitions.isError && <Button variant="outline" onClick={() => definitions.refetch()}>Retry loading fields</Button>}
      <Button variant="outline" disabled={pending} onClick={() => setReloadConfirm(true)}>Reload latest definitions</Button>
    </div>}
    {!draft.length && <div className="rounded-md border border-dashed p-5 text-sm text-slate-600">
      No custom fields yet. Add optional details for administrators to fill in for each group.
    </div>}
    <fieldset disabled={pending} className="space-y-4">
      {draft.map((field, index) => {
        const key = field.id || field._key;
        const original = baseline.find((existing) => existing.id === field.id);
        const originalChoices = original?.choices || [];
        return <div key={key} className="rounded-md border p-4 space-y-4" data-testid={`custom-field-definition-${index}`}>
          <div className="flex justify-between gap-3 items-center">
            <h3 className="text-sm font-semibold text-slate-900">Field {index + 1}</h3>
            <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(field)} aria-label={`Remove ${field.name || `field ${index + 1}`}`}>
              <Trash2 className="w-4 h-4 mr-2" />Remove
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={`field-name-${key}`}>Field name</Label>
              <Input id={`field-name-${key}`} maxLength={120} value={field.name} onChange={(event) => update(key, { name: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`field-type-${key}`}>Field type</Label>
              <Select value={customFieldType(field.type)} disabled={!!field.id} onValueChange={(type) => update(key, { type, choices: type === 'select' ? field.choices : [] })}>
                <SelectTrigger id={`field-type-${key}`}><SelectValue /></SelectTrigger>
                <SelectContent>{CUSTOM_FIELD_TYPES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
              </Select>
              {field.id && <p className="text-xs text-slate-500">Saved field types cannot be changed. Add a new field instead.</p>}
            </div>
          </div>
          {customFieldType(field.type) === 'select' && <div className="space-y-2">
            <p className="text-sm font-medium">Dropdown choices</p>
            {field.choices.map((choice, choiceIndex) => <div key={choiceIndex} className="flex gap-2">
              <Input aria-label={`Choice ${choiceIndex + 1} for ${field.name || 'new field'}`} maxLength={200} value={choice}
                readOnly={choiceIndex < originalChoices.length}
                onChange={(event) => update(key, { choices: field.choices.map((item, i) => i === choiceIndex ? event.target.value : item) })} />
              {choiceIndex >= originalChoices.length && <Button variant="outline" onClick={() => update(key, { choices: field.choices.filter((_, i) => i !== choiceIndex) })} aria-label={`Remove choice ${choiceIndex + 1}`}>Remove</Button>}
            </div>)}
            <Button variant="outline" size="sm" disabled={field.choices.length >= 100} onClick={() => update(key, { choices: [...field.choices, ''] })}>Add choice</Button>
            {originalChoices.length > 0 && <p className="text-xs text-slate-500">Saved choices are fixed to protect existing group values. You can append choices.</p>}
          </div>}
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor={`field-published-${key}`}>Show on Member Group Detail Page</Label>
            <Switch id={`field-published-${key}`} checked={field.show_on_detail} onCheckedChange={(checked) => update(key, { show_on_detail: checked })} />
          </div>
        </div>;
      })}
    </fieldset>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Button variant="outline" disabled={pending || !definitions.ready || draft.length >= 50} onClick={() => setDraft((fields) => [...fields, {
        _key: crypto.randomUUID(), name: '', type: 'text', choices: [], show_on_detail: false,
      }])}><Plus className="w-4 h-4 mr-2" />Add field</Button>
      <Button onClick={handleSave} disabled={pending || !definitions.ready} data-testid="button-save-custom-fields">
        <Save className="w-4 h-4 mr-2" />{pending ? 'Saving custom fields…' : 'Save Custom Fields'}
      </Button>
    </div>
    <AlertDialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Remove this custom field?</AlertDialogTitle>
          <AlertDialogDescription>
            {removeTarget?.name || 'This field'} will no longer appear in group editing or on detail pages.
            {removeTarget?.id ? ' Saving this removal also deletes its values from all groups. This cannot be undone.' : ' This new field has not been saved.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep field</AlertDialogCancel>
          <AlertDialogAction onClick={() => {
            if (removeTarget.id) setDeletedIds((ids) => [...ids, removeTarget.id]);
            setDraft((fields) => fields.filter((field) => (field.id || field._key) !== (removeTarget.id || removeTarget._key)));
            setRemoveTarget(null);
          }}>Confirm removal</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={reloadConfirm} onOpenChange={setReloadConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Discard your custom field draft?</AlertDialogTitle>
          <AlertDialogDescription>Reloading replaces your unsaved field changes with the latest saved definitions. Other settings are not affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep draft</AlertDialogCancel>
          <AlertDialogAction onClick={async () => {
            const result = await definitions.refetch();
            if (result.isSuccess) reset(result.data);
            else setError('Could not reload custom fields. Your draft is kept.');
          }}>Discard and reload</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

export default function CustomFieldSettingsCard({ enabled }) {
  const definitions = useMemberGroupCustomFields(enabled);
  return <Card>
    <CardHeader><CardTitle>Member group custom fields</CardTitle>
      <CardDescription>Add optional information to each group. Only fields marked for display are shared on the group detail page. Save these fields separately from other settings.</CardDescription>
    </CardHeader>
    <CardContent>
      {!definitions.allowed ? <p className="text-sm text-slate-600">Custom fields require a verified administrator session.</p>
        : definitions.data?.available === false ? <p role="status" className="text-sm text-slate-600">Custom fields are awaiting a database upgrade. Existing groups can still be created and edited.</p>
        : definitions.data ? <DefinitionsEditor key={definitions.scopeKey} definitions={definitions} />
          : definitions.isError ? <div role="alert" className="space-y-3 text-sm text-red-600"><p>Custom fields could not be loaded: {definitions.error.message}</p><Button variant="outline" onClick={() => definitions.refetch()}>Retry loading fields</Button></div>
            : <div role="status" aria-label="Loading custom fields" className="space-y-3"><div className="h-5 w-40 rounded bg-slate-100" /><div className="h-10 rounded bg-slate-100" /></div>}
    </CardContent>
  </Card>;
}
