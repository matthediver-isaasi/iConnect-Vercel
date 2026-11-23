import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useBookingVouchers } from './useBookingVouchers';
import { voucherDisplayName, voucherOwnerType } from '../../../../shared/voucherPolicy.js';
import { isMembershipChangeVoucher, VoucherExpiry } from '@/components/vouchers/VoucherPresentation';

// Reuse the existing ownership-filtered voucher resource, but do not reuse the
// single-event picker's simulated allocations. Only the aggregate quote can
// determine which credit applies to each held event.
function CheckoutVouchers({ summary, session, selected, onChange }) {
  const member = summary.customers.find(choice => choice.kind === 'member');
  const organizations = summary.customers.filter(choice => choice.kind === 'organization');
  const [organizationId, setOrganizationId] = useState(() => organizations.length === 1 ? organizations[0].id : '');
  // Billing linkage is not spending authority. Let members inspect real owned
  // credit; the server quote verifies their current organisation and role.
  const organization = organizations.find(choice => choice.id === organizationId) || null;
  const query = useBookingVouchers(
    member ? { id: member.id, tenant_id: session.tenant_id } : null, organization, true,
  );
  const vouchers = (query.data || []).filter(voucher => !isMembershipChangeVoucher(voucher));
  return <section aria-label="Available vouchers">
    <h4>Vouchers</h4>
    <p className="event-funnel-checkout__muted">Select available credit to check against all your events. Your membership and voucher eligibility are verified in the final quote.</p>
    {organizations.length > 1 && <label className="event-funnel-checkout__label mt-3">Voucher list
      <select value={organizationId} onChange={event => {
        onChange([]);
        setOrganizationId(event.target.value);
      }}>
        <option value="">Personal vouchers</option>
        {organizations.map(choice => <option key={choice.id} value={choice.id}>Personal and {choice.name} vouchers</option>)}
      </select>
    </label>}
    {query.isLoading ? <div className="event-reservation-loading" role="status">
      <span aria-hidden="true" /><span aria-hidden="true" /><p>Loading available vouchers…</p>
    </div> : query.error ? <div className="event-funnel-checkout__notice" role="alert">
    <p>Vouchers could not be checked. No new voucher credit has been applied.</p>
    <Button type="button" variant="outline" onClick={() => query.refetch()}>Retry vouchers</Button>
    {selected.length > 0 && <Button type="button" variant="ghost" onClick={() => onChange([])}>Clear selected vouchers</Button>}
    </div> : <>
    {vouchers.length === 0 && <p className="event-funnel-checkout__muted">No available event vouchers were found.</p>}
    {vouchers.map(voucher => <label key={voucher.id} className="event-funnel-checkout__choice">
      <input type="checkbox" checked={selected.includes(voucher.id)} onChange={event => onChange(
        event.target.checked ? [...selected, voucher.id] : selected.filter(id => id !== voucher.id),
      )} />
      <span><strong>{voucher.code || voucherDisplayName(query.settings, voucherOwnerType(voucher))}</strong>
        <span className="block text-xs text-muted-foreground">{voucherDisplayName(query.settings, voucherOwnerType(voucher))} · <VoucherExpiry voucher={voucher} /></span>
      </span>
    </label>)}
    {selected.some(id => !vouchers.some(voucher => voucher.id === id)) && <div role="alert">
      <p>A selected voucher is no longer in the available list. Clear it before requesting a new quote.</p>
      <Button type="button" variant="outline" onClick={() => onChange(selected.filter(id => vouchers.some(voucher => voucher.id === id)))}>Remove unavailable vouchers</Button>
    </div>}</>}
  </section>;
}

export default function EventFunnelCheckoutFunding({ summary, session, value, onChange, money }) {
  if (!summary.memberFunding) return null;
  return <section className="event-funnel-checkout__panel" aria-label="Member funding">
    <h4>Member funding</h4>
    {summary.trainingFund?.enabled && <label className="event-funnel-checkout__label">
      Training fund amount ({summary.currency.toUpperCase()})
      <input type="text" inputMode="decimal" value={value.training} onChange={event => onChange({ training: event.target.value })}
        aria-describedby="funnel-training-availability" placeholder="0.00" />
      <span id="funnel-training-availability" className="event-funnel-checkout__muted">
        Available: {money(summary.trainingFund.availableMinor)}. Enter an amount with up to two decimal places.
      </span>
    </label>}
    {!summary.trainingFund?.enabled && <p className="event-funnel-checkout__muted">Training funds are not available for this reservation.</p>}
    <CheckoutVouchers summary={summary} session={session} selected={value.voucherIds} onChange={voucherIds => onChange({ voucherIds })} />
  </section>;
}
