import React, { useMemo, useState } from 'react';
import { CornerDownRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { funnelCartRows, previewFunnelRemoval } from '@/lib/eventFunnelCart.mjs';

/**
 * Shopping-cart view of the held reservation. Removing an optional step is a
 * journey skip: the server re-plans the route, releasing any selection that
 * required it. The confirmation previews that outcome with the same planner.
 */
export default function EventFunnelCart({ snapshot, lines, money, canRemove, onRemove, discounts = [] }) {
  const savingFor = line => discounts.find(part => part.nodeId === line.nodeId && part.ticketId === line.ticketId)?.discountMinor || 0;
  const rows = useMemo(() => funnelCartRows(snapshot, lines), [snapshot, lines]);
  const [confirming, setConfirming] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState('');
  const stepName = nodeId => {
    const stepLines = lines.filter(line => line.nodeId === nodeId);
    return stepLines.map(line => line.ticketName || line.eventTitle).join(', ') || 'this selection';
  };
  const stepTotal = nodeId => lines.filter(line => line.nodeId === nodeId)
    .reduce((sum, line) => sum + (Number.isSafeInteger(line.amountMinor) ? line.amountMinor : 0), 0);

  function ask(nodeId) {
    setFailure('');
    setConfirming({ nodeId, preview: previewFunnelRemoval(snapshot, nodeId) });
  }
  async function remove() {
    if (!confirming || removing) return;
    setRemoving(true);
    setFailure('');
    try {
      const result = await onRemove(confirming.nodeId);
      if (result) setConfirming(null);
      else setFailure('That item could not be removed. Your reservation is unchanged.');
    } catch (cause) {
      setFailure(cause?.message || 'That item could not be removed. Your reservation is unchanged.');
    } finally {
      setRemoving(false);
    }
  }

  if (!rows.length) return <p className="event-funnel-checkout__notice">No ticket selections could be verified. Return to the event details in your reservation.</p>;
  const preview = confirming?.preview;
  return <section className="event-funnel-cart" aria-label="Your tickets">
    <table className="event-funnel-cart__table" data-testid="event-funnel-cart">
      <thead><tr>
        <th scope="col">Ticket</th><th scope="col">Attendee</th>
        <th scope="col" className="event-funnel-cart__num">Qty</th>
        <th scope="col" className="event-funnel-cart__num">Price</th>
        <th scope="col" className="event-funnel-cart__num">Total</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} data-kind={row.kind} data-depth={row.depth}
        data-testid={`event-funnel-cart-row-${row.key}`}>
        <td data-label="Ticket">
          <div className="event-funnel-cart__item" style={{ paddingInlineStart: `${row.depth * 1.25}rem` }}>
            {row.depth > 0 && <CornerDownRight size={14} aria-hidden="true" className="event-funnel-cart__nest" />}
            <div>
              <p className="event-funnel-cart__name">{row.line.ticketName}</p>
              <p className="event-funnel-cart__meta">{row.line.eventTitle}
                {row.kind === 'addon' && <span className="event-funnel-cart__tag">Add-on</span>}
                {row.kind === 'event' && <span className="event-funnel-cart__tag">Extra event</span>}</p>
              {row.requires.length > 0 && <p className="event-funnel-cart__meta">Requires {row.requires.join(', ')}</p>}
              {row.removable && canRemove && <button type="button" className="event-funnel-cart__remove"
                onClick={() => ask(row.nodeId)} disabled={removing} data-testid={`event-funnel-cart-remove-${row.nodeId}`}>
                Remove{row.stepLineCount > 1 ? ' these tickets' : ''}</button>}
            </div>
          </div>
        </td>
        <td data-label="Attendee">{row.attendees.length ? row.attendees.map((name, index) =>
          <span key={`${name}:${index}`} className="block">{name}</span>) : <span className="event-funnel-cart__meta">—</span>}</td>
        <td data-label="Qty" className="event-funnel-cart__num">{row.line.quantity}</td>
        <td data-label="Price" className="event-funnel-cart__num">{Number.isSafeInteger(row.line.unitMinor)
          ? row.line.unitMinor === 0 ? 'Free' : money(row.line.unitMinor) : '—'}</td>
        <td data-label="Total" className="event-funnel-cart__num event-funnel-cart__total">{!Number.isSafeInteger(row.line.amountMinor) ? '—'
          : savingFor(row.line) > 0 ? <span data-testid={`event-funnel-cart-discount-${row.key}`}>
            <s className="block text-xs font-normal text-slate-500">{money(row.line.amountMinor)}</s>
            {money(row.line.amountMinor - savingFor(row.line))}
            <span className="block text-xs font-normal text-green-700">Discount −{money(savingFor(row.line))}</span>
          </span>
          : row.line.amountMinor === 0 ? 'Free' : money(row.line.amountMinor)}</td>
      </tr>)}</tbody>
    </table>

    {confirming && <div className="event-funnel-checkout__notice event-funnel-cart__confirm" role="alertdialog"
      aria-labelledby="funnel-cart-remove-title" data-testid="event-funnel-cart-confirm">
      <h4 id="funnel-cart-remove-title">Remove {stepName(confirming.nodeId)}?</h4>
      {preview?.alsoRemoved?.length > 0 && <>
        <p>These items depend on it and will also be removed:</p>
        <ul className="list-disc pl-5">{preview.alsoRemoved.map(id => <li key={id}>
          {stepName(id)}{stepTotal(id) > 0 && <> ({money(stepTotal(id))})</>}</li>)}</ul>
      </>}
      {preview?.leavesCheckout && <p>You may be shown other options before returning to checkout.</p>}
      {!preview && <p>Anything that depends on this item will also be removed, and you may be shown other options before returning to checkout.</p>}
      {preview && !preview.alsoRemoved.length && !preview.leavesCheckout && <p>Nothing else in your basket depends on it.</p>}
      <p className="event-funnel-checkout__muted">Removed items release their places and cannot always be added back.</p>
      {failure && <p role="alert" className="text-red-700">{failure}</p>}
      <div className="event-funnel-checkout__actions mt-3">
        <Button type="button" variant="destructive" disabled={removing} onClick={remove}
          data-testid="event-funnel-cart-remove-confirm">{removing ? 'Removing…' : 'Remove'}</Button>
        <Button type="button" variant="outline" disabled={removing} onClick={() => setConfirming(null)}>Cancel</Button>
      </div>
    </div>}
  </section>;
}
