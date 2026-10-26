import { useEffect, useState, useRef } from 'react';
import { getActiveTenantId } from '@/api/base44Client';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';

const endpoint = '/api/admin/event-registration-communication';
function tenantHeaders() {
  const tenant = getActiveTenantId();
  return { 'Content-Type': 'application/json', ...(tenant ? { 'X-Tenant-Id': tenant } : {}) };
}
export async function saveEventRegistrationCommunication(eventId, kind, ids) {
  // null means discovery has not completed; never erase an existing selection.
  if (ids === null) return;
  const response = await fetch(endpoint, {
    method: 'PUT', credentials: 'include', headers: tenantHeaders(),
    body: JSON.stringify({ event_id: eventId, event_kind: kind, category_ids: ids }),
  });
  if (!response.ok) throw new Error('Event saved, but communication settings could not be saved. Please retry saving.');
}

export default function EventRegistrationCommunication({ eventId, kind, value, onChange }) {
  const priorEvent = useRef(eventId);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (priorEvent.current !== eventId) { priorEvent.current = eventId; onChange(null); }
    const controller = new AbortController();
    setLoading(true); setError(false);
    const query = new URLSearchParams({ event_kind: kind });
    if (eventId) query.set('event_id', eventId);
    fetch(`${endpoint}?${query}`, { credentials: 'include', headers: tenantHeaders(), signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Unavailable');
        const data = await response.json();
        if (controller.signal.aborted) return;
        setCategories(data.categories);
        onChange(current => current === null ? data.category_ids : current);
      }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [eventId, kind, retry, onChange]);
  return <Card>
    <CardHeader>
      <CardTitle>Post-registration communications</CardTitle>
      <CardDescription>Offer an optional subscription choice to the booker only, never their attendees. Only currently eligible, unsubscribed categories will appear. This is separate from donation settings.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {loading ? <p role="status">Loading communication categories…</p> : error ? <div role="alert">
        Communication settings could not be loaded. Existing selections will be preserved.
        <Button type="button" variant="outline" onClick={() => setRetry(n => n + 1)}>Retry</Button>
      </div> : <>
        {!categories.length && <p className="text-sm text-muted-foreground">No active communication categories.</p>}
        {categories.map(category => <label key={category.id} className="flex items-center gap-2">
          <Checkbox checked={(value || []).includes(category.id)} onCheckedChange={checked => onChange(current =>
            checked ? [...new Set([...(current || []), category.id])] : (current || []).filter(id => id !== category.id))} />
          <span>{category.name}</span>
        </label>)}
        {(value || []).filter(id => !categories.some(c => c.id === id)).map(id => <div key={id} className="text-sm">
          An unavailable category is selected. <Button type="button" variant="link" onClick={() => onChange(current => current.filter(item => item !== id))}>Remove</Button>
        </div>)}
        <p className="text-sm text-muted-foreground">Leave all unchecked to disable the prompt.</p>
      </>}
    </CardContent>
  </Card>;
}
