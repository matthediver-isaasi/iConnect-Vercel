import { useState } from 'react';
import { formatScore } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useJudgingPeers } from './useJudgingPeers';

function answerText(value, criterion) {
  if (value == null || value === '') return null;
  if (criterion.type === 'rating') {
    const option = criterion.options?.find(option => option.key === value);
    if (option) return `${option.key} (${option.value})`;
  }
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (criterion.type === 'yes_no' && ['yes', 'no'].includes(value)) return value === 'yes' ? 'Yes' : 'No';
  if (criterion.type === 'pass_fail' && ['pass', 'fail'].includes(value)) return value === 'pass' ? 'Pass' : 'Fail';
  return String(value);
}

export default function JudgingPeers(props) {
  const { authority, assignment, assessment, criteria } = props;
  if (!Array.isArray(criteria) || !criteria.length || criteria.some(criterion => !criterion || typeof criterion.id !== 'string' || typeof criterion.title !== 'string')) {
    return <Card className="shadow-sm"><CardHeader><CardTitle className="text-xl">Peer assessments</CardTitle></CardHeader><CardContent><p role="alert" className="awards-help">Current assigned criteria labels are unavailable. Peer responses cannot be safely labelled and are not loaded. Your own worksheet has not been changed.</p></CardContent></Card>;
  }
  // Only this read-only region remounts for an observed server revision,
  // evidence change or authority change. The judge's worksheet never does.
  const context = JSON.stringify([authority?.scopeKey, assignment.id, assignment.applicationVersionId,
    assignment.criteriaVersionId, assessment?.state, assessment?.revision]);
  return <PeerPage key={context} {...props} />;
}

function PeerPage({ scope, authority, assignment, assessment, criteria }) {
  const [page, setPage] = useState(1);
  const query = useJudgingPeers({ scope, authority, assignment, assessment, criteria, page });
  const ready = !!authority?.ready && query.isSuccess && !query.isFetching && !query.isError && !!query.data;
  const data = ready ? query.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pageLabel = data && data.page > pages ? `Requested page ${data.page} is beyond the current ${pages}-page result` : `Page ${data?.page || page} of ${pages}`;
  return <Card className="min-w-0 shadow-sm" aria-labelledby="judging-peers-heading">
    <CardHeader className="border-b"><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><p className="awards-kicker">Read-only · server-authorised visibility</p><CardTitle id="judging-peers-heading" className="text-xl">Peer assessments</CardTitle><p className="awards-help">Only submitted, included peer assessments against the same assigned evidence and criteria are eligible for this view. Aliases are supplied by the server; no judge identities or drafts are shown.</p></div><Button type="button" size="sm" variant="outline" disabled={!authority?.ready || query.isFetching} onClick={() => query.refetch()}>Refresh peer view</Button></div></CardHeader>
    <CardContent className="pt-5 space-y-5">
      {!authority?.ready ? <p className="awards-help">Peer access is unavailable until your current judging authority is verified. Previously loaded peer responses are not displayed.</p>
        : query.isFetching || query.isPending ? <div role="status" aria-label="Loading authorised peer assessments" className="space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-32 w-full" /><p className="awards-help">Checking current peer visibility. Previous peer responses are hidden during this read.</p></div>
          : query.isError ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2"><p className="font-medium text-sm">{query.error.status === 401 ? 'Sign in or reopen a current judging invitation.' : query.error.status === 403 ? 'Peer access was denied or revoked.' : 'Peer assessments could not be loaded.'}</p><p className="text-sm">{query.error.network ? 'The peer read was interrupted. No save was attempted by this panel.' : query.error.message}</p><p className="awards-help">Cached peer content has been cleared. Your own assessment responses have not been changed. Refresh this peer view to request access again.</p></div>
            : !data ? <p className="awards-help">No currently verified peer page is available. Refresh to check the server.</p>
              : !data.available ? <div className="rounded-lg border bg-[#edf4f4] p-4 space-y-2"><p className="font-semibold text-sm">{data.visibility === 'blind' ? 'Peer assessments are hidden in this blind round.' : data.visibility === 'after_submit' ? 'Peer assessments are not currently available under the after-submit policy.' : 'The server has not made peer assessments available.'}</p><p className="awards-help">This is the server’s current visibility decision. Local draft or submission state cannot unlock this view. No peer responses are displayed.</p></div>
                : <>
                  <div className="space-y-2"><p className="awards-help">Visibility: {data.visibility === 'after_submit' ? 'after submission' : 'open'} · {pageLabel} · {data.total} available peer assessment{data.total === 1 ? '' : 's'} · up to {data.pageSize} per page.</p><p className="awards-help">{data.commentsVisible ? 'Only responses and comments actually supplied by this view are shown.' : 'Comments and text-criterion responses are not shared in this view.'} An omitted answer is not a zero or evidence of an incomplete assessment.</p></div>
                  {data.page > pages && <div className="rounded-lg border p-4 space-y-3"><p className="awards-help">The server’s available result count has changed. The requested page has not been silently relabelled.</p><Button type="button" variant="outline" size="sm" onClick={() => setPage(1)}>Return to first peer page</Button></div>}
                  {!data.assessments.length && <div className="rounded-lg border p-6 space-y-2"><h3 className="font-semibold text-sm">{data.total ? 'No peer assessments on this page' : 'No peer assessments returned'}</h3><p className="awards-help">No submitted, included, same-evidence peer responses were returned for this page. This says nothing about other judges’ drafts or identities.</p></div>}
                  <div className="space-y-4">{data.assessments.map(peer => <section key={peer.judgeAlias} className="rounded-lg border p-4 space-y-4" aria-label={`Submitted assessment from ${peer.judgeAlias}`}>
                    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold text-sm break-words">{peer.judgeAlias}</h3><p className="awards-help mt-1">Submitted <time dateTime={peer.submittedAt}>{new Date(peer.submittedAt).toISOString()} (UTC)</time></p></div><p className="text-sm font-medium">{peer.score == null ? 'No ranking score supplied in this view' : `Score ${formatScore(peer.score)} / 100`}</p></div>
                    <dl className="divide-y">{criteria.filter(criterion => Object.hasOwn(peer.answers, criterion.id) && (data.commentsVisible || criterion.type !== 'text')).map(criterion => {
                      const answer = peer.answers[criterion.id], text = answerText(answer.value, criterion);
                      return <div key={criterion.id} className="py-3 first:pt-0 space-y-2"><dt className="font-medium text-sm break-words">{criterion.title}</dt><dd className="text-sm whitespace-pre-wrap break-words">{text === null ? 'Response value not shared in this view.' : text}</dd>{data.commentsVisible && typeof answer.comment === 'string' && answer.comment !== '' && <dd className="text-sm whitespace-pre-wrap break-words"><span className="awards-help">Comment: </span>{answer.comment}</dd>}</div>;
                    })}</dl>
                    {!Object.keys(peer.answers).length && <p className="awards-help">No criterion answers were supplied for display. No missing values have been scored or inferred.</p>}
                  </section>)}</div>
                  <nav aria-label="Peer assessment pages" className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous peer page</Button><span className="awards-help">{pageLabel} · {data.total} total</span><Button type="button" size="sm" variant="outline" disabled={page >= pages || page >= 10000} onClick={() => setPage(value => value + 1)}>Next peer page</Button></nav>
                </>}
    </CardContent>
  </Card>;
}
