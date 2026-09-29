import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export default function CampaignTestSourcePicker({ campaignId, value, onChange, disabled }) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/email-campaigns/test-send', {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'search-sources', campaignId, search, offset }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load campaign audience');
        if (!controller.signal.aborted) {
          setResults(data.recipients);
          setHasMore(data.hasMore);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [campaignId, search, offset, retry]);

  return <section className="space-y-2 border rounded-md p-3">
    <Label htmlFor="campaign-test-source">Personalize as (optional source recipient)</Label>
    <p className="text-xs text-muted-foreground">
      Uses the saved campaign audience and content. The source receives nothing unless you also enter their address as a test destination.
    </p>
    {value && <div className="text-sm">
      Source: <strong>{value}</strong>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>Clear</Button>
    </div>}
    {!value && <p className="text-xs text-muted-foreground">No source selected: use the existing generic test.</p>}
    <Input id="campaign-test-source" value={search} disabled={disabled}
      placeholder="Search audience by name or email"
      onChange={e => { setSearch(e.target.value); setOffset(0); }} />
    {loading ? <p role="status" className="text-sm">Loading campaign audience…</p>
      : error ? <div role="alert" className="text-sm text-destructive">{error}
        <Button type="button" variant="ghost" onClick={() => setRetry(n => n + 1)}>Retry</Button>
      </div>
      : <><div className="max-h-32 overflow-y-auto">
        {results.length === 0 && <p className="text-sm">No eligible recipients found in the saved campaign audience.</p>}
        {results.map(r => <button key={r.email} type="button" disabled={disabled}
          aria-pressed={value === r.email} onClick={() => onChange(r.email)}
          className="block w-full text-left border-b p-2 text-sm hover:bg-muted">
          {r.first_name} {r.last_name} — {r.email}
        </button>)}
      </div>
        <div className="flex justify-between">
          <Button type="button" variant="ghost" size="sm" disabled={disabled || offset === 0} onClick={() => setOffset(n => Math.max(0, n - 25))}>Previous</Button>
          <Button type="button" variant="ghost" size="sm" disabled={disabled || !hasMore} onClick={() => setOffset(n => n + 25)}>Next</Button>
        </div></>}
    {value && <p className="text-xs text-amber-700">Booking, entrance QR and survey links are real. Do not check in or submit a survey while testing. Preference links remain inactive.</p>}
  </section>;
}