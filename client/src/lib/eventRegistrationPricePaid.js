export function formatRegistrationPricePaid(attendee) {
  const status = attendee?.price_paid_status;
  if (status === 'proposal_pending') return 'Pending allocation';
  const amount = attendee?.price_paid;
  const hasAmount = amount !== null && amount !== undefined && Number.isFinite(Number(amount));
  const formattedAmount = hasAmount ? `£${Number(amount).toFixed(2)}` : null;

  if (status === 'pending') {
    return formattedAmount ? `Pending/unpaid — ${formattedAmount}` : 'Pending/unpaid';
  }
  if (['net', 'proposal_attributed'].includes(status) && formattedAmount) {
    return formattedAmount;
  }
  return 'Unavailable';
}