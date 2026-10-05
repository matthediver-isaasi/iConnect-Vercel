import React, { useState } from 'react';
import { Button } from '@/components/ui/button';

export default function PublicTicketMemberDiagnostics({ eventId }) {
  const [purchases, setPurchases] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!eventId) return null;
  const load = async () => {
    const response = await fetch(`/api/admin/public-ticket-members?event_id=${encodeURIComponent(eventId)}`, { credentials: 'include' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load member creation outcomes');
    setPurchases(data.purchases);
  };
  const act = async purchaseId => {
    setBusy(true); setError('');
    try {
      if (purchaseId) {
        const response = await fetch('/api/admin/public-ticket-members', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purchase_id: purchaseId }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to retry member creation');
      }
      await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <section className="my-4 rounded-lg border p-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Ticket member creation</h3>
      <Button type="button" variant="outline" disabled={busy} onClick={() => act()}>{busy ? 'Loading…' : 'View recent outcomes'}</Button>
    </div>
    <p className="text-sm text-slate-500">Creation issues do not cancel confirmed bookings. Retrying never charges the purchaser or changes an existing member.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {purchases?.length === 0 && <p className="text-sm">No member-creation purchases recorded for this event.</p>}
    {purchases?.map(purchase => <div key={purchase.id} className="border-t pt-3 text-sm flex flex-wrap items-center justify-between gap-2">
      <div><p className="font-mono text-xs">{purchase.id}</p><p>{purchase.state} · {purchase.attempts} attempts</p>
        {purchase.last_error_code && <p className="text-amber-700">{purchase.last_error_code.replaceAll('_', ' ')}</p>}</div>
      {['prepared', 'ready', 'retryable'].includes(purchase.state) || purchase.last_error_code === 'role_policy_conflict'
        ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(purchase.id)}>{purchase.last_error_code === 'capacity_refund_pending' ? 'Retry refund' : 'Retry creation'}</Button>
        : null}
    </div>)}
    {purchases?.length === 50 && <p className="text-xs text-slate-500">Showing the latest 50 purchases.</p>}
  </section>;
}
