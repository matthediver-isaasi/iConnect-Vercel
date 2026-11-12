import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { publicClient } from '@/api/publicClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CART_LOCKED_EVENT, CART_UNLOCKED_EVENT, CART_UNAVAILABLE_EVENT } from '@/lib/formCart';
import { normalizeCartAnswer } from '../../../../shared/formCart.js';
import { calculateQuoteTotals } from '../../../../shared/salesContracts.js';
import { useFormCartReservation, formatReservationTime } from '@/lib/useFormCartReservation';

let instanceCounter = 0;
const money = (value, currency) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value / 100);

export default function CartField({ field, formId, value, onChange, disabled, onValidityChange, viewOnly = false, showCartContents = true }) {
  const [instance] = useState(() => ++instanceCounter);
  const [locked, setLocked] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [category, setCategory] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [bundleQuantity, setBundleQuantity] = useState('1');
  const [draftQuantities, setDraftQuantities] = useState({});
  const [reservationError, setReservationError] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const shopping = useFormCartReservation(formId, field, next => {
    if (JSON.stringify(next) !== JSON.stringify(value || { version: 1, lines: [] })) onChange?.(next);
  }, value);
  useEffect(() => {
    if (shopping.reservation?.state === 'shopping') setReservationError(null);
  }, [shopping.reservation]);
  useEffect(() => {
    if (!shopping.reservation?.expiresAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shopping.reservation?.expiresAt]);
  const lockQuery = useQuery({ queryKey: ['form-cart-locked', formId], queryFn: () => false, enabled: false });
  const cartLocked = locked || lockQuery.data === true || shopping.reservation?.state === 'held';
  const cartCommitted = shopping.reservation?.state === 'consumed';
  const recovery = useQuery({ queryKey: ['form-cart-recovery', formId], queryFn: () => null, enabled: false });
  const callbacks = useRef({ onChange, onValidityChange });
  callbacks.current = { onChange, onValidityChange };
  const query = useQuery({
    queryKey: ['public-form-cart', publicClient.getTenantSlug(), formId, field.id, instance, field.show_bundle_category === true, shopping.token],
    queryFn: () => publicClient.listFormBundles(formId, field.id, shopping.token),
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
      setUnavailable(false);
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
  const maximum = item => {
    const configured = item?.kind === 'bundle' ? field.bundle_max_quantities?.[item.id] : undefined;
    return Number.isInteger(configured) && configured >= 1 && configured <= 1000 ? configured : 1000;
  };
  const limit = item => Math.min(maximum(item), item?.remaining ?? 1000);
  const committedQuantity = item => answer.lines.find(line => line.kind === item.kind && line.id === item.id)?.quantity || 0;
  const dropdown = field.bundle_display === 'dropdown';
  const productsHeading = field.products_heading?.trim();
  const catalogueItems = [...(dropdown ? [] : visibleBundles), ...items.filter(item => item.kind === 'product')];
  const firstProduct = catalogueItems.find(item => item.kind === 'product');
  useEffect(() => {
    if (bundleId && !pickedBundle && !query.isFetching && !query.isError) setBundleId('');
  }, [bundleId, pickedBundle, query.isFetching, query.isError]);
  const reservationElapsed = shopping.reservation?.expiresAt
    && ['shopping', 'held'].includes(shopping.reservation.state)
    && formatReservationTime(shopping.reservation, clock) === '0:00';
  const valid = !invalidAnswer && !missingBundle && (!field.required || answer.lines.length > 0) && answer.lines.every(line => {
    const item = findItem(line);
    return item?.available === true && line.quantity <= limit(item);
  });
  useEffect(() => {
    callbacks.current.onValidityChange?.(field.id, !!formId && valid && !query.isError && !query.isFetching
      && !shopping.busy && !shopping.error && !reservationElapsed);
  }, [field.id, formId, valid, query.isError, query.isFetching, shopping.busy, shopping.error, reservationElapsed]);
  const changeQuantity = (kind, id, quantity) => {
    if (readonly || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000) return;
    const item = findItem({ kind, id });
    if (quantity > 0 && (!item?.available || quantity > limit(item))) return;
    const lines = answer.lines.filter(line => !(line.kind === kind && line.id === id));
    if (quantity > 0) lines.push({ kind, id, quantity });
    if (query.data?.reservationReady) {
      setReservationError(null);
      shopping.update({ version: 1, lines }).catch(error => setReservationError(error.message));
    } else callbacks.current.onChange({ version: 1, lines });
    setUnavailable(false);
  };
  const readonly = disabled || cartLocked || cartCommitted || shopping.busy || reservationElapsed || !!shopping.error
    || !formId || query.isPending || query.isFetching || query.isError;
  const draftQuantity = maximum(pickedBundle) === 1 ? 1 : Number(bundleQuantity);
  const canAddQuantity = (item, quantity) => item?.available && Number.isSafeInteger(quantity) && quantity >= 1
    && committedQuantity(item) + quantity <= limit(item);
  const canAdd = canAddQuantity(pickedBundle, draftQuantity);
  const add = (item, quantity) => {
    if (!readonly && canAddQuantity(item, quantity)) changeQuantity(item.kind, item.id, committedQuantity(item) + quantity);
  };
  const contentsVisible = viewOnly || showCartContents;
  const restoredLegacySelection = useRef(false);
  useEffect(() => {
    // Older saved drafts predate reservation IDs. Reserve their existing
    // selections once, instead of sending them to an impossible checkout.
    if (restoredLegacySelection.current || !query.data?.reservationReady || shopping.token
      || value?.reservation_id || !answer.lines.length || invalidAnswer || cartLocked || cartCommitted) return;
    restoredLegacySelection.current = true;
    shopping.update(answer).catch(error => setReservationError(error.message));
  }, [query.data?.reservationReady, shopping.token, value, invalidAnswer, cartLocked, cartCommitted]);
  const pricedLines = answer.lines.map(line => ({ ...line, item: findItem(line) }));
  let totalsAvailable = !invalidAnswer && !query.isPending && !query.isFetching && !query.isError
    && pricedLines.every(line => line.item && Number.isSafeInteger(line.item.unitPriceMinor))
    && new Set(pricedLines.map(line => line.item?.currency)).size <= 1;
  const currency = pricedLines[0]?.item?.currency || items[0]?.currency || 'GBP';
  let totals;
  if (totalsAvailable) {
    try {
      totals = pricedLines.length === 0 ? { netMinor: 0, taxMinor: 0, grossMinor: 0 } : calculateQuoteTotals(pricedLines.map(line => ({
        quantity: String(line.quantity),
        quotedUnitPriceMinor: line.item.unitPriceMinor,
        taxRateBps: line.item.taxTreatment === 'standard' ? line.item.taxRateBps : 0,
      })));
    } catch { totalsAvailable = false; }
  }
  return <div className="space-y-3">
    {shopping.busy && <p role="status" className="text-sm">Updating your stock reservation…</p>}
    {(reservationError || shopping.error) && <p role="alert" className="text-sm text-destructive">{reservationError || 'Your reservation could not be checked. Your cart has been kept; please check your connection.'}</p>}
    {shopping.message && <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">{shopping.message}</p>}
    {reservationElapsed ? <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">{shopping.reservation.state === 'held'
      ? 'Your reservation time has ended. Checking payment before clearing your cart…'
      : 'Your reservation time has ended. Confirming expiry and clearing your cart…'}</p>
      : field.show_reservation_countdown === true && ['shopping', 'held'].includes(shopping.reservation?.state) && <p className="rounded-md border bg-muted/40 p-3 text-sm">
        {(() => {
          const label = field.reservation_label?.trim() || 'Your items are reserved for {time}';
          const time = formatReservationTime(shopping.reservation, clock);
          return label.includes('{time}') ? label.replaceAll('{time}', time) : `${label} ${time}`;
        })()}
      </p>}
    {cartCommitted && <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">This order has been confirmed. Its items cannot be changed here.</p>}
    {cartLocked && !cartCommitted && <div className="rounded-md border bg-muted/40 p-3 text-sm">
      <p role="status">{recovery.data?.busy ? 'Cancelling unfinished payment… Please wait.' : 'Your cart is reserved for payment. Choose Previous to return and make changes.'}</p>
      {recovery.data?.error && <p role="alert">{recovery.data.error}</p>}
    </div>}
    {unavailable && <p role="alert" className="text-sm text-destructive">A cart item is no longer available. Your cart and other answers have been kept. Review quantities before retrying.</p>}
    {!formId ? <p className="text-sm text-muted-foreground">Save the form to preview cart options.</p>
      : query.isFetching || query.isPending ? <div role="status" className="animate-pulse rounded-md bg-muted p-3 text-sm">Loading cart options…</div>
      : query.isError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>Cart options are unavailable. Your selections have been kept.</p><Button type="button" variant="outline" size="sm" onClick={() => query.refetch()}>Retry cart options</Button></div>
      : !viewOnly && items.length === 0 ? <p className="rounded-md border bg-muted/40 p-3 text-sm">No items are currently offered on this form.</p> : null}
    {!viewOnly && field.show_bundle_category === true && bundles.length > 0 && <label className="block text-sm">{categoryLabel}
      <select aria-label={categoryLabel} className="mt-1 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
        disabled={readonly} value={category} onChange={event => {
          setCategory(event.target.value);
          if (event.target.value && pickedBundle && categoryKey(pickedBundle) !== event.target.value) setBundleId('');
        }}>
        <option value="">All categories</option>
        {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
    </label>}
    {!viewOnly && !query.isPending && !query.isError && bundles.length > 0 && visibleBundles.length === 0 && <p role="status" className="text-sm">No bundles match this category.</p>}
    {!viewOnly && dropdown && !query.isPending && !query.isError && <div className="space-y-2">
      <label className="block text-sm">{bundleLabel}{field.bundle_required === true ? ' (required)' : ''}
        <select aria-label={bundleLabel} className="mt-1 h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
          disabled={readonly} value={bundleId} onChange={event => {
            setBundleId(event.target.value);
            setBundleQuantity('1');
          }}>
          <option value="">Choose a bundle…</option>
          {visibleBundles.map(item => <option key={item.id} value={item.id} disabled={!item.available}>
            {item.name} — {money(item.unitPriceMinor, item.currency)}{!item.available ? ' — Sold out / unavailable' : ''}
          </option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        {maximum(pickedBundle) !== 1 && <label className="text-sm">Quantity<Input aria-label="Bundle quantity" className="w-24" type="number" min="1"
          max={pickedBundle ? Math.max(0, limit(pickedBundle) - committedQuantity(pickedBundle)) : 1000} step="1" value={bundleQuantity}
          disabled={readonly || !pickedBundle?.available} aria-invalid={!!bundleId && !canAdd}
          onChange={event => setBundleQuantity(event.target.value)} /></label>}
        <Button type="button" disabled={readonly || !canAdd} onClick={() => add(pickedBundle, draftQuantity)}>
          <ShoppingCart aria-hidden="true" className="mr-2 h-4 w-4" />Add to cart
        </Button>
      </div>
    </div>}
    {!viewOnly && !query.isPending && !query.isError && catalogueItems.map(item => {
      const key = `${item.kind}:${item.id}`;
      const quantity = maximum(item) === 1 ? 1 : Number(draftQuantities[key] ?? '1');
      const canAddItem = canAddQuantity(item, quantity);
      return <Fragment key={`${item.kind}:${item.id}`}>
        {item === firstProduct && productsHeading && <h3 className="pt-3 text-sm font-medium">{productsHeading}</h3>}
        <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-medium">{item.name}</p>{item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}</div><p className="text-sm font-medium">{money(item.unitPriceMinor, item.currency)} each</p></div>
        <p className="text-xs text-muted-foreground">{item.taxTreatment === 'standard' ? `Plus ${item.taxRateBps / 100}% tax` : item.taxTreatment?.replaceAll('_', ' ')} · {!item.available ? 'Unavailable' : item.remaining === null ? 'Unlimited availability' : `${item.remaining} available`}</p>
        <div className="flex flex-wrap items-end gap-2">{maximum(item) !== 1 && <label className="text-sm" htmlFor={`cart-draft-${field.id}-${item.kind}-${item.id}`}>Quantity
          <Input id={`cart-draft-${field.id}-${item.kind}-${item.id}`} className="w-24" type="number" min="1"
            max={Math.max(0, limit(item) - committedQuantity(item))} step="1" value={draftQuantities[key] ?? '1'}
            disabled={readonly || !item.available} aria-invalid={!canAddItem}
            onChange={event => setDraftQuantities(previous => ({ ...previous, [key]: event.target.value }))} />
        </label>}<Button type="button" disabled={readonly || !canAddItem} onClick={() => add(item, quantity)}>
          <ShoppingCart aria-hidden="true" className="mr-2 h-4 w-4" />Add to cart
        </Button></div>
      </div></Fragment>;
    })}
    {contentsVisible && query.isSuccess && !query.isFetching && <section aria-label="Cart contents" className="space-y-3">
      <p className="text-sm font-medium">Cart contents</p>
      {answer.lines.length === 0 && <p className="rounded-md border bg-muted/40 p-3 text-sm">Your cart is empty. Add an item to get started.</p>}
      {pricedLines.map(({ item, ...line }, index) => item
        ? <div key={`${line.kind}:${line.id}:${index}`} className="space-y-2 rounded-md border bg-background p-3">
          <div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-medium">{item.name}</p><p className="text-sm">{money(item.unitPriceMinor * line.quantity, item.currency)}</p></div>
          <div className="flex flex-wrap items-end gap-2">
            {maximum(item) !== 1 ? <label className="text-sm" htmlFor={`cart-${field.id}-${item.kind}-${item.id}`}>Quantity
              <Input id={`cart-${field.id}-${item.kind}-${item.id}`} aria-label={`Cart quantity for ${item.name}`} className="w-24" type="number" min="1" max={limit(item)} step="1" value={line.quantity}
                disabled={readonly || !item.available} aria-invalid={line.quantity > limit(item)}
                onChange={event => changeQuantity(item.kind, item.id, Number(event.target.value))} /></label>
              : <div className="text-sm">Quantity<div className="flex h-10 w-24 items-center">{line.quantity}</div></div>}
            <Button type="button" variant="ghost" disabled={readonly} onClick={() => changeQuantity(item.kind, item.id, 0)}>Remove</Button>
          </div>
        </div>
        : <div key={`${line.kind}:${line.id}:${index}`} className="rounded-md border border-amber-200 p-3 text-sm"><p className="text-amber-700">Saved {line.kind || 'item'} unavailable · quantity {line.quantity}</p><Button type="button" variant="ghost" size="sm" disabled={readonly} onClick={() => changeQuantity(line.kind, line.id, 0)}>Remove saved item</Button></div>)}
      {totalsAvailable ? <dl className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
        <div className="flex justify-between gap-3"><dt>Subtotal</dt><dd>{money(totals.netMinor, currency)}</dd></div>
        <div className="flex justify-between gap-3"><dt>Tax</dt><dd>{money(totals.taxMinor, currency)}</dd></div>
        <div className="flex justify-between gap-3 border-t pt-2 font-medium"><dt>Total</dt><dd>{money(totals.grossMinor, currency)}</dd></div>
      </dl> : <p className="text-xs text-muted-foreground">Totals are unavailable until all cart items can be checked.</p>}
    </section>}
    {invalidAnswer && <div role="alert" className="text-sm text-destructive"><p>This saved cart cannot be read. It has not been changed automatically.</p><Button type="button" variant="outline" size="sm" disabled={readonly} onClick={() => {
      if (readonly) return;
      const empty = { version: 1, lines: [] };
      if (query.data?.reservationReady) shopping.update(empty).catch(error => setReservationError(error.message));
      else callbacks.current.onChange(empty);
    }}>Clear unreadable cart</Button></div>}
    {missingBundle && !query.isFetching && <p role="alert" className="text-sm text-destructive">Add at least one bundle to continue.</p>}
    {!valid && !missingBundle && answer.lines.length > 0 && query.isSuccess && !query.isFetching && !cartLocked && <p role="alert" className="text-sm text-destructive">Review unavailable items and quantities before checkout.</p>}
    <p className="text-xs text-muted-foreground">{query.data?.reservationReady
      ? 'Adding an item reserves stock for the time set on this form. The Payment total includes tax and is confirmed before checkout. Return from checkout to change your cart.'
      : 'Nothing is added automatically. The Payment total includes tax and is confirmed before checkout. Cart selections cannot be edited after checkout starts.'}</p>
  </div>;
}
