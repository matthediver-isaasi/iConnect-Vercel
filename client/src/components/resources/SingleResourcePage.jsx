import React, { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemberAccess } from '@/hooks/useMemberAccess';
import { useLayoutContext } from '@/contexts/LayoutContext';
import { Button } from '@/components/ui/button';
import { publicClient } from '@/api/publicClient';
import ResourceCard from './ResourceCard';

// This component deliberately does not mount the library's list/preferences/
// group/category queries. Authentication must be server-validated first.
export default function SingleResourcePage({ resourceId, onBrowse }) {
  const { memberInfo, memberRole } = useMemberAccess();
  const { authResolved, sessionValidated } = useLayoutContext();
  const authenticated = authResolved && sessionValidated && !!memberInfo?.id;
  const ready = authResolved && (authenticated || !memberInfo?.id);
  const queryClient = useQueryClient();
  const tenantSlug = publicClient.getTenantSlug();
  const queryKey = [
    'single-resource', window.location.host, memberInfo?.tenant_id || tenantSlug || null,
    authenticated ? memberInfo.id : 'guest', authenticated ? memberRole?.id : null,
    resourceId,
  ];
  const { data: resource, error, isFetching, refetch } = useQuery({
    queryKey,
    enabled: ready,
    queryFn: async ({ signal }) => {
      const endpoint = authenticated ? '/api/resources/single/' : '/api/public/resource/';
      const url = new URL(`${endpoint}${encodeURIComponent(resourceId)}`, window.location.origin);
      // Preserve publicClient's tenant discovery on preview/custom hosts.
      // This is only a tenant hint for the public projection, never identity.
      if (!authenticated && tenantSlug) url.searchParams.set('tenant', tenantSlug);
      const response = await fetch(url.pathname + url.search, {
        credentials: 'include', signal,
      });
      if (!response.ok) {
        const message = response.status === 404
          ? 'This resource is unavailable or you do not have access to it.'
          : response.status === 401
            ? 'Your session has expired. Please sign in again.'
            : 'Unable to load this resource. Please try again.';
        throw new Error(message);
      }
      return response.json();
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
  });

  // Abort in-flight reads and discard protected content on identity/ID changes,
  // logout, or leaving this view. Never reuse another member's cached response.
  useEffect(() => () => {
    queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
  }, [queryClient, ...queryKey]);

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <Button variant="outline" onClick={onBrowse} className="mb-6">View all resources</Button>
      <h1 className="text-3xl font-bold mb-6">Resource</h1>
      {!ready || (!resource && isFetching) ? (
        <p role="status">Loading resource…</p>
      ) : error ? (
        <div role="alert" className="space-y-4">
          <p>{error.message}</p>
          <Button variant="outline" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : resource ? (
        <div className="max-w-xl">
          <ResourceCard resource={resource} isAuthenticated={authenticated}
            isLocked={!authenticated && !resource.is_public} />
        </div>
      ) : null}
    </main>
  );
}