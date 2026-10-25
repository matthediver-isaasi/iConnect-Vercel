import { useEffect, useRef, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useJobAlerts } from '@/hooks/useJobAlerts';
import { shouldPromptForJobAlerts } from '@/lib/jobAlerts.mjs';

export default function JobAlertsSubscription() {
  const { query, mutation, enabled } = useJobAlerts();
  const [open, setOpen] = useState(false);
  const evaluated = useRef(false);
  const state = query.data;
  useEffect(() => {
    // Evaluate once against a fresh server response per visit, never on a timer
    // or an unrelated cache invalidation later in the same visit.
    if (!enabled || query.isFetching || !query.isSuccess || evaluated.current) return;
    evaluated.current = true;
    setOpen(shouldPromptForJobAlerts(state));
  }, [enabled, query.isFetching, query.isSuccess, state]);

  const save = action => {
    mutation.mutate(action, { onSuccess: () => setOpen(false) });
  };
  if (!enabled) return null;
  if (query.isLoading) return <div aria-label="Loading job postings preferences" className="h-20 mb-6 rounded-lg bg-slate-100 animate-pulse" />;
  if (query.isError) return (
    <div role="alert" className="mb-6 rounded-lg border border-slate-200 p-4 text-sm text-slate-600">
      Job postings preferences could not be loaded.
      <Button type="button" variant="link" onClick={() => query.refetch()}>Retry</Button>
    </div>
  );
  if (!state?.enabled || !state.eligible) return null;
  const promptOpen = open && !query.isError && !state.optedOutAll && shouldPromptForJobAlerts(state);
  return (
    <>
      <Card className="border-slate-200 shadow-sm mb-6">
        <CardContent className="p-4 md:p-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Mail aria-hidden="true" className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
              <div>
                <h2 id="job-postings-subscription" className="font-medium text-slate-900">Job postings</h2>
                <p className="text-sm text-slate-500">
                  {state.optedOutAll ? 'You have opted out of all communications. Manage this in About me.' : state.subscribed ? 'You are subscribed to job postings emails.' : 'Receive new job postings by email.'}
                </p>
              </div>
            </div>
            <Switch aria-labelledby="job-postings-subscription" checked={!state.optedOutAll && state.subscribed}
              disabled={mutation.isPending || state.optedOutAll || query.isFetching}
              onCheckedChange={subscribed => save({ action: 'subscribe', subscribed })} />
          </div>
          {mutation.isError && !promptOpen && <p role="alert" className="mt-3 text-sm text-red-700">{mutation.error.message} <Button variant="link" type="button" onClick={() => save(mutation.variables)}>Retry</Button></p>}
        </CardContent>
      </Card>
      <Dialog open={promptOpen} onOpenChange={() => {}}>
        <DialogContent hideCloseButton className="max-w-lg" onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Keep up with new job postings</DialogTitle>
            <DialogDescription>Subscribe to receive job postings by email. You can change your communication preferences at any time in About me.</DialogDescription>
          </DialogHeader>
          {mutation.isError && <p role="alert" className="text-sm text-red-700">{mutation.error.message} Choose an option again to retry.</p>}
          <DialogFooter className="gap-2 sm:flex-wrap">
            <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => save({ action: 'never' })}>Don't ask again</Button>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => save({ action: 'later' })}>Ask me later (7 days)</Button>
            <Button type="button" disabled={mutation.isPending} onClick={() => save({ action: 'subscribe', subscribed: true })}>{mutation.isPending ? 'Saving…' : 'Subscribe'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
