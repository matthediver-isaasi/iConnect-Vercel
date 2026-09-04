export function parseExpectedOrganisationExportTotal(method, rawValue) {
  if (method !== 'POST' || rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function organisationExportCountError(expectedTotal, actualTotal) {
  if (expectedTotal === null || actualTotal === expectedTotal) return null;
  return actualTotal === 0 && expectedTotal > 0
    ? `Export found no organisations, but the selected list contains ${expectedTotal}. Refresh the list and try again.`
    : `Export found ${actualTotal} organisations, but the selected list contains ${expectedTotal}. Refresh the list and try again.`;
}

export function shouldRejectEmptyOrganisationExport(method, actualTotal) {
  return method === 'POST' && actualTotal === 0;
}