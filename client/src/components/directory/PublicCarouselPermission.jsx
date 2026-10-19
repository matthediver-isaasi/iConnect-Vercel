import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export const PUBLIC_CAROUSEL_PERMISSION_DESCRIPTION = 'Allow permitted directory fields to appear in Directory Carousels for visitors who are not signed in. Off by default. This is separate from Active, role visibility and full-directory or embed access.';

export default function PublicCarouselPermission({ source, tenantId, isAdmin }) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const key = ['directory-carousel-public-permission', tenantId, source];
  const url = `/api/directory-carousel/settings?source=${encodeURIComponent(source)}`;
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(isAdmin && tenantId),
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load public carousel permission.');
      return response.json();
    },
  });
  const mutation = useMutation({
    mutationFn: async (enabled) => {
      const response = await fetch(url, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not save public carousel permission.');
      return body;
    },
    onSuccess: (data) => { setError(''); client.setQueryData(key, data); },
    onError: (failure) => { setError(failure.message); },
  });
  if (!isAdmin) return null;
  return (
    <Card className="mb-6" data-testid="public-carousel-permission">
      <CardHeader>
        <CardTitle>Public carousel display</CardTitle>
        <CardDescription>{PUBLIC_CAROUSEL_PERMISSION_DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch id={`carousel-public-${source}`} checked={query.data?.enabled === true}
            disabled={!query.isSuccess || query.isFetching || mutation.isPending}
            onCheckedChange={(enabled) => mutation.mutate(enabled)} />
          <Label htmlFor={`carousel-public-${source}`}>Permit public carousel display</Label>
        </div>
        <p className="text-xs text-slate-500">Administrator-only. Changes save immediately; no page author can override this permission.</p>
        {query.isPending && <p role="status">Loading permission…</p>}
        {(query.isError || error) && <p role="alert">{error || query.error.message}</p>}
        {query.isError && <Button variant="outline" onClick={() => query.refetch()}>Retry</Button>}
      </CardContent>
    </Card>
  );
}
