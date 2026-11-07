import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/adminFetch';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function MembershipRenewalJourneySettings({ tenantId }) {
  const [saved, setSaved] = useState(null);
  const [mode, setMode] = useState('same_schedule');
  const [formId, setFormId] = useState('');
  const [forms, setForms] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function request(options) {
    const response = await adminFetch('/api/admin/membership-renewal-journey', options || {}, tenantId);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Renewal settings unavailable');
    return body;
  }
  async function load() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await request();
      setSaved(result.settings); setMode(result.settings.mode); setFormId(result.settings.form_id || ''); setForms(result.forms);
    } catch (e) { setError(e.message); setSaved(null); } finally { setBusy(false); }
  }
  useEffect(() => { if (tenantId) void load(); }, [tenantId]);
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, formId: mode === 'questionnaire' ? formId : null, expectedRevision: saved.revision }) });
      setSaved(result.settings); setMessage('Renewal journey saved. Memberships and payments have not been changed.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <Card>
    <CardHeader><CardTitle>Membership renewal journey</CardTitle>
      <CardDescription>Choose where the portal’s Renew and Restart membership buttons take members. Existing membership dates and payment protections still apply.</CardDescription></CardHeader>
    <CardContent>
      {error && <p role="alert" className="mb-3 text-red-600">{error}</p>}
      {message && <p role="status" className="mb-3">{message}</p>}
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={busy || !saved} className="space-y-3">
          <label className="flex items-start gap-2"><input type="radio" name="renewal-journey" checked={mode === 'same_schedule'} onChange={() => setMode('same_schedule')} />
            <span>Continue with the existing membership schedule<span className="block text-sm text-muted-foreground">Keep the current payment card’s configured renewal link and renewal behaviour.</span></span></label>
          <label className="flex items-start gap-2"><input type="radio" name="renewal-journey" checked={mode === 'questionnaire'} onChange={() => setMode('questionnaire')} />
            <span>Reassess through a form<span className="block text-sm text-muted-foreground">Ask questions first, then use your form’s rules to route members to the correct renewal form.</span></span></label>
          {mode === 'questionnaire' && <label className="block space-y-2"><span>Renewal entry form</span>
            <select className="block w-full rounded-md border bg-background p-2" required value={formId} onChange={e => setFormId(e.target.value)}>
              <option value="">Choose a form</option>
              {formId && !forms.some(f => f.id === formId) && <option value={formId}>Saved form is currently unavailable</option>}
              {[...forms].sort((a,b) => (a.name || '').localeCompare(b.name || '')).map(f => <option key={f.id} value={f.id}>{f.name || 'Unnamed form'}</option>)}
            </select><span className="block text-sm text-muted-foreground">Only active forms requiring login are listed. This is the starting questionnaire, not necessarily the form that takes payment.</span></label>}
        </fieldset>
        <div className="flex gap-2"><Button type="submit" disabled={busy || !saved || (mode === 'questionnaire' && !formId)}>{busy ? 'Please wait…' : 'Save renewal journey'}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={load}>Reload settings</Button></div>
      </form>
    </CardContent>
  </Card>;
}
