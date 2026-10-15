// Presentation only: never pass the result back into API requests or date logic.
export function formatMembershipMessageDates(message) {
  if (typeof message !== 'string') return message;
  return message.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (value, year, month, day) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
    return `${day}/${month}/${year}`;
  });
}
