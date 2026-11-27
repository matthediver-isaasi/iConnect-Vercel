import React, { useState } from 'react';
import { Ticket, Wallet } from 'lucide-react';
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
  // Nothing to choose: hide the card rather than showing an empty credit box.
  // Keep it while loading, on error, when a selection needs clearing, or when
  // another organisation's list could still be chosen.
  if (!query.isLoading && !query.error && vouchers.length === 0 && selected.length === 0
    && organizations.length <= 1) return null;
  return <section aria-label="Available vouchers" className="rounded-lg border border-slate-200 bg-blue-50 p-4">
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Ticket className="h-4 w-4 text-blue-600" aria-hidden="true" />
        <span className="text-sm font-medium">Available credit</span>
      </div>
      {vouchers.length > 0 && <span className="text-xs text-slate-500">{vouchers.length} voucher{vouchers.length !== 1 ? 's' : ''} available</span>}
    </div>
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
    {vouchers.length === 0 && <p className="text-xs text-slate-500">No eligible credit available</p>}
    {vouchers.length > 0 && <p className="text-xs text-slate-500">Selected credit is checked against all your events when you review your order.</p>}
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

export function EventFunnelTrainingFund({ summary, value, onChange, money }) {
  if (!summary.memberFunding || !summary.trainingFund?.enabled) return null;
  if (!(summary.trainingFund.availableMinor > 0) && !String(value.training || '').trim()) return null;
  return <section aria-label="Training fund" className="rounded-lg border border-slate-200 bg-green-50 p-4">
    <div className="mb-3 flex items-center justify-between gap-2">
      <label htmlFor="funnel-training-amount" className="flex items-center gap-2 text-sm font-medium">
        <Wallet className="h-4 w-4 text-green-600" aria-hidden="true" />Training Fund
      </label>
      <span className="text-xs text-slate-500" id="funnel-training-availability">Available: {money(summary.trainingFund.availableMinor)}</span>
    </div>
    <input id="funnel-training-amount" type="text" inputMode="decimal" value={value.training}
      onChange={event => onChange({ training: event.target.value })}
      aria-describedby="funnel-training-availability" placeholder={`Amount in ${summary.currency.toUpperCase()}`}
      className="w-full" />
  </section>;
}

export default function EventFunnelVouchers({ summary, session, value, onChange }) {
  if (!summary.memberFunding) return null;
  return <CheckoutVouchers summary={summary} session={session} selected={value.voucherIds} onChange={voucherIds => onChange({ voucherIds })} />;
}
