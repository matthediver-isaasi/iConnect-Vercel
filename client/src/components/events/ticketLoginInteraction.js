export function canLoginForTicket({
  purchasable, authenticated, released, soldOut, registrationClosed, eventSoldOut,
}) {
  return !purchasable && !authenticated && released && !soldOut
    && !registrationClosed && !eventSoldOut;
}

export function ticketLoginInteraction(enabled, onLogin, name = 'Ticket') {
  if (!enabled) return {};
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': `${name}: Member only - click to login`,
    onClick: onLogin,
    onKeyDown(event) {
      if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      onLogin(event);
    },
  };
}