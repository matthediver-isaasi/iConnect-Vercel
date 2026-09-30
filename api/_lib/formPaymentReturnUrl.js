const RETURN_PATH_MAX_LENGTH = 8192;

/** A caller may choose a path on the resolved tenant, never another origin. */
export function sanitizeFormPaymentReturnPath(value, trustedBase) {
  if (typeof value !== 'string' || value.length > RETURN_PATH_MAX_LENGTH
      || !value.startsWith('/') || value.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(value)
      || /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i.test(value)) return '/';
  try {
    const base = new URL(trustedBase);
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(base.protocol)
        || url.origin !== base.origin || url.username || url.password) return '/';
    // Keep navigation paths and query scope, not provider fragments.
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

export function buildFormPaymentReturnUrl(trustedBase, returnPath, entries) {
  const base = new URL(trustedBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('A trusted tenant HTTP origin is required for payment returns');
  }
  const url = new URL(sanitizeFormPaymentReturnPath(returnPath, base.href), base);
  for (const [key, value] of entries) url.searchParams.set(key, value);
  if (url.origin !== base.origin) throw new Error('Payment return must stay on the tenant origin');
  return url.toString();
}