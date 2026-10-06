export function safeFaviconUrl(value) {
  if (typeof value !== 'string' || /[\\\s<>"]/.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//') &&
    !/^\/favicon\.ico(?:[?#]|$)/i.test(value)) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}
