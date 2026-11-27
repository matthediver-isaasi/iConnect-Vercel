import React, { useState } from 'react';
import UnifiedBookingCustomer from './UnifiedBookingCustomer';
import { INVOICING_ADDRESS_KEYS } from '../../../../shared/invoicingAddress.js';

const REQUIRED = ['invoicing_address_line1', 'invoicing_city', 'invoicing_postal_code', 'invoicing_country'];
const ORDER = INVOICING_ADDRESS_KEYS;

/** Saved billing details on one line, with the full form behind "Change". */
export default function EventFunnelBilling({ summary, value, onChange, disabled }) {
  const address = value?.address || {};
  const complete = REQUIRED.every(key => String(address[key] || '').trim());
  const [editing, setEditing] = useState(!complete);
  const required = summary.totalMinor > 0;
  const choice = summary.customers.find(item => item.kind === value?.kind && item.id === value?.id);
  const line = ORDER.map(key => String(address[key] || '').trim()).filter(Boolean).join(', ');

  if (editing || (required && !complete)) {
    return <div className="space-y-2">
      <UnifiedBookingCustomer choices={summary.customers} value={value} onChange={onChange}
        guest={!summary.memberFunding} required={required} />
      {complete && <button type="button" className="event-funnel-cart__remove" disabled={disabled}
        onClick={() => setEditing(false)}>Done</button>}
    </div>;
  }
  return <section aria-label="Billing details" className="event-funnel-checkout__panel">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h4>Billing details</h4>
        <p className="text-sm font-medium">{choice?.name || 'You'}{choice?.kind === 'organization' ? ' (organisation)'
          : choice?.kind === 'organization_group' ? ' (group / trust)' : ''}</p>
        <p className="event-funnel-checkout__muted break-words">{line || 'No billing address saved'}</p>
      </div>
      <button type="button" className="event-funnel-cart__remove shrink-0" disabled={disabled}
        onClick={() => setEditing(true)} data-testid="event-funnel-billing-change">Change</button>
    </div>
  </section>;
}
