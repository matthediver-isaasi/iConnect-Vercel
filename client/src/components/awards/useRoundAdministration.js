import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '@/lib/adminFetch';

export async function roundAdminRequest(tenant, url, { body, signal } = {}) {
  tenant.assertCurrent();
  const response = await adminFetch(url, {
    signal,
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
      body: JSON.stringify(body),
    }),
  }, tenant.tenantId);
  const result = await response.json();
  tenant.assertCurrent();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Unable to complete round administration.'), { status: response.status });
  return result;
}

async function allPages(tenant, path, resource, signal) {
  const rows = [], seen = new Set();
  let total;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await roundAdminRequest(tenant, `${path}&page=${page}`, { signal });
    if (!Array.isArray(result[resource]) || !Number.isSafeInteger(result.total) || result.total < 0
      || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1 || result.page !== page) {
      throw new Error(`The ${resource} list is incomplete. Retry loading the complete list.`);
    }
    if (total !== undefined && total !== result.total) throw new Error(`The ${resource} list changed while loading. Refresh and retry.`);
    total = result.total;
    for (const row of result[resource]) {
      if (!row.id || seen.has(row.id)) throw new Error(`The ${resource} list changed while loading. Refresh and retry.`);
      seen.add(row.id); rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || result[resource].length < result.pageSize) throw new Error(`The full ${resource} list could not be loaded. No partial list is being used.`);
  }
  throw new Error(`The ${resource} list exceeds this view’s page limit. No partial list is being used.`);
}

export const roundAppointmentsKey = (tenant, roundId) => ['award-round-appointments', tenant.scopeKey, roundId];
export const roundAssignmentsKey = (tenant, roundId) => ['award-round-assignment-controls', tenant.scopeKey, roundId];
export function useRoundAssignments(tenant, roundId, enabled) {
  return useQuery({
    queryKey: roundAssignmentsKey(tenant, roundId), enabled,
    queryFn: async ({ signal }) => {
      const assignments = await allPages(tenant, `/api/awards/assignment-controls?roundId=${encodeURIComponent(roundId)}`, 'assignments', signal);
      if (assignments.some(item => !item.appointment_id || !item.application_id || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.included !== 'boolean')) throw new Error('Assignment versions or ownership references could not be verified. Reload the complete list.');
      return assignments;
    },
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
export function useRoundAppointments(tenant, roundId, enabled) {
  return useQuery({
    queryKey: roundAppointmentsKey(tenant, roundId), enabled,
    queryFn: ({ signal }) => allPages(tenant, `/api/awards/appointments?roundId=${encodeURIComponent(roundId)}`, 'appointments', signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
export function useAllocationApplications(tenant, awardId) {
  return useQuery({
    queryKey: ['award-allocation-applications', tenant.scopeKey, awardId],
    queryFn: ({ signal }) => allPages(tenant, `/api/awards/applications?awardId=${encodeURIComponent(awardId)}`, 'applications', signal),
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
export function appointmentLabel(appointment, labels = {}) {
  if (!appointment) return 'Appointment unavailable';
  if (appointment.member_id) return labels[`member:${appointment.member_id}`] || `Member ${appointment.member_id}`;
  if (appointment.contact_id) return labels[`contact:${appointment.contact_id}`] || `Contact ${appointment.contact_id}`;
  return appointment.external_name ? `${appointment.external_name}${appointment.external_email ? ` · ${appointment.external_email}` : ''}` : appointment.external_email || appointment.id;
}
