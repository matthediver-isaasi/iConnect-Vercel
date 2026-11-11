// Balance RPCs return decimal strings to avoid losing fractional points when a
// combined balance exceeds JavaScript's safe numeric precision.
export function formatCpdPoints(value, locale) {
  const text = String(value ?? '0');
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(text)) return '—';
  const [integer, decimal = ''] = text.split('.');
  const fraction = decimal.replace(/0+$/, '');
  const formatter = new Intl.NumberFormat(locale);
  const whole = formatter.format(BigInt(integer));
  const negativeZero = integer.startsWith('-') && BigInt(integer) === 0n;
  const minus = formatter.formatToParts(-1).find(p => p.type === 'minusSign')?.value || '-';
  const separator = formatter.formatToParts(1.1).find(p => p.type === 'decimal')?.value || '.';
  return `${negativeZero ? minus : ''}${whole}${fraction ? separator + fraction : ''}`;
}
