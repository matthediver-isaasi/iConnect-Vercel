import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const displayDate = value => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : 'Not recorded';
const money = row => row?.finalCost == null ? 'Not recorded'
  : new Intl.NumberFormat('en-GB', { style: 'currency', currency: row.currency || 'GBP' }).format(Number(row.finalCost));

export default function OrganisationImmediateMembershipCards({ view }) {
  const row = view.current;
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="organisation-immediate-membership">
    <Card><CardHeader><CardTitle className="text-base">
      {view.state === 'current' ? 'Current membership term' : view.state === 'past' ? 'Previous membership term'
        : view.state === 'scheduled' ? 'Scheduled membership term' : 'Recorded membership'}
    </CardTitle></CardHeader><CardContent className="space-y-2">
      {row ? <>
        <p className="font-medium">{row.structureName}{row.tierLabel ? ` — ${row.tierLabel}` : ''}</p>
        <p>Recorded fee: <strong>{money(row)}</strong>{row.paymentStatus === 'paid' ? ' · Paid' : ''}</p>
        {view.state === 'dates_missing' ? <p className="text-sm text-muted-foreground">
          This saved membership has no recorded term dates. Its paid fee is retained, but its current term and renewal date cannot be confirmed. Review the original purchase before assigning dates.
        </p> : <p className="text-sm">From {displayDate(row.startDate)} to {displayDate(row.endDate)}</p>}
      </> : <p className="text-sm text-muted-foreground">{view.state === 'review_required'
        ? 'Multiple membership records need review before a current term can be identified.'
        : 'No membership has been recorded for this organisation.'}</p>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Next membership term</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {view.scheduled && view.scheduled.id !== row?.id ? <>
          <p className="font-medium">{view.scheduled.structureName}</p>
          <p>Recorded fee: <strong>{money(view.scheduled)}</strong></p>
          <p className="text-sm">From {displayDate(view.scheduled.startDate)} to {displayDate(view.scheduled.endDate)}</p>
        </> : <p className="text-sm text-muted-foreground">
          {view.state === 'current' && row?.renewalDate
            ? `The next term is due to start on ${displayDate(row.renewalDate)}. No next-term fee has been recorded.`
            : 'No next term has been recorded. Immediate-start memberships follow their own commencement and renewal dates, not a fixed calendar year.'}
        </p>}
      </CardContent>
    </Card>
  </div>;
}
