import React, { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { base44, getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import { useLayoutContext } from '@/contexts/LayoutContext';
import EventTimeDisplay from './EventTimeDisplay';

// Share discovery without conflating public-host routing with authenticated
// workspace selection (the shared admin host has no public tenant slug).
export default function TenantEventTimeDisplay(props) {
  const activeTenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const { memberInfo, sessionValidated } = useLayoutContext();
  const memberTenant = sessionValidated ? memberInfo?.tenant_id : null;
  const authenticatedTenant = activeTenant || memberTenant;
  const tenant = authenticatedTenant || publicClient.getTenantSlug();
  const { data = [] } = useQuery({
    queryKey: ['event-display-settings', authenticatedTenant ? 'authenticated' : 'public', tenant],
    queryFn: async () => {
      if (!authenticatedTenant) return publicClient.listSystemSettings();
      const settings = await base44.entities.SystemSettings.list();
      // Do not publish an in-flight response under an earlier workspace key.
      if (getActiveTenantId() !== activeTenant) throw new Error('Event display workspace changed');
      return settings.filter(s => ['event_display_timezones', 'event_time_format_24h'].includes(s.setting_key));
    },
    staleTime: 30000,
    enabled: !props.disabled,
  });
  if (props.disabled) return <>{props.children}</>;
  return <EventTimeDisplay {...props} systemSettings={data} />;
}
