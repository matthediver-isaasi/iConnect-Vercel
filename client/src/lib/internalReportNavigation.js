export function internalReportDestination(value, origin) {
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin) return null;
    const match = parsed.pathname.match(/^\/internal-reports\/([a-f0-9-]{36})\/([a-z0-9_-]{1,128})\/?$/i);
    return match ? `${match[1].toLowerCase()}:${match[2]}` : null;
  } catch { return null; }
}
export function canDiscoverInternalReport(item, { ready, allowed, origin }) {
  let path;
  try { path = new URL(item?.url || '', origin).pathname; } catch { return true; }
  if (!/^\/internal-reports(?:\/|$)/i.test(path)) return true;
  const key = internalReportDestination(item?.url, origin);
  return Boolean(!item?.isExternal && ready && key && allowed.has(key));
}
