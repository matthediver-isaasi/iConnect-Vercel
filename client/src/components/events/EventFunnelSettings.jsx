import React, { lazy, Suspense, useState } from 'react';
import { funnelSimpleTickets } from '../../../../shared/eventFunnelCatalog.mjs';
import { isFutureFunnelEvent, sortFunnelCatalog } from '../../../../shared/eventFunnelAuthoring.mjs';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, GitBranch } from 'lucide-react';

const EventFunnelBuilder = lazy(() => import('./EventFunnelBuilder'));
async function request(body) {
  const response = await fetch('/api/event-funnels', {
    credentials: 'include',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Event funnels could not be loaded.');
  return result;
}
export default function EventFunnelSettings({ standalone = false }) {
  const { memberInfo, isAdmin, isAccessReady, isFeatureExcluded } = useMemberAccess();
  const [opened, setOpened] = useState(standalone);
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const allowed = isAccessReady && isAdmin && !isFeatureExcluded('events.browse-events.create');
  const queryKey = ['event-funnel-definitions', memberInfo?.tenant_id, memberInfo?.id];
  const state = useQuery({ queryKey, queryFn: () => request(), enabled: opened && allowed, retry: false, staleTime: 0 });
  const catalog = useQuery({
    queryKey: ['event-funnel-catalog', state.data?.tenantId, memberInfo?.id],
    enabled: opened && allowed && !!state.data?.tenantId,
    retry: false,
    queryFn: async () => {
      const [simple, complex, tickets] = await Promise.all([
        base44.entities.Event.listAll(),
        base44.entities.ComplexEvent.listAll(),
        base44.entities.ComplexEventTicketClass.listAll(),
      ]);
      if (![simple, complex, tickets].every(Array.isArray)) throw new Error('The event catalog could not be loaded completely.');
      const tenant = state.data.tenantId;
      return sortFunnelCatalog([
        ...simple.filter(event => event.tenant_id === tenant && !event.is_complex).map(event => ({
          id: event.id, kind: 'simple', title: event.title, status: event.event_state || event.status,
          start_date: event.start_date, end_date: event.end_date, selectable: isFutureFunnelEvent(event),
          tickets: funnelSimpleTickets(event).map(ticket => ({ id: String(ticket.id), name: ticket.name })),
        })),
        ...complex.filter(event => event.tenant_id === tenant).map(event => ({
          id: event.id, kind: 'complex', title: event.title, status: event.status,
          start_date: event.start_date, end_date: event.end_date, selectable: isFutureFunnelEvent(event),
          tickets: tickets.filter(ticket => ticket.complex_event_id === event.id && ticket.tenant_id === tenant)
            .map(ticket => ({ id: String(ticket.id), name: ticket.name })),
        })),
      ]);
    },
  });
  if (!isAccessReady) return <p role="status">Checking access…</p>;
  if (!allowed) return <p role="alert">You do not have permission to manage event funnels.</p>;
  if (!standalone) return <Link to="/EventFunnels">Open event funnels</Link>;
  const error = state.error || catalog.error;
  return <Card className="mb-8" data-testid="event-funnel-settings">
    <CardHeader><CardTitle className="flex items-center gap-2"><GitBranch className="h-5 w-5" />Event ticket sales funnels</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Build optional event and ticket offers that lead to one checkout. Each event keeps its own registrations.</p>
      {!opened ? <Button type="button" variant="outline" onClick={() => setOpened(true)}>Open funnel builder</Button> : <>
        {error && <div role="alert" className="text-sm text-destructive">
          <p>{error.message}</p>
          <Button type="button" variant="outline" onClick={() => { state.refetch(); if (state.data) catalog.refetch(); }}>Retry loading</Button>
        </div>}
        {!state.data || !catalog.data ? (!error && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading event definitions…</p>) :
          <Suspense fallback={<p role="status">Loading editor…</p>}>
            {!state.data.readiness?.purchasing && <p role="status" className="rounded-md border p-3 text-sm">
              Draft authoring is available. {state.data.readiness?.reason || 'Customer purchasing is not activated.'}
            </p>}
            <EventFunnelBuilder key={state.data.tenantId} tenantId={state.data.tenantId}
              definitions={state.data.definitions} catalog={catalog.data} busy={saving}
              unavailable={error?.message || null}
              onSave={async input => {
                setSaving(true);
                try {
                  const saved = await request({ action: 'save', ...input });
                  queryClient.setQueryData(queryKey, current => ({
                    ...current, definitions: [saved, ...(current?.definitions || []).filter(item => item.id !== saved.id)],
                  }));
                  return saved;
                } finally { setSaving(false); }
              }}
              onPreview={input => request({ action: 'preview', ...input })}
              onPublish={input => request({ action: 'publish', ...input })}
            />
          </Suspense>}
      </>}
    </CardContent>
  </Card>;
}
