import { ShoppingCart, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cartPendingKey } from '@/lib/formCartPending';
import { cartViewTarget, openCartView } from '@/lib/formCartNavigation';
import { normalizeCartAnswer } from '../../../../shared/formCart.js';

export default function FormCartCount({ form, values, navigation }) {
  const cart = form?.fields?.find(field => field.type === 'sales_cart');
  if (!cart) return null;
  return <CartCount form={form} cart={cart} values={values} navigation={navigation} />;
}

function CartCount({ form, cart, values, navigation }) {
  const pending = useQuery({ queryKey: cartPendingKey(form.id), queryFn: () => false, enabled: false });
  const lock = useQuery({ queryKey: ['form-cart-locked', form.id], queryFn: () => false, enabled: false });
  const recovery = useQuery({ queryKey: ['form-cart-recovery', form.id], queryFn: () => null, enabled: false });
  const busy = pending.data === true;
  let count;
  try {
    count = normalizeCartAnswer(values?.[cart.id]).lines.reduce((total, line) => total + line.quantity, 0);
  } catch { count = null; }
  const countLabel = count === null ? 'Cart needs attention' : `${count} ${count === 1 ? 'item' : 'items'} in cart`;
  const label = busy ? `Updating cart. ${countLabel}` : countLabel;
  const target = navigation && cartViewTarget({ ...navigation, allPages: form.pages || [] });
  const Tag = target ? 'button' : 'span';
  return <Tag type={target ? 'button' : undefined} role={target ? undefined : 'status'}
    aria-live="polite" aria-atomic="true" aria-label={target ? `View cart. ${label}` : label}
    disabled={target ? busy || lock.data === true || recovery.data?.busy === true : undefined}
    onClick={target ? event => openCartView(navigation, target, event.currentTarget.closest('[data-form-cart-shell]')) : undefined}
    title={target ? `View cart — ${label}` : label} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-sm font-medium tabular-nums enabled:hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
    {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      : <ShoppingCart aria-hidden="true" className="h-4 w-4" />}
    <span aria-hidden="true">{count ?? '!'}</span>
  </Tag>;
}
