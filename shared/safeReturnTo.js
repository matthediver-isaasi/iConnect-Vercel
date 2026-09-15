// OAuth returnTo values must stay on the current application origin. This
// helper is shared by server callbacks and client login links so a signed
// state value cannot turn into an open redirect or a script sink.

export function normalizeInternalReturnTo(value, fallback = '/') {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  if (
    !candidate
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f\u2028\u2029]/.test(candidate)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(candidate)
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, 'https://internal.invalid');
    if (parsed.origin !== 'https://internal.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export function appendInternalQuery(path, key, value) {
  const safePath = normalizeInternalReturnTo(path, '/');
  const hashIndex = safePath.indexOf('#');
  const beforeHash = hashIndex === -1 ? safePath : safePath.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : safePath.slice(hashIndex);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}
