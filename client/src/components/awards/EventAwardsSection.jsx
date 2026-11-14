import React, { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { publicClient } from '@/api/publicClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const optionalText = value => value == null || typeof value === 'string';
const safeShortlist = value => value && typeof value === 'object' && typeof value.title === 'string' && [value.recipient, value.summary].every(optionalText);
function verifyProjection(result) {
  if (!Array.isArray(result?.awards) || result.awards.some(award =>
    !award || typeof award.awardId !== 'string' || typeof award.eventLinkId !== 'string'
    || ![award.name, award.description, award.eligibility, award.applicationSlug].every(optionalText)
    || !Array.isArray(award.outcomes) || award.outcomes.some(outcome => !outcome || typeof outcome !== 'object' || typeof outcome.title !== 'string' || ![outcome.recipient, outcome.summary, outcome.category].every(optionalText))
    || (award.shortlists != null && (!Array.isArray(award.shortlists) || award.shortlists.some(value => !safeShortlist(value)))))) {
    throw new Error('The event awards response could not be verified.');
  }
  return result.awards;
}

export default function EventAwardsSection({ eventId, type, memberInfo = null, enabled = true, inline = false }) {
  if (!enabled || !eventId) return null;
  const audience = memberInfo ? 'member' : 'public';
  // A changed event, tenant or actual viewer remounts the section. Private
  // member projections are never reused as public or another member's data.
  const tenant = publicClient.getTenantSlug();
  return <EventAwardsProjection key={JSON.stringify([tenant, eventId, type, audience, memberInfo?.tenant_id, memberInfo?.id])} eventId={eventId} type={type} audience={audience} tenant={tenant} inline={inline} />;
}

function EventAwardsProjection({ eventId, type, audience, tenant, inline }) {
  const [result, setResult] = useState({ state: 'loading', awards: [], error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setResult({ state: 'loading', awards: [], error: '' });
    const load = async () => {
      try {
        if (!['event', 'complex'].includes(type)) throw new Error('A valid event type is required to load awards.');
        const response = await publicClient.getEventAwards(eventId, type, audience);
        if (publicClient.getTenantSlug() !== tenant) throw new Error('The event tenant changed. Reload this event to view its awards.');
        const awards = verifyProjection(response);
        if (current) setResult({ state: 'ready', awards, error: '' });
      } catch (failure) { if (current) setResult({ state: 'error', awards: [], error: failure.message || 'Event awards could not be loaded.' }); }
    };
    load();
    return () => { current = false; };
  }, [eventId, type, audience, tenant, attempt]);
  const cardClass = inline ? 'border-slate-200 rounded-none border-x-0 border-b-0 shadow-none' : 'border-slate-200';
  if (result.state === 'loading') return <Card className={cardClass} aria-label="Loading event awards"><CardContent className="p-6 space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-12 w-full" /></CardContent></Card>;
  if (result.state === 'error') return <Card className={cardClass}><CardContent className="p-6"><h2 className="font-semibold text-slate-900">Awards currently unavailable</h2><p role="alert" className="text-sm text-slate-600 mt-2">{result.error}</p><Button type="button" variant="outline" className="mt-3" onClick={() => setAttempt(value => value + 1)}>Retry awards</Button></CardContent></Card>;
  if (!result.awards.length) return null;
  return <Card className={cardClass} data-testid="event-awards-section">
    <CardHeader><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><Trophy className="h-5 w-5 text-teal-700" aria-hidden="true" /><CardTitle className="text-lg text-slate-900">Awards</CardTitle></div><Button type="button" size="sm" variant="ghost" onClick={() => setAttempt(value => value + 1)}>Refresh awards</Button></div></CardHeader>
    <CardContent className="space-y-6">{result.awards.map(award => {
      const categories = new Map();
      for (const outcome of award.outcomes) {
        const category = outcome.category || '';
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(outcome);
      }
      return <section key={`${award.eventLinkId}:${award.awardId}`} className="space-y-4 border-t border-slate-200 pt-5 first:border-t-0 first:pt-0">
        {award.name && <h3 className="font-semibold text-slate-900 whitespace-pre-wrap break-words">{award.name}</h3>}
        {award.description && <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap break-words">{award.description}</p>}
        {award.eligibility && <div><h4 className="font-medium text-sm text-slate-900 mb-1">Eligibility</h4><p className="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap break-words">{award.eligibility}</p></div>}
        {award.applicationSlug && <a className="inline-flex min-h-10 items-center justify-center rounded-md border border-teal-200 bg-teal-50 px-4 py-2 text-sm font-medium text-teal-800 hover:bg-teal-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700" href={`/FormView?slug=${encodeURIComponent(award.applicationSlug)}&award_id=${encodeURIComponent(award.awardId)}`}>Apply{award.name ? ` for ${award.name}` : ''}</a>}
        {[...categories.entries()].map(([category, outcomes]) => <section key={category} className="rounded-lg border border-slate-200 p-4"><h4 className="font-semibold text-sm text-slate-900 whitespace-pre-wrap break-words">{category || 'Published outcomes'}</h4><ul className="divide-y divide-slate-200 mt-2">{outcomes.map((outcome, index) => <li key={index} className="py-3 first:pt-1 last:pb-0">
          {outcome.title && <p className="font-medium text-sm text-slate-900 whitespace-pre-wrap break-words">{outcome.title}</p>}{outcome.recipient && <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap break-words">{outcome.recipient}</p>}{outcome.summary && <p className="text-sm text-slate-600 mt-2 whitespace-pre-wrap break-words">{outcome.summary}</p>}
        </li>)}</ul></section>)}
        {Array.isArray(award.shortlists) && award.shortlists.length > 0 && <section className="rounded-lg border border-teal-200 bg-teal-50/40 p-4" aria-label="Published shortlist" data-testid="event-award-shortlists">
          <h4 className="font-semibold text-sm text-slate-900">Published shortlist</h4>
          <ul className="divide-y divide-teal-200 mt-2">{award.shortlists.map((entry, index) => <li key={index} className="py-3 first:pt-1 last:pb-0">
            {entry.title && <p className="font-medium text-sm text-slate-900 whitespace-pre-wrap break-words">{entry.title}</p>}
            {entry.recipient && <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap break-words">{entry.recipient}</p>}
            {entry.summary && <p className="text-sm text-slate-600 mt-2 whitespace-pre-wrap break-words">{entry.summary}</p>}
          </li>)}</ul>
        </section>}
      </section>;
    })}</CardContent>
  </Card>;
}
