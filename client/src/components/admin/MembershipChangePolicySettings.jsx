import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { adminFetch } from '@/lib/adminFetch';

const endpoint = '/api/admin/membership-change-policy';
const defaults = {
  surplusHandling: 'approval',
  creditExpiryDays: null,
  upgradesRequireApproval: true,
  downgradesRequireApproval: true,
  cancellationTiming: 'end_of_term',
  cancellationUnusedValue: 'none',
};

function validPolicy(policy) {
  return ['approval', 'credit', 'refund'].includes(policy.surplusHandling)
    && (policy.creditExpiryDays === null || (Number.isInteger(policy.creditExpiryDays) && policy.creditExpiryDays >= 1 && policy.creditExpiryDays <= 36500))
    && typeof policy.upgradesRequireApproval === 'boolean'
    && typeof policy.downgradesRequireApproval === 'boolean'
    && ['end_of_term', 'immediate'].includes(policy.cancellationTiming)
    && ['none', 'tenant_surplus_policy'].includes(policy.cancellationUnusedValue);
}

async function readResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(response.status === 409
      ? data?.code === 'TENANT_CONTEXT_CHANGED'
        ? 'Your tenant context has changed. Reload the page before editing this policy.'
        : 'This policy was changed by another administrator. Your edits have not been saved. Discard edits and reload the latest policy before saving again.'
      : [404, 503].includes(response.status)
        ? 'Membership change policy is unavailable. The API or database migration may not be deployed. Nothing has been saved; ask your administrator to check deployment, then retry.'
        : typeof data?.error === 'string' ? data.error : 'Unable to read or save the membership change policy. Please retry.');
    error.status = response.status;
    throw error;
  }
  const policy = { ...defaults, ...data?.policy };
  if (!data?.policy || Array.isArray(data.policy) || typeof data.policy !== 'object'
    || !Number.isInteger(data.revision) || data.revision < 0
    || data.executionEnabled !== false || !validPolicy(policy)) {
    throw new Error('The server returned an invalid membership change policy. Reload or ask your administrator to check the API and database migration. A successful save could not be confirmed.');
  }
  return { policy, revision: data.revision, executionEnabled: false };
}

const controlClass = 'w-full rounded-md border border-slate-600 bg-slate-900/50 px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50';

function PolicyEditor({ tenantId, initialData, queryKey, reloading, reload }) {
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState(initialData);
  const [draft, setDraft] = useState(initialData.policy);
  const [expiry, setExpiry] = useState(initialData.policy.creditExpiryDays === null ? '' : String(initialData.policy.creditExpiryDays));
  const [saved, setSaved] = useState(false);
  const expiryNumber = expiry.trim() === '' ? null : Number(expiry);
  const policy = { ...draft, creditExpiryDays: expiryNumber };
  const expiryValid = expiryNumber === null || (/^\d+$/.test(expiry) && Number.isInteger(expiryNumber) && expiryNumber >= 1 && expiryNumber <= 36500);
  const dirty = JSON.stringify(policy) !== JSON.stringify(baseline.policy);
  const mutation = useMutation({
    mutationFn: async payload => readResponse(await adminFetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, tenantId)),
    onSuccess: data => {
      queryClient.setQueryData(queryKey, data);
      setBaseline(data);
      setDraft(data.policy);
      setExpiry(data.policy.creditExpiryDays === null ? '' : String(data.policy.creditExpiryDays));
      setSaved(true);
    },
  });
  const locked = mutation.isPending || reloading;
  const conflict = mutation.error?.status === 409;
  const change = (field, value) => {
    setDraft(previous => ({ ...previous, [field]: value }));
    setSaved(false);
  };
  const discard = () => {
    setDraft(baseline.policy);
    setExpiry(baseline.policy.creditExpiryDays === null ? '' : String(baseline.policy.creditExpiryDays));
    setSaved(false);
    mutation.reset();
  };

  return (
    <form onSubmit={event => {
      event.preventDefault();
      if (!dirty || !expiryValid || locked || conflict) return;
      setSaved(false);
      mutation.mutate({ policy, expectedRevision: baseline.revision });
    }} className="space-y-6">
      <fieldset disabled={locked} className="space-y-6">
        <legend className="sr-only">Membership change policy</legend>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="membership-surplus" className="text-slate-200">Surplus value handling</Label>
            <select id="membership-surplus" className={controlClass} value={draft.surplusHandling} onChange={event => change('surplusHandling', event.target.value)}>
              <option value="approval">Require approval</option>
              <option value="credit">Issue account credit</option>
              <option value="refund">Refund</option>
            </select>
            <p className="text-xs text-slate-400">How surplus value should be handled when changes become available.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="membership-credit-expiry" className="text-slate-200">Credit expiry (days)</Label>
            <Input id="membership-credit-expiry" type="number" min="1" max="36500" step="1" value={expiry}
              aria-invalid={!expiryValid} aria-describedby={`membership-expiry-help${!expiryValid ? ' membership-expiry-error' : ''}`}
              placeholder="No expiry" className="bg-slate-900/50 border-slate-600 text-white"
              onChange={event => { setExpiry(event.target.value); setSaved(false); }} />
            <p id="membership-expiry-help" className="text-xs text-slate-400">Leave blank for no expiry, or enter 1–36,500 days.</p>
            {!expiryValid && <p id="membership-expiry-error" role="alert" className="text-sm text-red-300">Enter a whole number from 1 to 36,500, or leave blank.</p>}
          </div>
        </div>
        <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 px-4">
          {[
            ['upgradesRequireApproval', 'membership-upgrade-approval', 'Require approval for upgrades'],
            ['downgradesRequireApproval', 'membership-downgrade-approval', 'Require approval for downgrades'],
          ].map(([field, id, label]) => (
            <div key={field} className="flex items-center justify-between gap-4 py-4">
              <Label htmlFor={id} className="text-slate-200">{label}</Label>
              <Switch id={id} disabled={locked} checked={draft[field]} onCheckedChange={value => change(field, value)} />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="membership-cancellation-timing" className="text-slate-200">Cancellation timing</Label>
            <select id="membership-cancellation-timing" className={controlClass} value={draft.cancellationTiming} onChange={event => change('cancellationTiming', event.target.value)}>
              <option value="end_of_term">At the end of the membership term</option>
              <option value="immediate">Immediately</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="membership-cancellation-unused" className="text-slate-200">Unused value on cancellation</Label>
            <select id="membership-cancellation-unused" className={controlClass} value={draft.cancellationUnusedValue} onChange={event => change('cancellationUnusedValue', event.target.value)}>
              <option value="none">No credit or refund</option>
              <option value="tenant_surplus_policy">Use surplus value handling above</option>
            </select>
          </div>
        </div>
      </fieldset>
      {mutation.isError && (
        <div role="alert" className="space-y-2 text-sm text-red-300">
          <p>{mutation.error.message}</p>
          {conflict && <Button type="button" variant="outline" disabled={locked} onClick={reload} className="border-slate-600 bg-slate-900 text-slate-200">Discard edits and reload latest policy</Button>}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700 pt-4">
        <p role="status" className="text-sm text-slate-400">
          {mutation.isPending ? 'Saving configuration…' : saved ? 'Configuration saved. Member execution remains disabled.' : dirty ? 'Unsaved changes' : `Saved configuration · revision ${baseline.revision}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" disabled={!dirty || locked || conflict} onClick={discard} className="text-slate-300">Discard changes</Button>
          <Button type="submit" disabled={!dirty || !expiryValid || locked || conflict}>Save membership policy</Button>
        </div>
      </div>
    </form>
  );
}

function TenantPolicy({ tenantId }) {
  const [editorVersion, setEditorVersion] = useState(0);
  const [reloadError, setReloadError] = useState('');
  const queryKey = ['admin-membership-change-policy', tenantId];
  const query = useQuery({
    queryKey,
    enabled: !!tenantId,
    queryFn: async ({ signal }) => readResponse(await adminFetch(endpoint, { signal }, tenantId)),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const reload = async () => {
    setReloadError('');
    const result = await query.refetch();
    if (result.isSuccess) setEditorVersion(version => version + 1);
    else setReloadError('Unable to reload the latest policy. Your edits are still here; retry when the service is available.');
  };
  if (!tenantId) return <p role="status" className="text-sm text-slate-400">Select a verified tenant to configure membership changes.</p>;
  if (query.isLoading) return <div aria-label="Loading membership change policy" role="status" className="space-y-3"><div className="h-20 animate-pulse rounded bg-slate-700" /><div className="h-24 animate-pulse rounded bg-slate-700" /></div>;
  if (!query.data) return (
    <div role="alert" className="space-y-3 text-sm text-red-300">
      <p>Unable to load membership change policy. {query.error?.message}</p>
      <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()} className="border-slate-600 bg-slate-900 text-slate-200">Retry loading policy</Button>
    </div>
  );
  return (
    <div className="space-y-4">
      {(query.isError || reloadError) && <p role="alert" className="text-sm text-red-300">{reloadError || query.error?.message} <Button type="button" variant="ghost" disabled={query.isFetching} onClick={reload}>Retry reload</Button></p>}
      <PolicyEditor key={editorVersion} tenantId={tenantId} initialData={query.data} queryKey={queryKey} reloading={query.isFetching || query.isError} reload={reload} />
    </div>
  );
}

export default function MembershipChangePolicySettings({ tenantId }) {
  return (
    <Card className="bg-slate-800/50 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">Membership Changes &amp; Credit Handling</CardTitle>
        <CardDescription className="text-slate-400">Prepare your tenant’s approval, credit and cancellation policies.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-200">
          <p className="font-medium">Configuration only — member execution is not enabled</p>
          <p className="mt-1 text-amber-200/90">Saving does not enable self-service membership changes, process money, or alter existing forms. These settings prepare policy for a future release.</p>
        </div>
        <TenantPolicy key={tenantId || 'no-tenant'} tenantId={tenantId} />
      </CardContent>
    </Card>
  );
}
