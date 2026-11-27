import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { biographyHelperKey, requestBiographyHelperSettings, useBiographyHelperSettings } from '@/hooks/useBiographyHelperSettings';
import { BIOGRAPHY_HELPER_MAX_LENGTH, DEFAULT_BIOGRAPHY_HELPER_TEXT } from '../../../shared/biographyHelperText.js';

export default function BiographyHelperSettings() {
  const query = useBiographyHelperSettings();
  // A tenant-keyed editor prevents a previous tenant's draft crossing a switch.
  return <BiographyHelperEditor key={query.tenantId || 'inactive'} query={query} />;
}

function BiographyHelperEditor({ query }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const value = draft ?? query.data?.helperText ?? '';
  const invalid = value.length > BIOGRAPHY_HELPER_MAX_LENGTH;
  async function save(text) {
    if (saving) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const data = await requestBiographyHelperSettings(query.tenantId, text);
      client.setQueryData(biographyHelperKey(query.tenantId), data);
      setDraft(null);
      setMessage('Biography helper text saved.');
      await client.invalidateQueries({ queryKey: biographyHelperKey(query.tenantId) });
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return <Card className="mb-6">
    <CardHeader>
      <CardTitle>Professional Biography</CardTitle>
      <CardDescription>Set the explanation beneath the biography input on About-me. This does not change members’ biographies.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {(error || query.error) && <div role="alert" className="text-sm text-red-700">
        <p>{error || query.error.message} Your unsaved edits have been kept.</p>
        {query.error && <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Retry loading biography settings</Button>}
      </div>}
      {message && <p role="status" className="text-sm text-green-700">{message}</p>}
      {query.isLoading && <p role="status">Loading biography helper text…</p>}
      {!query.tenantId && <p role="alert">Select a tenant to load biography helper settings.</p>}
      {query.data && <>
        <Label htmlFor="biography-helper-text">Professional Biography helper text</Label>
        <Textarea id="biography-helper-text" value={value} disabled={saving || !query.data.canManage}
          aria-describedby="biography-helper-guidance"
          onChange={event => { setDraft(event.target.value); setMessage(''); setError(''); }} />
        <p id="biography-helper-guidance" className="text-sm text-muted-foreground">Plain text, up to {BIOGRAPHY_HELPER_MAX_LENGTH} characters. Blank text uses the default: {DEFAULT_BIOGRAPHY_HELPER_TEXT}</p>
        {invalid && <p role="alert" className="text-sm text-red-700">Helper text must be {BIOGRAPHY_HELPER_MAX_LENGTH} characters or fewer.</p>}
        {query.data.canManage ? <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={saving || invalid || draft === null} onClick={() => save(value)}>{saving ? 'Saving…' : 'Save biography helper text'}</Button>
          <Button type="button" variant="outline" disabled={saving} onClick={() => save('')}>Reset to default</Button>
        </div> : <p>Administrator access is required to change this setting.</p>}
      </>}
    </CardContent>
  </Card>;
}
