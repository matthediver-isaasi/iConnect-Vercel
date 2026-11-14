import { useQuery } from '@tanstack/react-query';
import { roundAdminRequest } from './useRoundAdministration';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const snapshotAdoptionKey = (tenant, roundId, applicationId) => ['award-snapshot-adoption', tenant.scopeKey, roundId, applicationId];
export const adoptionVersions = assignments => Object.fromEntries([...assignments].sort((a, b) => a.id.localeCompare(b.id)).map(row => [row.id, row.version]));

async function loadEvidence(tenant, roundId, applicationId, signal) {
  const versions = [], assignments = [], seenVersions = new Set(), seenRevisions = new Set(), seenAssignments = new Set();
  let versionTotal, assignmentTotal, pageSize, application;
  for (let page = 1; page <= 10000; page += 1) {
    const result = await roundAdminRequest(tenant, `/api/awards/snapshot-adoption?roundId=${encodeURIComponent(roundId)}&applicationId=${encodeURIComponent(applicationId)}&page=${page}`, { signal });
    if (result.application?.id !== applicationId || typeof result.application.reference !== 'string'
      || !Array.isArray(result.versions) || !Array.isArray(result.assignments) || result.page !== page
      || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1
      || !Number.isSafeInteger(result.versionTotal) || result.versionTotal < 0
      || !Number.isSafeInteger(result.assignmentTotal) || result.assignmentTotal < 0) {
      throw new Error('Evidence metadata is incomplete. No partial version list or assignment map can be confirmed.');
    }
    if (page > 1 && (result.versionTotal !== versionTotal || result.assignmentTotal !== assignmentTotal || result.pageSize !== pageSize || result.application.reference !== application.reference)) {
      throw new Error('Evidence or assignment totals changed while paging. Reload the complete evidence catalog.');
    }
    ({ versionTotal, assignmentTotal, pageSize, application } = result);
    for (const [rows, total] of [[result.versions, versionTotal], [result.assignments, assignmentTotal]]) {
      if (rows.length !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) {
        throw new Error('An evidence metadata page is missing rows. Partial data cannot be used for adoption.');
      }
    }
    for (const row of result.versions) {
      if (!uuid(row.id) || seenVersions.has(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1
        || seenRevisions.has(row.revision) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) {
        throw new Error('Duplicate or invalid evidence versions were returned. Reload before reviewing adoption.');
      }
      seenVersions.add(row.id); seenRevisions.add(row.revision); versions.push(row);
    }
    for (const row of result.assignments) {
      if (!uuid(row.id) || seenAssignments.has(row.id) || !Number.isSafeInteger(row.version) || row.version < 1
        || typeof row.state !== 'string' || !row.state || (row.application_version_id != null && !uuid(row.application_version_id))) {
        throw new Error('Duplicate or invalid assignments were returned. An exact assignment version map is required.');
      }
      seenAssignments.add(row.id); assignments.push(row);
    }
    if (versions.length === versionTotal && assignments.length === assignmentTotal) {
      if (assignments.some(row => row.application_version_id != null && !seenVersions.has(row.application_version_id))) {
        throw new Error('An assignment references evidence missing from the complete version catalog. Reconcile this record before adoption.');
      }
      tenant.assertCurrent();
      return { application, versions, assignments };
    }
  }
  throw new Error('The complete evidence catalog exceeds the page limit. No partial data is available for confirmation.');
}

export function useSnapshotAdoption(tenant, roundId, applicationId, enabled) {
  return useQuery({
    queryKey: snapshotAdoptionKey(tenant, roundId, applicationId),
    queryFn: ({ signal }) => loadEvidence(tenant, roundId, applicationId, signal),
    enabled: enabled && !!applicationId,
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
