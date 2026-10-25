export const isJobPostingsCategory = category => category?.system_key === 'job_postings';

export const jobAlertsKey = (tenantId, memberId) => ['job-alerts', tenantId, memberId];
export const communicationPreferencesKey = (tenantId, memberId) => ['my-communication-preferences', memberId, tenantId];

export function shouldPromptForJobAlerts(state) {
  return !!(state?.enabled && state.eligible && state.promptDue && !state.optedOutAll && !state.subscribed);
}

export function invalidateJobAlertPreferences(queryClient, tenantId) {
  return Promise.all([
    queryClient.invalidateQueries({
      predicate: query => query.queryKey[0] === 'job-alerts' && (!tenantId || query.queryKey[1] === tenantId),
    }),
    queryClient.invalidateQueries({ queryKey: ['my-communication-preferences'] }),
    queryClient.invalidateQueries({ queryKey: ['member-communication-preferences'] }),
    queryClient.invalidateQueries({ queryKey: ['communication-categories'] }),
  ]);
}

// Construct the return target rather than trusting arbitrary URL parameters.
export function jobAlertReturnTo(search) {
  const params = new URLSearchParams(search);
  const id = params.get('id');
  if (params.get('jobAlert') !== '1' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || '')) return null;
  return `/JobDetails?id=${encodeURIComponent(id)}&jobAlert=1`;
}
