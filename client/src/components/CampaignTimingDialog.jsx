import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import CampaignDeliverySummary from './communications/CampaignDeliverySummary';
import useCampaignTimings from './useCampaignTimings';
import { formatCampaignTimestamp, formatCampaignDuration } from './campaignTimingDisplay.mjs';

function TimestampRow({ label, value, missing, timeZone }) {
  const formatted = formatCampaignTimestamp(value, timeZone);
  return <div className="grid gap-1 border-b border-border/60 py-2.5 last:border-0 sm:grid-cols-[1fr_1.2fr] sm:gap-4">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="font-medium sm:text-right">
      {formatted ? <time dateTime={value}>{formatted}</time> : <span className="font-normal text-muted-foreground">{missing || 'Not recorded'}</span>}
    </dd>
  </div>;
}

export default function CampaignTimingDialog({ campaign, open, onOpenChange, onInspect }) {
  const { data, isPending, isFetching, error, refetch } = useCampaignTimings(campaign?.id, open);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const current = { ...campaign, ...data?.campaign };
  const timings = data?.timings;
  const ongoing = ['preparing', 'sending', 'paused', 'scheduled', 'draft'].includes(current?.status);
  const inspect = () => {
    onOpenChange(false);
    onInspect(current);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[88dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto" data-testid="campaign-timing-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Clock aria-hidden="true" className="h-4 w-4 text-muted-foreground" />Campaign timings &amp; status</DialogTitle>
        <DialogDescription className="break-words">{campaign?.name} · All times in {timeZone}</DialogDescription>
      </DialogHeader>

      <section className="rounded-lg border bg-muted/30 p-4 text-sm" aria-label="Campaign status details">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status details</h3>
        <p className="mb-2 capitalize">{current?.status || 'Unknown status'}{current?.is_test_mode ? ' · Test campaign' : ''}</p>
        <CampaignDeliverySummary summary={current?.delivery_summary} onInspect={inspect} />
        {!current?.delivery_summary && ['sending', 'paused', 'sent', 'failed', 'cancelled'].includes(current?.status) && (
          <p className="text-xs text-muted-foreground">Delivery breakdown unavailable. Open statistics to refresh.</p>
        )}
        {current?.preparation?.phase === 'failed' && current?.status === 'failed' && (
          <p className="mt-2 break-words text-xs text-destructive" data-testid={`text-preparation-error-${campaign?.id}`}>
            Audience preparation failed: {current.preparation.last_error || 'No further details available.'}
            {current.preparation.last_error === 'No recipients found for this campaign' && (
              <> This older preparation did not retain exclusion counts. Review a fresh campaign recipient preview; a failed preparation cannot be resumed. If appropriate, duplicate it as a new draft without overriding consent.</>
            )}
          </p>
        )}
        {current?.status === 'scheduled' && current?.scheduled_at && <p className="mt-2 text-xs text-muted-foreground">Scheduled: {formatCampaignTimestamp(current.scheduled_at, timeZone) || 'Not recorded'}</p>}
        {current?.status === 'sent' && current?.sent_at && <p className="mt-2 text-xs text-muted-foreground">Recorded campaign start: {formatCampaignTimestamp(current.sent_at, timeZone) || 'Not recorded'}. This is not a provider acceptance timestamp.</p>}
      </section>

      {isPending && !error && <div role="status" aria-label="Loading campaign timings" className="space-y-3 py-2">
        <span className="sr-only">Loading campaign timings</span>
        {[0, 1, 2, 3].map(row => <div key={row} className="h-8 rounded bg-muted motion-safe:animate-pulse" />)}
      </div>}
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
        <p className="font-medium">Timings could not be loaded</p>
        <p className="mt-1 text-muted-foreground">{error.message}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => refetch()} disabled={isFetching}>Try again</Button>
      </div>}
      {timings && !error && <section aria-label="Recorded campaign timings" className="space-y-4 text-sm">
        <dl>
          <TimestampRow label="Scheduled" value={timings.scheduled_at} missing="Not scheduled" timeZone={timeZone} />
          <TimestampRow label="Campaign start" value={timings.started_at} missing={current?.status === 'draft' ? 'Not started' : 'Not recorded'} timeZone={timeZone} />
          <TimestampRow label="Preparation started" value={timings.preparation_started_at} timeZone={timeZone} />
          <TimestampRow label="Preparation completed" value={timings.preparation_completed_at} missing={current?.status === 'preparing' ? 'Not finished' : 'Not recorded'} timeZone={timeZone} />
          <TimestampRow label="First recorded successful send" value={timings.first_recipient_sent_at} timeZone={timeZone} />
          <TimestampRow label="Last recorded successful send" value={timings.last_recipient_sent_at} timeZone={timeZone} />
          <TimestampRow label="Campaign finish" value={ongoing ? null : timings.completed_at} missing={ongoing ? 'Not finished' : 'Not recorded'} timeZone={timeZone} />
        </dl>
        <dl className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
          {[
            ['Preparation duration', timings.preparation_duration_ms],
            ['Send duration', ongoing ? null : timings.send_duration_ms],
            ['Overall duration', ongoing ? null : timings.overall_duration_ms],
          ].map(([label, duration]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-medium tabular-nums">{formatCampaignDuration(duration)}</dd>
          </div>)}
        </dl>
        <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          <p>Successful-send timestamps are application-recorded recipient sent_at values, not independently verified Mailgun acceptance or delivery times. The last recorded email is not the campaign finish.</p>
          <p>Durations require both recorded endpoints. Missing dates are not estimated from the last update; overall and send durations include any pauses.</p>
          {timings.notes?.map((note, index) => <p key={index}>{note}</p>)}
          {['sending', 'preparing'].includes(current?.status) && <p role="status">Refreshes every 5 seconds while this dialog is open.</p>}
        </div>
      </section>}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={inspect}>Open statistics</Button>
        <Button type="button" onClick={() => onOpenChange(false)}>Close</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
