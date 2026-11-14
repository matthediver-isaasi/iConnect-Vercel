import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const count = value => Number.isSafeInteger(value) && value >= 0;
const applicationColumns = [['total', 'Total applications'], ['eligible', 'Eligible'], ['pending', 'Pending'], ['withdrawn', 'Withdrawn'], ['ineligible', 'Ineligible (includes disqualified)']];
const assessmentColumns = [['assigned', 'Assigned assessments'], ['submitted', 'Submitted assessment responses'], ['scored', 'Assessments with ranking scores']];

export default function EventAwardsProgress({ tenant, eventId, type, link, name, request, onClose }) {
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const key = ['event-awards-progress', tenant.scopeKey, type, eventId, link.id, page];
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      try {
        const data = await request(tenant, `/api/awards/events?progress=1&linkId=${encodeURIComponent(link.id)}&page=${page}`, undefined, signal);
        if (!Array.isArray(data.awards) || !count(data.total) || data.page !== page || data.pageSize !== 25
          || data.awards.length !== Math.min(25, Math.max(0, data.total - (page - 1) * 25))
          || new Set(data.awards.map(award => award?.id)).size !== data.awards.length
          || data.awards.some(award => !award || typeof award.id !== 'string' || !award.id || typeof award.name !== 'string' || typeof award.state !== 'string'
            || !count(award.rounds) || !count(award.approvedOutcomes)
            || applicationColumns.some(([field]) => !count(award.applications?.[field]))
            || assessmentColumns.some(([field]) => !count(award.assessments?.[field])))) throw new Error('The linked-award progress page is incomplete or unverifiable. No partial counts are shown.');
        if (link.award_id && (data.total > 1 || data.awards.some(award => award.id !== link.award_id))) throw new Error('The returned progress does not match this award association.');
        return data;
      } catch (error) {
        if (!signal.aborted) queryClient.setQueryData(key, null);
        throw error;
      }
    },
    gcTime: 0, staleTime: 0, retry: false, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const ready = query.isSuccess && !query.isFetching && !!query.data;
  const data = ready ? query.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / 25)) : null;
  const outOfRange = data && page > pages;
  return <Card className="min-w-0 max-w-full" aria-label="Staff-only linked-award progress">
    <CardHeader><div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><p className="awards-kicker">Staff only · read-only progress</p><CardTitle className="text-lg mt-1 break-words">{name}</CardTitle></div><Button type="button" size="sm" variant="outline" onClick={onClose}>Close progress</Button></div>
      <p className="awards-help">Counts are available to authorised event administrators without awards configuration permission. They are not included in the public/member event projection. Viewing or refreshing progress does not save or discard association-editor drafts.</p>
    </CardHeader>
    <CardContent className="min-w-0 space-y-4">
      <div className="flex flex-wrap gap-3 items-center"><Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh progress (keep association editor)</Button>
        {data && <p role="status" className="awards-help">{data.total} {data.total === 1 ? 'award' : 'awards'} in this {link.programme_id ? 'programme association' : 'award association'} · requested page {page}{!outOfRange ? ` of ${pages}` : ''}.</p>}
      </div>
      <p className="awards-help">All application, round, assessment and outcome counts below belong to each individual award. A programme’s total above is its full server-reported award count, not a sum of the first page’s activity. Browse every page to see all its awards.</p>
      <p className="text-sm rounded-lg border p-3">Assessment counts span all rounds and cover included, currently assigned assessments with cleared/no conflict on eligible applications. Submitted assessment responses are not the same as assessments with ranking scores. Approved outcomes are not necessarily published or released to recipients.</p>
      {query.isFetching || query.isPending ? <div className="space-y-3" aria-label="Loading staff award progress"><Skeleton className="h-12 w-full" /><Skeleton className="h-28 w-full" /></div>
        : query.isError ? <p role="alert" className="text-sm text-red-800">{query.error.message} No previous or partial counts are shown. Use Refresh progress to retry.</p>
          : data && data.total === 0 ? <div className="rounded-lg border border-dashed p-5"><h3 className="font-medium text-sm">No awards returned for this association</h3><p className="awards-help mt-2">There is no award progress to display. No application or assessment counts have been inferred.</p></div>
            : outOfRange ? <div className="rounded-lg border p-4 space-y-3"><p className="awards-help">This requested page no longer contains awards. The association now contains {data.total} awards across {pages} pages. Counts from an earlier page have been cleared.</p><Button type="button" size="sm" variant="outline" onClick={() => setPage(1)}>Load first progress page</Button></div>
              : data && <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border" tabIndex={0} role="region" aria-label="Award progress table, scroll horizontally for all counts">
                <table className="w-full text-sm text-left"><caption className="text-left awards-help p-4">Showing awards {(page - 1) * 25 + 1}–{Math.min(page * 25, data.total)} of {data.total}. Counts are per award, across all rounds; no combined programme activity totals are calculated.</caption>
                  <thead className="border-b bg-slate-50"><tr><th scope="col" className="p-3 min-w-48">Award / stage</th>{applicationColumns.map(([field, label]) => <th scope="col" key={field} className="p-3 min-w-24">{label}</th>)}<th scope="col" className="p-3">Rounds</th>{assessmentColumns.map(([field, label]) => <th scope="col" key={field} className="p-3 min-w-36">{label}</th>)}<th scope="col" className="p-3 min-w-36">Approved outcomes (not publication/release)</th></tr></thead>
                  <tbody className="divide-y">{data.awards.map(award => <tr key={award.id}><th scope="row" className="p-3 align-top font-medium"><span className="block break-words">{award.name}</span><span className="awards-help font-normal block mt-1">{award.state.replaceAll('_', ' ')}</span></th>{applicationColumns.map(([field]) => <td key={field} className="p-3 align-top tabular-nums">{award.applications[field].toLocaleString()}</td>)}<td className="p-3 align-top tabular-nums">{award.rounds.toLocaleString()}</td>{assessmentColumns.map(([field]) => <td key={field} className="p-3 align-top tabular-nums">{award.assessments[field].toLocaleString()}</td>)}<td className="p-3 align-top tabular-nums">{award.approvedOutcomes.toLocaleString()}</td></tr>)}</tbody>
                </table>
              </div>}
      {data && data.total > 0 && <nav className="flex flex-wrap justify-between items-center gap-3" aria-label="Linked-award progress pages"><Button type="button" size="sm" variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>Previous progress page</Button><span className="awards-help">25 awards per page · {data.total} awards total</span><Button type="button" size="sm" variant="outline" disabled={page >= pages || page >= 10000 || query.isFetching} onClick={() => setPage(value => value + 1)}>Next progress page</Button></nav>}
      {data && pages > 10000 && <p role="alert" className="text-sm text-amber-900">This programme exceeds the server’s 10,000-page access limit. The award total is complete, but not all award rows are accessible here. No partial programme activity summary has been created.</p>}
    </CardContent>
  </Card>;
}
