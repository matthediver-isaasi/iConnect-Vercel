import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenantBranding } from '@/contexts/TenantBrandingContext';
import { useCookieConsent } from '@/hooks/useCookieConsent';
import {
  getEventClickTenantScope,
  getOrCreateEventClickVisitorId,
  sendEventClick,
} from '@/lib/eventClickTracking';
import { fetchEventClickCounts } from '@/lib/eventClickCounts';

function getTenantSlug(tenantSlug) {
  return typeof tenantSlug === 'string' && tenantSlug.trim() ? tenantSlug.trim() : null;
}

export function useEventClickTracking({ enabled = false } = {}) {
  const queryClient = useQueryClient();
  const tenantBranding = useTenantBranding() || {};
  const branding = tenantBranding.branding;
  const tenantSlug = getTenantSlug(tenantBranding.tenantSlug);
  const { hasConsented } = useCookieConsent();
  const tenantScope = useMemo(
    () => getEventClickTenantScope(tenantSlug || branding?.slug),
    [branding?.slug, tenantSlug],
  );

  const trackEventClick = useCallback((event, interactionEvent) => {
    if (!enabled || !hasConsented || !event?.id) return false;
    const button = interactionEvent?.button ?? 0;
    if (button !== 0) return false;

    const visitorId = getOrCreateEventClickVisitorId(tenantScope);
    const sent = sendEventClick({
      eventId: event.id,
      eventType: event.is_complex ? 'complex' : 'simple',
      visitorId,
      tenantSlug: tenantSlug || branding?.slug,
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['event-click-counts', tenantScope] }),
    });
    return sent;
  }, [branding?.slug, enabled, hasConsented, queryClient, tenantScope, tenantSlug]);

  const trackEventAuxClick = useCallback((event, interactionEvent) => {
    if (!interactionEvent || interactionEvent.button !== 1) return false;
    return trackEventClick(event, { button: 0 });
  }, [trackEventClick]);

  return { tenantScope, trackEventClick, trackEventAuxClick };
}

export function useEventClickCounts({
  simpleEventIds = [],
  complexEventIds = [],
  enabled = false,
  tenantScope = 'unknown',
} = {}) {
  const normalizedSimpleIds = useMemo(
    () => [...new Set((simpleEventIds || []).filter(Boolean))].sort(),
    [simpleEventIds],
  );
  const normalizedComplexIds = useMemo(
    () => [...new Set((complexEventIds || []).filter(Boolean))].sort(),
    [complexEventIds],
  );
  const hasIds = normalizedSimpleIds.length > 0 || normalizedComplexIds.length > 0;

  return useQuery({
    queryKey: ['event-click-counts', tenantScope, normalizedSimpleIds, normalizedComplexIds],
    queryFn: () => fetchEventClickCounts({
      simpleEventIds: normalizedSimpleIds,
      complexEventIds: normalizedComplexIds,
    }),
    enabled: enabled && hasIds,
    staleTime: 0,
  });
}