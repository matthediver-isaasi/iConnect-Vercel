import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

const active = new Map();
const cancellations = new Map();
const scopeKey = ({ eventId, kind = 'simple', memberId = null }) => `event-consent:${kind}:${eventId}:${memberId || 'guest'}`;
export function cancelEventRegistrationConsent(context) {
  cancellations.get(scopeKey(context))?.();
}
const storage = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* storage is optional */ } },
};
async function request(offer, action, ids = []) {
  const response = await fetch('/api/public/event-registration-consent', {
    method: 'POST', credentials: 'include', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ ...offer, action, category_ids: ids }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Preferences are unavailable.');
  return data;
}

export function ConsentDialog({ categories, offer, onFinish, send = request }) {
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const skip = () => {
    // Local completion is recorded synchronously even when the network is down.
    onFinish();
    void send(offer, 'dismiss').catch(() => {});
  };
  const subscribe = async () => {
    if (saving || !selected.length) return;
    setSaving(true); setError('');
    try {
      await send(offer, 'subscribe', selected);
      onFinish();
    } catch (reason) {
      setError(reason.message || 'Preferences could not be saved. Your booking is confirmed.');
      setSaving(false);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) skip(); }}>
    <DialogContent onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Stay in touch?</DialogTitle>
        <DialogDescription>Your registration is confirmed. Optionally choose communications for yourself. This does not subscribe anyone you booked for.</DialogDescription>
      </DialogHeader>
      <fieldset disabled={saving} className="space-y-3">
        <legend className="sr-only">Optional communication categories</legend>
        {categories.map(category => <label className="flex items-start gap-3" key={category.id}>
          <Checkbox checked={selected.includes(category.id)} onCheckedChange={checked => setSelected(current =>
            checked ? [...current, category.id] : current.filter(id => id !== category.id))} />
          <span><span className="block font-medium">{category.name}</span>
            {category.description && <span className="block text-sm text-muted-foreground">{category.description}</span>}</span>
        </label>)}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error} You can skip this step without changing your booking.</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={skip} disabled={saving}>Skip</Button>
        <Button onClick={subscribe} disabled={saving || !selected.length}>{saving ? 'Saving…' : error ? 'Retry subscription' : 'Subscribe to selected'}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

// Await only after booking success and before existing redirects. Retrying this
// function never calls a booking/payment API. Tokens stay in this tab, not URLs.
export function offerEventRegistrationConsent(result, { eventId, kind = 'simple', memberId = null }) {
  const key = scopeKey({ eventId, kind, memberId });
  const offer = result?.communication_offer || storage.get(key);
  if (!offer?.id || !offer?.token) return Promise.resolve();
  const doneKey = `event-consent-done:${offer.id}`;
  if (storage.get(doneKey)) { storage.remove(key); return Promise.resolve(); }
  if (active.has(offer.id)) return active.get(offer.id);
  storage.set(key, offer);
  let cancelled = false;
  let close = () => {};
  cancellations.set(key, () => { cancelled = true; close(); });
  const work = (async () => {
    let data;
    try { data = await request(offer, 'choices'); }
    catch { return; } // Confirmation/navigation must remain usable.
    if (cancelled) return;
    if (!data.categories?.length) {
      storage.set(doneKey, true); storage.remove(key);
      return;
    }
    await new Promise(resolve => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        storage.set(doneKey, true); storage.remove(key);
        root.unmount(); container.remove(); resolve();
      };
      close = () => { root.unmount(); container.remove(); resolve(); };
      root.render(<ConsentDialog categories={data.categories} offer={offer} onFinish={finish} />);
    });
  })().finally(() => { active.delete(offer.id); cancellations.delete(key); });
  active.set(offer.id, work);
  return work;
}
