import { ticketReleaseMessage } from '../../../../shared/ticketRelease.js';

// Presentation only: callers retain the existing purchase and visibility gates.
export default function TicketRestrictionMessage({
  ticket, purchasable, released, soldOut, registrationClosed, eventSoldOut,
  authenticated, onLogin, suffix,
}) {
  if (purchasable) return null;
  if (!released) {
    return <p className="text-xs text-slate-600 mt-1" data-testid={`ticket-release-${suffix}`} role="status">{ticketReleaseMessage(ticket)}</p>;
  }
  const restricted = ticket.role_match_only && (
    (Array.isArray(ticket.role_ids) && ticket.role_ids.length > 0)
    || (Array.isArray(ticket.member_group_ids) && ticket.member_group_ids.length > 0)
  );
  let reason;
  let login = false;
  if (soldOut || eventSoldOut) reason = 'Sold out';
  else if (registrationClosed) reason = 'Registration is closed';
  else if (!authenticated) {
    reason = restricted ? 'Available only to eligible member roles or groups.' : 'Members only.';
    login = true;
  } else {
    reason = restricted ? 'Your membership is not eligible for this ticket.' : 'This ticket is not available to your account.';
  }
  return (
    <p className="text-xs text-slate-600 mt-1" data-testid={`ticket-disabled-${suffix}`}>
      {reason}{login && <> {' '}
        <button type="button" className="text-blue-600 hover:underline font-medium"
          data-testid={`link-login-ticket-${suffix}`} onClick={onLogin}>
          Log in to check eligibility
        </button>
      </>}
    </p>
  );
}