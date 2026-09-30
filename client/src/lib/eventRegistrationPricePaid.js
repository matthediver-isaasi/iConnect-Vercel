export function formatRegistrationPricePaid(attendee) {
  const status = attendee?.price_paid_status;
  const amount = attendee?.price_paid;
  const hasAmount = amount !== null && amount !== undefined && Number.isFinite(Number(amount));
  const formattedAmount = hasAmount ? `£${Number(amount).toFixed(2)}` : null;

  if (status === 'pending') {
    return formattedAmount ? `Pending/unpaid — ${formattedAmount}` : 'Pending/unpaid';
  }
  if (status === 'net' && formattedAmount) {
    return formattedAmount;
  }
  return 'Unavailable';
}