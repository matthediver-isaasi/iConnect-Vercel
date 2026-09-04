export function parseExpectedMemberExportTotal(method, rawValue) {
  if (method !== 'POST' || rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function memberExportCountError(expectedTotal, actualTotal) {
  if (expectedTotal === null || actualTotal === expectedTotal) return null;
  return actualTotal === 0 && expectedTotal > 0
    ? `Export found no members, but the selected list contains ${expectedTotal}. Refresh the list and try again.`
    : `Export found ${actualTotal} members, but the selected list contains ${expectedTotal}. Refresh the list and try again.`;
}

export function shouldRejectEmptyMemberExport(method, actualTotal) {
  return method === 'POST' && actualTotal === 0;
}