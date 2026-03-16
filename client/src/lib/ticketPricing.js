// Returns effective price considering early bird deadlines
export function getEffectiveTicketPrice(ticketClass) {
  if (!ticketClass) {
    return { price: 0, isEarlyBird: false, earlyBirdDeadline: null };
  }

  const now = new Date();
  const standardPrice = Number(ticketClass.price) || 0;

  if (
    ticketClass.early_bird_enabled &&
    ticketClass.early_bird_price != null &&
    Number(ticketClass.early_bird_price) > 0 &&
    ticketClass.early_bird_deadline
  ) {
    const deadline = new Date(ticketClass.early_bird_deadline);
    if (deadline > now) {
      return {
        price: Number(ticketClass.early_bird_price),
        isEarlyBird: true,
        earlyBirdDeadline: deadline,
        standardPrice,
      };
    }
  }

  return { price: standardPrice, isEarlyBird: false, earlyBirdDeadline: null, standardPrice };
}
