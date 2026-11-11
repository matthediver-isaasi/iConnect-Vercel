import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CART_LOCKED_EVENT, CART_UNLOCKED_EVENT, CART_UNAVAILABLE_EVENT } from '@/lib/formCart';
import { normalizeCartAnswer } from '../../../../shared/formCart.js';

let instanceCounter = 0;
const money = (value, currency) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value / 100);

export default function CartField({ field, formId, value, onChange, disabled, onValidityChange }) {
  const [instance] = useState(() => ++instanceCounter);
  const [locked, setLocked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [category, setCategory] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [bundleQuantity, setBundleQuantity] = useState('1');
  const lockQuery = useQuery({ queryKey: ['form-cart-locked', formId], queryFn: () => false, enabled: false });
  const cartLocked = locked || lockQuery.data === true;
  const callbacks = useRef({ onChange, onValidityChange });
  callbacks.current = { onChange, onValidityChange };
  const query = useQuery({
    queryKey: ['public-form-cart', publicClient.getTenantSlug(), formId, field.id, instance, field.show_bundle_category === true],
    queryFn: () => publicClient.listFormBundles(formId, field.id),
    enabled: !!formId, retry: false, staleTime: 0, gcTime: 0,
  });
  const refresh = useRef(query.refetch);
  refresh.current = query.refetch;
  useEffect(() => {
    setLocked(false);
    const handleUnavailable = event => {
      if (event.detail?.formId !== formId || (event.detail.fieldId && event.detail.fieldId !== field.id)) return;
      setUnavailable(true);
      refresh.current();
    };
    const handleLocked = event => { if (event.detail?.formId === formId) setLocked(true); };
    const handleUnlocked = event => {
      if (event.detail?.formId !== formId) return;
      setLocked(false);
      refresh.current();
    };
    window.addEventListener(CART_UNAVAILABLE_EVENT, handleUnavailable);
    window.addEventListener(CART_LOCKED_EVENT, handleLocked);
    window.addEventListener(CART_UNLOCKED_EVENT, handleUnlocked);
    return () => {
      window.removeEventListener(CART_UNAVAILABLE_EVENT, handleUnavailable);
      window.removeEventListener(CART_LOCKED_EVENT, handleLocked);
      window.removeEventListener(CART_UNLOCKED_EVENT, handleUnlocked);
    };
  }, [formId, field.id]);
  let answer;
  let invalidAnswer = false;
  try { answer = normalizeCartAnswer(value); }
  catch {
    // Do not overwrite restored data on a failed read. Render only safe identity
    // fragments; the explicit clear control is the only automatic reset path.
    answer = { version: 1, lines: Array.isArray(value?.lines) ? value.lines.filter(line =>
      line && typeof line.kind === 'string' && typeof line.id === 'string' && Number.isSafeInteger(line.quantity)) : [] };
    invalidAnswer = true;
  }
  const items = query.data?.items || [];
  const findItem = line => items.find(item => item.kind === line.kind && item.id === line.id);
  const bundles = items.filter(item => item.kind === 'bundle').sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id));
  const bundleLabel = field.bundle_label?.trim() || 'Bundle';
  const categoryLabel = field.bundle_category_label?.trim() || 'Bundle category';
  const missingBundle = field.bundle_required === true && !answer.lines.some(line => line.kind === 'bundle');
  const categoryKey = item => item.categoryId || '_uncategorised';
  const categories = [...new Map(bundles.map(item => [categoryKey(item), item.categoryName || 'Uncategorised'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const visibleBundles = bundles.filter(item => !field.show_bundle_category || !category || categoryKey(item) === category);
  const pickedBundle = visibleBundles.find(item => item.id === bundleId);
  const pickedLine = answer.lines.find(line => line.kind === 'bundle' && line.id === bundleId);
  const dropdown = field.bundle_display === 'dropdown';
  useEffect(() => {
    if (bundleId && !pickedBundle && !query.isFetching && !query.isError) setBundleId('');
  }, [bundleId, pickedBundle, query.isFetching, query.isError]);
  const valid = !invalidAnswer && !missingBundle && (!field.required || answer.lines.length > 0) && answer.lines.every(line => {
    const item = findItem(line);
    return item?.available === true && (item.remaining === null || line.quantity <= item.remaining);
  });
  useEffect(() => {
    callbacks.current.onValidityChange?.(field.id, !!formId && valid && !query.isError && !query.isFetching);
  }, [field.id, formId, valid, query.isError, query.isFetching]);
  const changeQuantity = (kind, id, quantity) => {
    if (readonly || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000) return;
    const item = findItem({ kind, id });
    if (quantity > 0 && (!item?.available || quantity > (item.remaining ?? 1000))) return;
    const lines = answer.lines.filter(line => !(line.kind === kind && line.id === id));
    if (quantity > 0) lines.push({ kind, id, quantity });
    callbacks.current.onChange({ version: 1, lines });
    setUnavailable(false);
    if (kind === 'bundle' && id === bundleId) setBundleQuantity(String(quantity || 1));
  };
  const readonly = disabled || cartLocked || !formId || query.isPending || query.isFetching || query.isError;
  const draftQuantity = Number(bundleQuantity);
  const canAdd = pickedBundle?.available && Number.isSafeInteger(draftQuantity) && draftQuantity >= 1
    && draftQuantity <= Math.min(1000, pickedBundle.remaining ?? 1000);
  return <div className="space-y-3">
    {cartLocked && <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">Checkout has started. Your cart is locked to this payment attempt.</p>}
    {unavailable && <p role="alert" className="text-sm text-destructive">A cart item is no longer available. Your cart and other answers have been kept. Review quantities before retrying.</p>}
    {!formId ? <p className="text-sm text-muted-foreground">Save the form to preview cart options.</p>
      : query.isFetching || query.isPending ? <div role="status" className="animate-pulse rounded-md bg-muted p-3 text-sm">Loading cart options…</div>
      : query.isError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>Cart options are unavailable. Your selections have been kept.</p><Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>Retry cart options</Button></div>
      : items.length === 0 ? <p className="rounded-md border bg-muted/40 p-3 text-sm">No items are currently offered on this form.</p> : null}
    {field.show_bundle_category === true && bundles.length > 0 && <label className="block text-sm">{categoryLabel}
      <select aria-label={categoryLabel} className="mt-1 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
        disabled={readonly} value={category} onChange={event => {
          setCategory(event.target.value);
          if (event.target.value && pickedBundle && categoryKey(pickedBundle) !== event.target.value) setBundleId('');
        }}>
        <option value="">All categories</option>
        {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>}
    {!query.isPending && !query.isError && bundles.length > 0 && visibleBundles.length === 0 && <p role="status" className="text-sm">No bundles match this category.</p>}
    {dropdown && !query.isPending && !query.isError && <div className="space-y-2">
      <label className="block text-sm">{bundleLabel}{field.bundle_required === true ? ' (required)' : ''}
        <select aria-label={bundleLabel} className="mt-1 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
          disabled={readonly} value={bundleId} onChange={event => {
            setBundleId(event.target.value);
            setBundleQuantity(String(answer.lines.find(line => line.kind === 'bundle' && line.id === event.target.value)?.quantity || 1));
          }}>
          <option value="">Choose a bundle…</option>
          {visibleBundles.map(item => <option key={item.id} value={item.id} disabled={!item.available}>
            {item.name} — {money(item.unitPriceMinor, item.currency)}{!item.available ? ' — Sold out / unavailable' : ''}
          </option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Quantity<Input aria-label="Bundle quantity" className="w-24" type="number" min="1"
          max={Math.min(1000, pickedBundle?.remaining ?? 1000)} step="1" value={bundleQuantity}
          disabled={readonly || !pickedBundle?.available} aria-invalid={!!bundleId && !canAdd}
          onChange={event => setBundleQuantity(event.target.value)} /></label>
        <Button type="button" disabled={readonly || !canAdd} onClick={() => changeQuantity('bundle', bundleId, draftQuantity)}>
          {pickedLine ? 'Update bundle' : 'Add bundle'}
        </Button>
      </div>
    </div>}
    {!query.isPending && !query.isError && items.filter(item => item.kind !== 'bundle'
      || answer.lines.some(line => line.kind === 'bundle' && line.id === item.id)
      || (!dropdown && visibleBundles.includes(item))).map(item => {
      const line = answer.lines.find(line => line.kind === item.kind && line.id === item.id);
      const quantity = line?.quantity || 0;
      return <div key={`${item.kind}:${item.id}`} className="space-y-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium">{item.name}</p>{item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}</div><p className="text-sm font-medium">{money(item.unitPriceMinor, item.currency)} each</p></div>
        <p className="text-xs text-muted-foreground">{item.taxTreatment === 'standard' ? `Plus ${item.taxRateBps / 100}% tax` : item.taxTreatment?.replaceAll('_', ' ')} · {!item.available ? 'Unavailable' : item.remaining === null ? 'Unlimited availability' : `${item.remaining} available`}</p>
        <div className="flex flex-wrap items-center gap-2"><label className="text-xs" htmlFor={`cart-${field.id}-${item.kind}-${item.id}`}>Quantity</label><Input id={`cart-${field.id}-${item.kind}-${item.id}`} className="w-24" type="number" min={quantity > 0 ? 1 : 0} max={Math.min(1000, item.remaining ?? 1000)} step="1" value={quantity} disabled={readonly || !item.available} aria-invalid={quantity > (item.remaining ?? 1000)} onChange={event => {
          const next = Number(event.target.value);
          if (Number.isSafeInteger(next) && next >= 0 && next <= 1000) changeQuantity(item.kind, item.id, next);
        }} />{quantity > 0 && <Button type="button" variant="ghost" size="sm" disabled={readonly} onClick={() => changeQuantity(item.kind, item.id, 0)}>Remove</Button>}</div>
      </div>;
    })}
    {answer.lines.filter(line => !findItem(line)).map((line, index) => <div key={`${line.kind}:${line.id}:${index}`} className="rounded-md border border-amber-200 p-3 text-sm"><p className="text-amber-700">Saved {line.kind || 'item'} unavailable ({line.id}) · quantity {line.quantity}</p><Button type="button" variant="ghost" size="sm" disabled={readonly} onClick={() => changeQuantity(line.kind, line.id, 0)}>Remove saved item</Button></div>)}
    {invalidAnswer && <div role="alert" className="text-sm text-destructive"><p>This saved cart cannot be read. It has not been changed automatically.</p><Button type="button" variant="outline" size="sm" disabled={readonly} onClick={() => { if (!readonly) callbacks.current.onChange({ version: 1, lines: [] }); }}>Clear unreadable cart</Button></div>}
    {missingBundle && !query.isFetching && <p role="alert" className="text-sm text-destructive">Add at least one bundle to continue.</p>}
    {!valid && !missingBundle && answer.lines.length > 0 && !query.isFetching && <p role="alert" className="text-sm text-destructive">Review unavailable items and quantities before checkout.</p>}
    <p className="text-xs text-muted-foreground">Nothing is added automatically. The Payment total includes tax and is confirmed before checkout. Cart selections cannot be edited after checkout starts.</p>
  </div>;
}
