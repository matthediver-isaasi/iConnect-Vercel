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

export function getInternalReportMenuDestinations(reports = [], origin) {
  return reports.flatMap(report => {
    if (!report?.name || !report.object_id || !report.report_id) return [];
    const value = `/internal-reports/${encodeURIComponent(report.object_id)}/${encodeURIComponent(report.report_id)}`;
    const key = internalReportDestination(value, origin);
    return key ? [{
      value,
      label: `Internal report: ${report.name}${report.object_name ? ` · ${report.object_name}` : ''}`,
      featureId: `internal-report:${key}:view`,
    }] : [];
  });
}

// The server-filtered catalogue is the authority for report destinations.
// A stale Data Studio feature_id must neither hide an authorized report nor
// expose an unauthorized one. Ordinary menu items retain their existing gate.
export function canAccessReportAwareMenuItem(item, { isFeatureExcluded, ...reportAccess }) {
  if (!canDiscoverInternalReport(item, reportAccess)) return false;
  if (internalReportDestination(item?.url, reportAccess.origin)) return true;
  return !isFeatureExcluded(item?.featureId);
}
