import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import MembershipFeePage from '@/pages/MembershipFeePage';

export default function FormMembershipCredit({ memberId, context, disabled, resumeToken, onRefresh, selectedVouchers = [], onSelectionChange }) {
  const key = JSON.stringify(context);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(resumeToken || null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setToken(resumeToken || null); }, [resumeToken]);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(null);
    onSelectionChange?.([]);
    const query = new URLSearchParams({ memberId, action: 'vouchers' });
    for (const [name, value] of Object.entries(JSON.parse(key))) {
      query.set(name, typeof value === 'object' ? JSON.stringify(value) : value);
    }
    fetch(`/api/forms/membership-payment?${query}`, { credentials: 'include', signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not check membership credit');
        return data;
      }).then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [memberId, key, retry]);
  async function act(action) {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/forms/membership-payment', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(key), memberId, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update credit checkout');
      setToken(data.token || null);
      if (data.released) onRefresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="rounded border bg-white p-4 space-y-3" aria-label="Available membership credit" aria-busy={!result && !error}>
    <h3 className="font-medium">Your available credit</h3>
    {!result && !error && <div role="status">
      <div className="h-4 w-3/4 rounded bg-slate-100 motion-safe:animate-pulse mb-2" />
      <p className="flex items-center gap-2 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />Checking for available membership credit…</p>
    </div>}
    {error && <div role="alert" className="text-sm text-red-700">{error}
      {!result && <Button type="button" variant="outline" onClick={() => setRetry(n => n + 1)}>Retry</Button>}
    </div>}
    {token ? <>
      <MembershipFeePage embeddedToken={token} />
      <p className="text-sm">After paying or setting up monthly payments, check your renewal status to continue the form.</p>
      <Button type="button" variant="outline" onClick={onRefresh}>Check renewal status</Button>
      <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => act('close_voucher_checkout')}>
        {busy ? 'Checking…' : 'Return to payment choices'}
      </Button>
      <p className="text-xs text-muted-foreground">If payment has started, use “Cancel payment and release credit” above first. A completed or uncertain payment cannot be cancelled here.</p>
    </> : result && <>
      {!result.vouchers?.length ? <p className="text-sm text-muted-foreground">You have no eligible credit available for this membership.</p> : <>
        <p className="text-sm">Select one or more vouchers, then choose how to pay below. The payment cards update with an estimate after credit. No credit is reserved by selecting a voucher.</p>
        <div className="grid gap-3 sm:grid-cols-2">{result.vouchers.map(voucher => {
          const selected = selectedVouchers.some(item => item.id === voucher.id);
          return <label key={voucher.id} className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer ${selected ? 'border-primary bg-primary/5' : 'border-border'}`}>
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={selected} disabled={busy || disabled}
              onChange={event => onSelectionChange?.(event.target.checked
                ? [...selectedVouchers, voucher] : selectedVouchers.filter(item => item.id !== voucher.id))} />
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{voucher.displayName || 'Member credit'}</span>
              <span className="block break-words">{voucher.code}</span>
              <span className="block font-semibold mt-1">{new Intl.NumberFormat('en-GB', { style: 'currency', currency: result.currency || 'GBP' }).format(voucher.value)}</span>
            </span>
          </label>;
        })}</div>
        <p role="status" className="text-sm text-muted-foreground">Credit payment on this form is not yet enabled. You can preview the amounts; to pay without credit, deselect the vouchers. No credit has been reserved.</p>
      </>}
    </>}
  </section>;
}
