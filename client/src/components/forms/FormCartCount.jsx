import { ShoppingCart, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cartPendingKey } from '@/lib/formCartPending';
import { normalizeCartAnswer } from '../../../../shared/formCart.js';

export default function FormCartCount({ form, values }) {
  const cart = form?.fields?.find(field => field.type === 'sales_cart');
  if (!cart) return null;
  return <CartCount form={form} cart={cart} values={values} />;
}

function CartCount({ form, cart, values }) {
  const pending = useQuery({ queryKey: cartPendingKey(form.id), queryFn: () => false, enabled: false });
  const busy = pending.data === true;
  let count;
  try {
    count = normalizeCartAnswer(values?.[cart.id]).lines.reduce((total, line) => total + line.quantity, 0);
  } catch { count = null; }
  const countLabel = count === null ? 'Cart needs attention' : `${count} ${count === 1 ? 'item' : 'items'} in cart`;
  const label = busy ? `Updating cart. ${countLabel}` : countLabel;
  return <span role="status" aria-live="polite" aria-atomic="true" aria-label={label}
    title={label} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-sm font-medium tabular-nums">
    {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      : <ShoppingCart aria-hidden="true" className="h-4 w-4" />}
    <span aria-hidden="true">{count ?? '!'}</span>
  </span>;
}
