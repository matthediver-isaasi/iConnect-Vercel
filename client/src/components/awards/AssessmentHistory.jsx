import { useLayoutEffect, useState } from 'react';
import { formatScore } from '../../../../api/_lib/assessment/scoring.js';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAssessmentHistory } from './useAssessmentHistory';
import AdminModerationEvidence from './AdminModerationEvidence';

const text = value => value === null || value === undefined || value === '' ? 'No value recorded'
  : ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : 'Recorded value cannot be displayed as a scalar response';
function originalScore(score) {
  if (score === null) return 'No ranking score recorded';
  try { return `${formatScore(score)} / 100`; } catch { return 'Original score cannot be formatted'; }
}
function RecordedAnswers({ assessment }) {
  const criteria = assessment.definition?.criteria;
  return <div className="space-y-4">
    {!criteria && <p className="awards-help">The original rubric is unavailable. Only recorded criterion IDs and values are shown; current rubric labels/types are not substituted.</p>}
    {!Object.keys(assessment.answers).length ? <p className="awards-help">No criterion responses were recorded in this submitted revision.</p>
      : <dl className="space-y-4">{Object.entries(assessment.answers).map(([id, answer]) => {
        const criterion = criteria?.find(item => item?.id === id);
        const option = criterion?.type === 'rating' && Array.isArray(criterion.options) ? criterion.options.find(item => item?.key === answer?.value) : null;
        return <div key={id}><dt className="text-sm font-semibold whitespace-pre-wrap break-words">{typeof criterion?.title === 'string' ? criterion.title : `Criterion ${id}`}<span className="awards-help block font-normal">Criterion reference: {id} · Original type: {typeof criterion?.type === 'string' ? criterion.type : 'unavailable'}</span></dt>
          <dd className="text-sm whitespace-pre-wrap break-words mt-1">{text(answer?.value)}{option && <span className="awards-help block">Original mapped rating value: {text(option.value)}</span>}</dd>
          {answer && Object.hasOwn(answer, 'comment') && <dd className="awards-help whitespace-pre-wrap break-words mt-2">Recorded comment: {text(answer.comment)}</dd>}
        </div>;
      })}</dl>}
  </div>;
}

export default function AssessmentHistory(props) {
  const [page, setPage] = useState(1);
  const { query, data, failure } = useAssessmentHistory({ ...props, page });
  const [selectedVersion, setSelectedVersion] = useState(null);
  const canViewEvidence = !props.judgingContext && Boolean(props.canModerate || props.canApprove);
  const sourceScope = JSON.stringify([props.tenant?.scopeKey, props.roundId, props.applicationId, props.canModerate, props.canApprove, !!props.judgingContext]);
  useLayoutEffect(() => { setSelectedVersion(null); }, [sourceScope, props.enabled, page, query.isFetching, failure]);
  const pages = data ? Math.max(1, Math.ceil(data.total / 10)) : null;
  return <section className="border-t pt-5 space-y-4" aria-label="Historical submitted assessments">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">Historical submitted assessments</h3><p className="awards-help mt-2 max-w-2xl">Submitted revisions only, including prior evidence/rubrics. Original scores below are historical records, not the official score, a recalculated score or proof of current aggregation eligibility. Aliases are server-provided and round-local; do not match judges across rounds.</p></div><Button type="button" variant="outline" size="sm" disabled={!props.enabled || query.isFetching} onClick={() => query.refetch()}>Reload submitted history page</Button></div>
    {failure && <p role="alert" className="text-sm text-red-800">{failure} Previously loaded history has been cleared. No answers or inputs in your proposal/discussion have been changed.</p>}
    {!props.enabled ? <p className="awards-help">History is hidden pending current evidence access and conflict/authority verification. Use the main evidence reload if access has changed; historical data is not retained on screen.</p>
      : query.isFetching || query.isLoading ? <div aria-label="Loading submitted assessment history" className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-24 w-full" /></div>
        : data && <>
          {data.assessments.length ? <ol className="space-y-3">{data.assessments.map(row => <li key={row.id}><details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold break-words">{row.judge} · submitted revision {row.revision} · {row.current ? 'Current assignment revision (not necessarily official/included)' : 'Prior revision — historical only'}</summary>
            <div className="space-y-4 mt-4"><p className="text-sm font-medium">Original submitted score: {originalScore(row.score)}</p>{row.score && <p className="awards-help break-all">Original exact numerator: {row.score.numerator} · denominator: {row.score.denominator}</p>}
              <p className="awards-help">Submitted: {new Date(row.submittedAt).toLocaleString()} · Current assignment state: {row.assignmentState} · Current assignment inclusion: {row.assignmentIncluded ? 'Included' : 'Excluded'} · Current conflict: {row.conflict}. These assignment flags describe the assignment now, not its historical inclusion at submission; they do not make a prior revision current.</p>
              <dl className="space-y-2 text-xs break-all"><div><dt className="font-semibold">Immutable submitted revision reference</dt><dd><code>{row.id}</code></dd></div><div><dt className="font-semibold">Immutable application evidence version</dt><dd><code>{row.applicationVersionId}</code></dd></div><div><dt className="font-semibold">Immutable criteria version</dt><dd><code>{row.criteriaVersionId}</code></dd></div></dl>
              <RecordedAnswers assessment={row} />
              {canViewEvidence && <div className="space-y-2"><p className="awards-help">Open only this submitted revision’s referenced application evidence. Historical evidence is not an official score or an instruction to adopt that version.</p>
                <Button type="button" size="sm" variant="outline" onClick={() => setSelectedVersion({ scope: sourceScope, id: row.applicationVersionId })}>View referenced evidence version</Button></div>}
            </div></details></li>)}</ol> : <div className="rounded-lg border p-5"><h4 className="text-sm font-semibold">No submitted revisions on this page</h4><p className="awards-help mt-2">{data.total ? 'The paginated source changed. Return to an earlier page or reload explicitly.' : 'No submitted assessment revisions were returned. Draft answers and scores are never shown here.'}</p></div>}
          <div className="flex flex-wrap justify-between items-center gap-3"><p className="awards-help" aria-live="polite">Submitted history page {data.page} of {pages} · {data.assessments.length} shown · {data.total} submitted revisions total · 10 per server page</p><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={query.isFetching || page <= 1} onClick={() => setPage(value => value - 1)}>Previous submissions</Button><Button type="button" size="sm" variant="outline" disabled={query.isFetching || page >= pages} onClick={() => setPage(value => value + 1)}>Next submissions</Button></div></div>
        </>}
    {canViewEvidence && props.enabled && !failure && data && !query.isFetching && selectedVersion?.scope === sourceScope
      && data.assessments.some(row => row.applicationVersionId === selectedVersion.id) && <AdminModerationEvidence
        key={`${sourceScope}:${selectedVersion.id}`} tenant={props.tenant} roundId={props.roundId} applicationId={props.applicationId}
        versionId={selectedVersion.id} canModerate={props.canModerate} canApprove={props.canApprove} />}
    {props.enabled && !query.isFetching && !data && !failure && <p role="alert" className="awards-help">No verified history response is available. Reload this page explicitly; no previous data or zero score is substituted.</p>}
  </section>;
}
