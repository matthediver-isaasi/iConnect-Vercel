import { useQuery } from '@tanstack/react-query';

async function jsonRequest(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error || 'Event reservation is temporarily unavailable.'), { code: data?.code });
  return data;
}

export function useEventFunnelEntry({ eventId, eventKind, viewerKey = 'guest', enabled = true }) {
  return useQuery({
    queryKey: ['event-funnel-entry', eventKind, eventId, viewerKey],
    enabled: enabled && !!eventId && ['simple', 'complex'].includes(eventKind),
    queryFn: () => jsonRequest(`/api/event-funnels/entry?eventId=${encodeURIComponent(eventId)}&eventKind=${eventKind}`),
    retry: false, staleTime: 30000,
  });
}

export const startEventFunnel = input => jsonRequest('/api/event-funnels/start', input);

export const changeEventFunnel = (sessionId, command) =>
  jsonRequest('/api/event-funnels/journey', { action: 'change', sessionId, command });

export const readEventFunnelOffer = (sessionId, nodeId) =>
  jsonRequest('/api/event-funnels/offer', { sessionId, nodeId });

export const prepareEventFunnelCheckout = (sessionId, expectedRevision, checkout) =>
  jsonRequest('/api/event-funnels/checkout', { action: 'prepare', sessionId, expectedRevision, checkout });

export const completeEventFunnelCheckout = (sessionId, orderId) =>
  jsonRequest('/api/event-funnels/checkout', { action: 'complete', sessionId, orderId });
