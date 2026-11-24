// The inventory is deliberately limited to existing automatic Sales deliveries.
export const SALES_AUTOMATIC_COMMUNICATIONS = [
  { id: 'agreement_sender', label: 'Signed agreement copy to sender',
    description: 'Sent to the internal signatory after both parties sign and the final PDF is retained.' },
  { id: 'agreement_customer', label: 'Signed agreement copy to customer',
    description: 'Sent to the customer signatory after both parties sign and the final PDF is retained.' },
  { id: 'invoice', label: 'Automatic invoice emails',
    description: 'Sent to the accepted billing recipient when a scheduled invoice is ready for delivery.' },
  { id: 'customer_fulfilment', label: 'Customer delegate registration email',
    description: 'Sent to the accepted customer after ticket allocations are created, with their delegate registration link.' },
];

export function validateSalesCommunicationPolicy(enabled, allowed) {
  if (typeof enabled !== 'boolean' || !Array.isArray(allowed)
    || allowed.length > SALES_AUTOMATIC_COMMUNICATIONS.length
    || new Set(allowed).size !== allowed.length
    || allowed.some(id => !SALES_AUTOMATIC_COMMUNICATIONS.some(item => item.id === id))) {
    throw new Error('Silent mode requires a boolean and a unique list of supported automatic communications');
  }
  return { silentMode: enabled, automaticCommunications: [...allowed].sort() };
}
