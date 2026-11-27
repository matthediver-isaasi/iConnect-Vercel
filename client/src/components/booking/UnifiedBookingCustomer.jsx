import React from 'react';
import { INVOICING_ADDRESS_FIELDS } from '../../../../shared/invoicingAddress.js';
import { invoiceAddressDraft } from '../../lib/eventInvoiceAddress.mjs';

export default function UnifiedBookingCustomer({ choices = [], value, onChange, guest = false, required = false }) {
  const selected = choices.find(choice => choice.kind === value?.kind && choice.id === value?.id) || choices[0];
  return <section aria-label="Billing details" className="rounded-md border p-4 space-y-3">
    <h3 className="text-sm font-semibold">Billing details</h3>
    <p className="text-xs text-muted-foreground">{guest
      ? 'Your invoice is made out to you. Organisation details are optional reference information and do not create an account or relationship.'
      : 'Choose who is billed, whether you pay by card or Invoice / PO. This does not change your membership or saved address.'}</p>
    {!guest && <label className="block text-sm">Bill to
      <select className="mt-1 w-full rounded-md border p-2" value={selected ? `${selected.kind}:${selected.id}` : ''}
        onChange={event => {
          const choice = choices.find(choice => `${choice.kind}:${choice.id}` === event.target.value);
          if (choice) onChange({ kind: choice.kind, id: choice.id, address: invoiceAddressDraft(choice.invoicingAddress) });
        }}>
        {choices.map(choice => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>
          {choice.name}{choice.kind === 'member' ? ' (myself)' : choice.kind === 'organization_group' ? ' (group / trust)' : ' (organisation)'}
        </option>)}
      </select>
    </label>}
    {INVOICING_ADDRESS_FIELDS.map(({ key, label, maxLength }) => <label key={key} htmlFor={`unified-${key}`} className="block text-sm">{label}
      <input id={`unified-${key}`} className="mt-1 block w-full rounded-md border p-2" value={value?.address?.[key] || ''}
        maxLength={maxLength} required={required && ['invoicing_address_line1','invoicing_city','invoicing_postal_code','invoicing_country'].includes(key)}
        onChange={event => onChange({ kind: guest ? 'guest' : selected?.kind || 'member', ...(selected ? { id: selected.id } : {}),
          ...value, address: { ...value?.address, [key]: event.target.value } })} />
    </label>)}
  </section>;
}
