function displayDate(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function membershipTermLabel(value) {
  const match = String(value || '').match(/^rolling:(\d{4}-\d{2}-\d{2})$/);
  return match ? `From ${displayDate(match[1])}` : value;
}

export default function MembershipCommitmentNotice({ startDate, renewalDate }) {
  if (!startDate || !renewalDate) return null;
  return (
    <p className="rounded-md border bg-muted/50 p-3 text-sm" data-testid="membership-agreed-term">
      By paying, you agree to a membership starting <strong>{displayDate(startDate)}</strong>,
      with renewal due <strong>{displayDate(renewalDate)}</strong>. These dates and the agreed
      price remain fixed for this term. Membership activation follows the agreed payment
      terms and cannot precede the start date.
    </p>
  );
}