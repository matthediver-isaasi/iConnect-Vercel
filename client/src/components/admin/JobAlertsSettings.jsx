import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { adminFetch } from '@/lib/adminFetch';
import { readJobAlertsResponse } from '@/hooks/useJobAlerts';
import { invalidateJobAlertPreferences } from '@/lib/jobAlerts.mjs';

export default function JobAlertsSettings({ tenantId }) {
  const queryClient = useQueryClient();
  const queryKey = ['admin-job-alerts', tenantId];
  const query = useQuery({
    queryKey,
    enabled: !!tenantId,
    queryFn: async ({ signal }) => readJobAlertsResponse(await adminFetch('/api/admin/job-alerts', { signal }, tenantId)),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async enabled => readJobAlertsResponse(await adminFetch('/api/admin/job-alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }, tenantId)),
    onSuccess: data => {
      queryClient.setQueryData(queryKey, data);
      void invalidateJobAlertPreferences(queryClient, tenantId);
    },
  });
  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">Job postings emails</CardTitle>
        <CardDescription className="text-slate-400">Allow eligible members of this tenant to subscribe to job postings.</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? <div aria-label="Loading job alerts settings" className="h-10 rounded bg-slate-700 animate-pulse" /> : query.isError ? (
          <div role="alert" className="text-sm text-red-300">Unable to load job postings settings. <Button type="button" variant="ghost" onClick={() => query.refetch()}>Retry</Button></div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="tenant-job-alerts" className="text-sm text-slate-200">Enable job postings subscriptions</label>
            <Switch id="tenant-job-alerts" checked={query.data?.enabled === true} disabled={!tenantId || mutation.isPending || query.isFetching}
              onCheckedChange={enabled => mutation.mutate(enabled)} />
          </div>
        )}
        {mutation.isError && <p role="alert" className="mt-3 text-sm text-red-300">{mutation.error.message} <Button type="button" variant="ghost" onClick={() => mutation.mutate(mutation.variables)}>Retry</Button></p>}
        {mutation.isSuccess && <p role="status" className="mt-3 text-sm text-slate-300">Job postings settings saved.</p>}
      </CardContent>
    </Card>
  );
}
