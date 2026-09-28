// Display-only decoration, applied before either renderer measures the text.
export function certificateDisplayValue(key, value) {
  if (key !== 'cpd.cpd_points' || value == null || !String(value).trim()) return value;
  const text = String(value);
  if (/\s+points\s*$/i.test(text)) return text;
  return `${text} points`;
}