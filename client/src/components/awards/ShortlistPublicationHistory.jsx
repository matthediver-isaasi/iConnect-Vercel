import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { messageTime } from './useAwardCommunications';
import { shortlistGroupKey, shortlistStreamKey } from './useShortlistPublication';

export default function ShortlistPublicationHistory({ publications, decisions, streams, timezone, canPublish, disabled, onMaintain, onCopy }) {
  const [page, setPage] = useState(1), pages = Math.max(1, Math.ceil(publications.length / 10)), shownPage = Math.min(page, pages);
  return <section className="border-t pt-5 space-y-4">
    <h3 className="font-semibold">Immutable shortlist publication history</h3>
    <p className="awards-help">These are recorded safe projections, not a list of current confidential shortlist members. Every audience/event stream remains visible after a decision is replaced or reopened. Historical streams can still be retracted; correction requires a current eligible confirmed decision for the same round/application.</p>
    {!publications.length && <div className="rounded-lg border border-dashed p-5 awards-help">No shortlist publication revisions are recorded. A confirmed staff decision is not itself a public or member announcement.</div>}
    <ol className="space-y-3">{publications.slice((shownPage - 1) * 10, shownPage * 10).map(row => {
      const current = decisions.find(item => shortlistGroupKey(item) === shortlistGroupKey(row));
      const latest = streams.get(shortlistStreamKey(row)), active = latest?.action !== 'retract';
      return <li key={row.id}><details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold break-words">{current ? `${current.reference} · ${current.round_name}` : `Historical application ${row.application_id} · round ${row.round_id}`} · {row.audience} · publication revision {row.revision} · {row.action}</summary>
        <div className="mt-3 space-y-3 text-sm break-words">
          <p className="awards-help">{row.event_link_id ? `Event-association stream: ${row.event_link_id}` : 'Award-level stream (no event association)'} · {messageTime(row.created_at, timezone)}</p>
          <p className="awards-help">Current stream head: revision {latest?.revision} · {latest?.action}. {current ? 'A current confirmed decision exists for this round/application.' : 'No current eligible confirmed decision is in the protected catalog; retraction remains available for an active recorded stream.'}</p>
          {row.action === 'retract' ? <p className="awards-help">This revision withdraws the projection; it does not publish replacement text.</p> : <div className="rounded-lg border bg-[#edf4f4] p-4 space-y-2"><p className="font-medium whitespace-pre-wrap">{row.safe_projection?.title}</p><p className="whitespace-pre-wrap">{row.safe_projection?.recipient}</p><p className="whitespace-pre-wrap">{row.safe_projection?.summary}</p></div>}
          <p className="whitespace-pre-wrap">Recorded reason: {row.reason}</p>
          <p className="awards-help">Publication ID: {row.id} · decision ID: {row.shortlist_id}</p>
          {canPublish && <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onMaintain(row)}>Maintain this exact stream{active && !current ? ' / retract historical decision' : ''}</Button>
            {row.action !== 'retract' && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onCopy(row)}>Explicitly load this revision’s safe text</Button>}</div>}
        </div>
      </details></li>;
    })}</ol>
    <nav aria-label="Shortlist publication history pages" className="flex justify-between items-center gap-3"><Button type="button" size="sm" variant="outline" disabled={shownPage <= 1} onClick={() => setPage(shownPage - 1)}>Previous</Button><span className="awards-help">Page {shownPage} of {pages} · display pagination only; all revisions are loaded for optimistic checks</span><Button type="button" size="sm" variant="outline" disabled={shownPage >= pages} onClick={() => setPage(shownPage + 1)}>Next</Button></nav>
  </section>;
}
