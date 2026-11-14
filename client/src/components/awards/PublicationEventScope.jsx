import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { eventLinksReady, publicationScopeLabel } from './usePublicationEventLinks';

export default function PublicationEventScope({ query, scope, eventLinkId, historicalIds = [], disabled, onChange }) {
  const ready = eventLinksReady(query), links = ready ? query.data : [];
  const historical = [...new Set(historicalIds)].filter(id => id && !links.some(link => link.id === id));
  return <fieldset disabled={disabled} className="space-y-3">
    <label className="block text-sm">Publication scope (choose explicitly)<select className="awards-select mt-1" value={scope} onChange={event => onChange(event.target.value, '')}><option value="">Choose publication scope</option><option value="award">Award-wide (no event association)</option><option value="event">Linked event association</option></select></label>
    <p className="awards-help">Association audience, information and application-link flags describe the event association only. They do not authorise result publication, choose a publication audience, release recipients or send mail.</p>
    {scope === 'event' && <>
      <label className="block text-sm">Existing event association<select className="awards-select mt-1" value={eventLinkId} onChange={event => onChange('event', event.target.value)}><option value="">Choose a discovered association or recorded stream</option>
        {eventLinkId && !links.some(link => link.id === eventLinkId) && !historical.includes(eventLinkId) && <option value={eventLinkId} disabled>Retained association {eventLinkId} — discovery unavailable</option>}
        {ready && <optgroup label="Complete discovered association catalog">{links.map(link => <option key={link.id} value={link.id}>{publicationScopeLabel(link.id, links)}</option>)}</optgroup>}
        {historical.length > 0 && <optgroup label="Recorded streams — current discovery not verified">{historical.map(id => <option key={id} value={id}>{publicationScopeLabel(id)}</option>)}</optgroup>}
      </select></label>
      {(query.isPending || query.isFetching) && <div role="status" aria-label="Loading complete publication event associations"><Skeleton className="h-10 w-full" /></div>}
      {query.isError && <p role="alert" className="text-sm text-red-800">{query.error.message} No partial discovery choices are shown. Award-wide scope, recipient release and recorded-stream maintenance are independent of this discovery read.</p>}
      <Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Reload complete event associations (keep authored text)</Button>
      {ready && <p className="awards-help">Complete catalog loaded: {links.length} associations, including direct-award and current programme links.{!links.length ? ' No new linked-event target is available.' : ''}</p>}
      {ready && links.find(link => link.id === eventLinkId) && (() => {
        const link = links.find(row => row.id === eventLinkId);
        return <p className="awards-help">Association audience: {link.audience === 'public' ? 'public and members' : 'members only'} · information {link.showInformation ? 'shown' : 'hidden'} · application link {link.showApplicationLink ? 'shown' : 'hidden'}. These flags are not publication authority.</p>;
      })()}
      {historical.includes(eventLinkId) && <p className="awards-help">This ID comes from immutable publication history, not raw entry. Current association discovery is not verified; the server still checks whether this exact recorded stream can be maintained. Never substitute award-wide scope to work around a rejected event action.</p>}
    </>}
  </fieldset>;
}
