// Conservative: unknown serialized designs retain the existing fetch path.
export function canvasNeedsSymbols(design) {
  if (typeof design === 'string') {
    try { return canvasNeedsSymbols(JSON.parse(design)); } catch { return true; }
  }
  if (!design || typeof design !== 'object') return false;
  if (design.type === 'symbol') return true;
  return Object.entries(design).some(([key, value]) =>
    (/symbol/i.test(key) && !!value)
    || (value && typeof value === 'object' && canvasNeedsSymbols(value)));
}
