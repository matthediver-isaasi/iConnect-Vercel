import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { Button } from '@/components/ui/button';
import { BUNDLE_UNAVAILABLE_EVENT } from '@/lib/formBundles';

let queryInstance = 0;

export default function BundleSelectionField({ field, formId, value, onChange, disabled, onValidityChange }) {
  // Scope option caches to this mounted respondent. Never reuse a private
  // form's options after sign-out/sign-in in the same QueryClient.
  const [instance] = useState(() => ++queryInstance);
  const [unavailable, setUnavailable] = useState(false);
  const callbacks = useRef({ onChange, onValidityChange });
  callbacks.current = { onChange, onValidityChange };
  const query = useQuery({
    queryKey: ['public-form-bundles', publicClient.getTenantSlug(), formId, field.id, instance],
    queryFn: () => publicClient.listFormBundles(formId, field.id),
    enabled: !!formId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  useEffect(() => {
    const handleUnavailable = event => {
      if (event.detail?.formId !== formId || (event.detail.fieldId && event.detail.fieldId !== field.id)) return;
      callbacks.current.onChange('');
      setUnavailable(true);
      refetch.current();
    };
    window.addEventListener(BUNDLE_UNAVAILABLE_EVENT, handleUnavailable);
    return () => window.removeEventListener(BUNDLE_UNAVAILABLE_EVENT, handleUnavailable);
  }, [formId, field.id]);
  const items = query.data?.items || [];
  const selected = items.find(item => item.id === value);
  const valid = (!value && !field.required) || (!!selected && selected.available === true);
  useEffect(() => {
    callbacks.current.onValidityChange?.(field.id, !query.isError && !query.isFetching && !!formId && valid);
  }, [field.id, formId, valid, query.isError, query.isFetching]);
  return <div className="space-y-2">
    {unavailable && <p role="alert" className="text-sm text-destructive">That bundle is no longer available. Your other answers have been kept. Please choose again.</p>}
    {!formId ? <p className="text-sm text-muted-foreground">Save the form to preview bundle options.</p>
      : query.isPending || query.isFetching ? <div role="status" className="animate-pulse rounded-md bg-muted p-3 text-sm text-muted-foreground">Loading bundles…</div>
      : query.isError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>Bundle options could not be loaded.</p><Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>Retry bundles</Button></div>
      : items.length === 0 ? <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">No bundles are currently offered on this form.</p>
      : <select aria-label={field.label || 'Bundle selection'} required={field.required} disabled={disabled} value={value || ''}
        aria-invalid={!!value && !valid} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
        onChange={event => { setUnavailable(false); onChange(event.target.value); }}>
        <option value="">Choose a bundle…</option>
        {value && !selected && <option value={value} disabled>Previously selected bundle — unavailable</option>}
        {items.map(item => <option key={item.id} value={item.id} disabled={!item.available}>
          {item.name} — {new Intl.NumberFormat('en-GB', { style: 'currency', currency: item.currency }).format(item.amountMinor / 100)}
          {!item.available ? ' — Sold out / unavailable' : item.remaining === null ? '' : ` — ${item.remaining} available`}
        </option>)}
      </select>}
    <p className="text-xs text-muted-foreground">Your bundle selection cannot be changed after submission. Deleting a submission does not automatically restore stock.</p>
  </div>;
}
