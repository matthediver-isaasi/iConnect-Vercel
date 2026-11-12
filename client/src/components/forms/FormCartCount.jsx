import { ShoppingCart } from 'lucide-react';
import { normalizeCartAnswer } from '../../../../shared/formCart.js';

export default function FormCartCount({ form, values }) {
  const cart = form?.fields?.find(field => field.type === 'sales_cart');
  if (!cart) return null;
  let count;
  try {
    count = normalizeCartAnswer(values?.[cart.id]).lines.reduce((total, line) => total + line.quantity, 0);
  } catch { count = null; }
  const label = count === null ? 'Cart needs attention' : `${count} ${count === 1 ? 'item' : 'items'} in cart`;
  return <span role="status" aria-live="polite" aria-atomic="true" aria-label={label}
    title={label} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-muted/40 px-3 py-1 text-sm font-medium tabular-nums">
    <ShoppingCart aria-hidden="true" className="h-4 w-4" />
    <span aria-hidden="true">{count ?? '!'}</span>
  </span>;
}
