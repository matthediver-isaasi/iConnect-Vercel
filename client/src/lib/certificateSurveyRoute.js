export function isSurveyAssignmentPath(pathname) {
  return /^\/survey\/[^/]+\/?$/i.test(pathname);
}

// The head normally captures this before analytics. Also support SPA navigation
// and templates predating that bootstrap. The server alone authorizes the grant.
export function readCertificateSurveyGrant(browser = window) {
  const { location, history } = browser;
  if (!isSurveyAssignmentPath(location.pathname)) return null;
  const key = `certificate-survey:${location.pathname}`;
  if (location.hash.startsWith('#certificate_grant=')) {
    const supplied = location.hash.slice('#certificate_grant='.length);
    const token = /^[A-Za-z0-9_-]{43}$/.test(supplied) ? supplied : 'invalid';
    history.replaceState(history.state, '', location.pathname + location.search);
    try {
      browser.sessionStorage.removeItem(key);
      browser.sessionStorage.removeItem(`certificate-survey-completed:${location.pathname}`);
      browser.sessionStorage.removeItem(`certificate-survey-expired:${location.pathname}`);
      browser.sessionStorage.setItem(key, token);
    } catch { /* The current mount can still use the capability. */ }
    // Malformed supplied credentials must reach the API's denial, not silently
    // turn an invitation into an ordinary (potentially public) assignment.
    return token || 'invalid';
  }
  try { return browser.sessionStorage.getItem(key) || null; } catch { return null; }
}

// Call only with redirectTo returned by the same-origin tenant-redirect API.
// Never accept a URL/query-provided redirect destination for a bearer transfer.
export function canonicalSurveyRedirect(approvedDomain, browser = window) {
  if (typeof approvedDomain !== 'string'
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(approvedDomain)) return null;
  const base = `https://${approvedDomain.toLowerCase()}${browser.location.pathname}${browser.location.search}`;
  const grant = readCertificateSurveyGrant(browser);
  return { canonical: base, destination: grant ? `${base}#certificate_grant=${encodeURIComponent(grant)}` : base };
}