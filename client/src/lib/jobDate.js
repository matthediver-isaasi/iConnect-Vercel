export function parseJobClosingDate(value) {
  if (!value) return null;
  const datePart = String(value).split('T')[0];
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) {
    const fallback = new Date(value);
    return isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

export function startOfLocalToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
