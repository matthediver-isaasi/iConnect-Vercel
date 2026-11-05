import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { alphabetTargetPage, groupAlphabetBuckets } from '@/lib/crmAlphabet.mjs';

export default function useCrmAlphabet({
  endpoint, listKey, tenantId, userId, params, drillIds,
  enabled, pageSize, currentPage, setCurrentPage,
  rawSearch, viewId, pageData, pageFetching, pageFailed, placeholder, pageQueryKey,
}) {
  const queryClient = useQueryClient();
  const containerRef = useRef(null);
  const [intent, setIntent] = useState(null);
  const [selection, setSelection] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const jumpSequence = useRef(0);
  const queryKey = useMemo(() => [
    'crm-alphabet', listKey, tenantId, userId, params, drillIds,
  ], [listKey, tenantId, userId, params, drillIds]);
  // Raw search invalidates an intent immediately, before the debounce fires.
  const scope = JSON.stringify([queryKey, rawSearch, viewId, enabled, pageSize]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const metadata = useQuery({
    queryKey,
    enabled: enabled && rawSearch === (params.search || ''),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiRequest(
        drillIds ? 'POST' : 'GET',
        `${endpoint}?${new URLSearchParams({ ...params, alphabet: '1' })}`,
        drillIds ? { ids: drillIds } : undefined,
        { signal, headers: tenantId ? { 'X-Tenant-Id': tenantId } : {} },
      );
      if (!Array.isArray(result?.buckets) || !Number.isSafeInteger(result.total) || result.total < 0) {
        throw new Error('Invalid alphabet metadata');
      }
      return result;
    },
  });
  const cancel = () => {
    setIntent(null);
    setSelection(null);
    setAnnouncement('');
  };
  useEffect(() => { cancel(); }, [scope]);

  // Realtime and CRUD already invalidate list queries. Observe that action,
  // rather than page fetches, to keep metadata fresh without navigation reads.
  useEffect(() => {
    let scheduled = false;
    let mounted = true;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const key = event.query?.queryKey;
      if (event.type !== 'updated' || event.action?.type !== 'invalidate'
        || key?.[0] !== listKey || key[1] !== tenantId || key[2] !== userId) return;
      setIntent(null);
      setSelection(null);
      // A prefix invalidation can touch many cached pages. It is one change,
      // not one metadata request per previously visited page.
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (mounted) queryClient.invalidateQueries({ queryKey: ['crm-alphabet', listKey, tenantId, userId] });
      });
    });
    return () => { mounted = false; unsubscribe(); };
  }, [queryClient, queryKey, listKey, tenantId, userId]);

  const groups = useMemo(
    () => groupAlphabetBuckets(metadata.data?.buckets, pageSize),
    [metadata.data, pageSize],
  );
  const busy = !enabled || rawSearch !== (params.search || '')
    || metadata.isFetching || metadata.isError;
  const jump = (group) => {
    if (busy) return;
    const page = alphabetTargetPage(group.offset, pageSize);
    setSelection(null);
    setAnnouncement(`Locating ${group.label}…`);
    const sequence = ++jumpSequence.current;
    setIntent({ scope, page, id: group.id, key: group.key, label: group.label, sequence, refreshing: true });
    setCurrentPage(page);
    // A previously visited page can still be "fresh" in the shared cache even
    // after a concurrent deletion/move. Revalidate that page before focusing.
    // Refetch (not invalidate) so this never triggers alphabet metadata reads.
    queryClient.refetchQueries({
      queryKey: pageQueryKey
        ? [...pageQueryKey.slice(0, 3), page, ...pageQueryKey.slice(4)]
        : [listKey, tenantId, userId, page, pageSize],
      exact: !!pageQueryKey, type: 'all',
    }, { throwOnError: true }).then(() => {
      setIntent(current => current?.sequence === sequence ? { ...current, refreshing: false } : current);
    }).catch(() => {
      setIntent(current => current?.sequence === sequence ? null : current);
      if (jumpSequence.current === sequence) setAnnouncement('The requested page could not be refreshed. Please try again.');
    });
  };
  useEffect(() => {
    if (!intent) return;
    if (intent.scope !== scope || currentPage !== intent.page || pageFailed
      || metadata.isFetching || metadata.isError) {
      setIntent(null);
      setSelection(null);
      return;
    }
    if (intent.refreshing || pageFetching || placeholder || pageData?.pagination?.page !== intent.page) return;
    // Find by exact data attribute equality, not a selector interpolated with
    // an untrusted ID. Only search inside this list, never the detail pane.
    const target = [...(containerRef.current?.querySelectorAll('[data-alphabet-id]') || [])]
      .find(node => node.getAttribute('data-alphabet-id') === intent.id);
    if (latestScope.current !== intent.scope) return;
    setIntent(null);
    if (!target) {
      setSelection(null);
      setAnnouncement('This record has moved or is no longer available. Try the alphabet again.');
      queryClient.invalidateQueries({ queryKey, exact: true });
      return;
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.focus({ preventScroll: true });
    setSelection({ ...intent, page: currentPage });
    setAnnouncement(`Jumped to ${intent.label}.`);
  }, [intent, scope, currentPage, pageData, pageFetching, pageFailed, placeholder,
    metadata.isFetching, metadata.isError, queryClient, queryKey]);

  const selected = selection?.scope === scope && selection.page === currentPage ? selection : null;
  return {
    containerRef,
    groups: enabled && metadata.data?.total > 0 ? groups : [],
    visible: enabled,
    loading: metadata.isLoading || metadata.isFetching || rawSearch !== (params.search || ''),
    error: metadata.isError,
    retry: () => metadata.refetch(),
    busy,
    jump,
    selectedKey: selected?.key,
    announcement,
    targetProps: (id) => ({
      'data-alphabet-id': id,
      'data-alphabet-highlighted': selected?.id === id ? 'true' : undefined,
      tabIndex: -1,
    }),
    manualPage: (value) => { cancel(); setCurrentPage(value); },
  };
}
