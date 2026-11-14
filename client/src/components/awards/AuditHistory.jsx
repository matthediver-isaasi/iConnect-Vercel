import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { roundAdminRequest } from './useRoundAdministration';
import './awards.css';

function readableAction(action) {
  return String(action || '').split('.').map(part => part.replace(/_/g, ' ')).join(' · ');
}
function auditTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(date)} UTC` : 'Timestamp unavailable';
}
function Changes({ value }) {
  if (value === null) return <span className="awards-help">Not supplied</span>;
  if (Array.isArray(value)) return value.length ? <ol className="list-decimal pl-5 space-y-2">{value.map((item, index) => <li key={index}><Changes value={item} /></li>)}</ol> : <span className="awards-help">Empty list</span>;
  if (typeof value === 'object') return Object.keys(value).length ? <dl className="space-y-3 border-l pl-3">{Object.entries(value).map(([key, item]) => <div key={key}><dt className="text-xs font-mono break-words">{key}</dt><dd className="mt-1"><Changes value={item} /></dd></div>)}</dl> : <span className="awards-help">No changed fields supplied</span>;
  return <span className="text-sm whitespace-pre-wrap break-words">{value === '' ? '(empty)' : String(value)}</span>;
}

export default function AuditHistory(props) {
  if (!props.canReport) return null;
  return <AwardAudit key={`${props.tenant.scopeKey}:${props.award.id}`} {...props} />;
}
function AwardAudit({ award, tenant }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['award-audit-history', tenant.scopeKey, award.id, page],
    queryFn: async ({ signal }) => {
      const result = await roundAdminRequest(tenant, `/api/awards/audit?awardId=${encodeURIComponent(award.id)}&page=${page}`, { signal });
      if (!Array.isArray(result.events) || !Number.isSafeInteger(result.total) || result.total < 0 || result.page !== page || !Number.isSafeInteger(result.pageSize) || result.pageSize < 1 || result.events.length > result.pageSize || result.events.some(event => !event?.id || typeof event.action !== 'string' || typeof event.created_at !== 'string')) throw new Error('The audit page could not be verified. Reload this page of history.');
      return result;
    },
    retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const { events = [], total = 0, pageSize = 50 } = query.data || {};
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <Card className="awards-workspace mt-6 min-w-0 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Recorded administration history</p><CardTitle className="text-xl">Award audit history</CardTitle><p className="awards-help">Read-only event records, newest first. Times are UTC. The feed does not supply actor identities; none are inferred from subject IDs. New records may shift subsequent page positions.</p></CardHeader>
    <CardContent className="pt-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="awards-help">{query.data ? `${total} recorded events · page ${page} of ${pages}` : query.isError ? 'History unavailable' : 'Loading recorded history'}</p><div className="flex flex-wrap gap-2">{page > 1 && <Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => setPage(1)}>Newest events</Button>}<Button type="button" size="sm" variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh audit page</Button></div></div>
      {query.isLoading && <div aria-label="Loading audit events" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>}
      {query.isError && <p role="alert" className="text-sm text-red-800">{query.error.message} No substitute history has been generated. Use “Refresh audit page” to retry.</p>}
      {query.isSuccess && !events.length && <div className="rounded-lg border p-5"><h3 className="font-medium text-sm">{page === 1 ? 'No audit events recorded' : 'No events on this page'}</h3><p className="awards-help mt-1">{page === 1 ? 'This award has no audit entries in the returned history.' : 'Return to an earlier page or refresh the current history.'}</p></div>}
      {query.isSuccess && events.length > 0 && <div className="max-h-[36rem] overflow-y-auto rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700" tabIndex={0} role="region" aria-label="Award audit events"><ol className="divide-y">{events.map(event => <li key={event.id}><details className="p-4">
        <summary className="cursor-pointer text-sm"><span className="font-semibold capitalize break-words">{readableAction(event.action)}</span><time className="block awards-help mt-1" dateTime={event.created_at}>{auditTime(event.created_at)}</time><span className="block awards-help line-clamp-2 mt-2">{event.reason || 'No reason supplied'}</span></summary>
        <div className="space-y-4 mt-4"><p className="text-xs font-mono break-all">{event.action}</p><div><h4 className="font-medium text-sm mb-1">Recorded reason</h4><p className="text-sm whitespace-pre-wrap break-words">{event.reason || 'No reason supplied'}</p></div><div><h4 className="font-medium text-sm mb-1">Subject reference</h4><p className="text-xs font-mono break-all">{event.subject_id || 'No subject reference supplied'}</p></div><div><h4 className="font-medium text-sm mb-2">Recorded changes (read-only)</h4><Changes value={event.changes ?? null} /></div></div>
      </details></li>)}</ol></div>}
      <div className="flex items-center justify-between gap-3"><Button type="button" size="sm" variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => setPage(value => value - 1)}>Previous audit page</Button><Button type="button" size="sm" variant="outline" disabled={!query.data || page >= pages || query.isFetching} onClick={() => setPage(value => value + 1)}>Next audit page</Button></div>
    </CardContent>
  </Card>;
}
