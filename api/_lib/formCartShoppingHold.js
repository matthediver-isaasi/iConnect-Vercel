import { normalizeCartAnswer, cartQuantityError } from '../../shared/formCart.js';
import { cancelCartPayment } from './formCartRecovery.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function shoppingHoldsReady(db) {
  const { data, error } = await db.rpc('form_cart_shopping_hold_version');
  if (error && ['42883', 'PGRST202'].includes(error.code)) return false;
  if (error) throw error;
  return data === 1;
}

export async function readShoppingHold(db, form, id) {
  if (!uuid.test(id || '')) throw new Error('Your cart reservation could not be identified. Return to the cart.');
  const { data, error } = await db.rpc('update_form_cart_hold', {
    p_tenant_id: form.tenant_id, p_form_id: form.id, p_id: id,
  });
  if (error) throw error;
  return data;
}

export function withOwnStock(items, hold) {
  if (!hold || !['shopping', 'held'].includes(hold.state)) return items;
  return items.map(item => {
    const quantity = hold.answer?.lines?.find(line => line.id === item.id && line.kind === item.kind)?.quantity || 0;
    return { ...item, remaining: item.remaining === null ? null : item.remaining + quantity,
      available: item.available || quantity > 0 };
  });
}

export async function updateShoppingHold(db, form, field, body, options, dependencies = {}) {
  if (!uuid.test(body.reservation_id || '')) throw new Error('Invalid cart reservation.');
  if (!await shoppingHoldsReady(db)) throw new Error('Cart reservations are not enabled yet. Please reload after the update.');
  let hold;
  if (body.action === 'reserve') {
    const answer = normalizeCartAnswer(body.answer);
    const error = cartQuantityError(field, answer);
    if (error) throw new Error(error);
    // Stock is checked atomically in the RPC. Here check eligibility, not
    // remaining availability, which excludes this customer's own reservation.
    if (answer.lines.some(line => !options.some(item => item.kind === line.kind && item.id === line.id))) {
      throw new Error('A selected item is no longer offered on this form.');
    }
    if (!Number.isSafeInteger(body.version) || body.version < 0) throw new Error('Invalid cart version.');
    const result = await db.rpc('update_form_cart_hold', {
      p_tenant_id: form.tenant_id, p_form_id: form.id, p_id: body.reservation_id,
      p_answer: answer, p_expected_version: body.version,
    });
    if (result.error) throw result.error;
    hold = result.data;
  } else if (body.action === 'reservation_status') {
    hold = await readShoppingHold(db, form, body.reservation_id);
    if (hold.state === 'held' && Date.parse(hold.expiresAt) <= Date.now()) {
      const link = await db.from('form_cart_hold').select('submission_id')
        .eq('tenant_id', form.tenant_id).eq('form_id', form.id).eq('id', body.reservation_id).single();
      if (link.error) throw link.error;
      const row = await db.from('form_submission').select('*')
        .eq('tenant_id', form.tenant_id).eq('form_id', form.id).eq('id', link.data.submission_id).single();
      if (row.error) throw row.error;
      // Stripe can be cancelled promptly; other providers stay held until the
      // existing provider-aware reconciliation confirms their terminal state.
      if (row.data.payment_provider === 'stripe' && row.data.payment_status !== 'paid') {
        try { await (dependencies.cancelPayment || cancelCartPayment)(db, row.data); }
        catch { /* Unknown/processing payment is NOT authority to release stock. */ }
        hold = await readShoppingHold(db, form, body.reservation_id);
      }
    }
  } else throw new Error('Unknown cart reservation action.');
  return hold;
}
