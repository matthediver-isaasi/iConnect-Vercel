import { useEffect, useRef } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutContext } from '@/contexts/LayoutContext';

const endpoint = '/api/communication/inbox/alert-preferences';
const signalKey = 'inbox-alert-preferences-changed';

export function useInboxAlertPreferences(override) {
  const context = useLayoutContext();
  const member = override?.memberInfo ?? context.memberInfo;
  const enabled = override ? override.enabled : context.authResolved && context.sessionValidated;
  // Role-validation epochs are not authenticated-login boundaries.
  const key = ['inbox-alert-preferences', member?.tenant_id, member?.id];
  const scope = JSON.stringify(key);
  const active = useRef();
  active.current = { scope, validated: context.sessionValidated };
  const client = useQueryClient();
  async function request(patch, signal) {
    const res = await fetch(endpoint, {
      credentials: 'include', cache: 'no-store', signal,
      ...(patch ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference: patch, member_id: member?.id,
          tenant_id: member?.tenant_id, login_key: client.getQueryData(key)?.login_key }) } : {}),
    });
    if (!res.ok) throw new Error('Could not save or load alert preferences. Please retry.');
    const data = await res.json();
    if (data.member_id !== member?.id || data.tenant_id !== member?.tenant_id
      || typeof data.login_key !== 'string' || typeof data.always_hide !== 'boolean'
       || typeof data.hide_until_login !== 'boolean' || typeof data.acknowledged !== 'boolean') throw new Error('Alert preference session changed. Please retry.');
    return data;
  }
  const query = useQuery({
    queryKey: key, queryFn: ({ signal }) => request(undefined, signal), enabled: !!enabled && !!member?.id,
    staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: true, retry: false,
    refetchInterval: 30000,
  });
  const pending = useMutationState({ filters: { mutationKey: key, status: 'pending' }, select: m => m.state.variables });
  const mutation = useMutation({
    mutationKey: key, mutationFn: async patch => {
      const login = client.getQueryData(key)?.login_key;
      const data = await request(patch);
      if (active.current.scope !== scope || !active.current.validated
        || data.login_key !== login || client.getQueryData(key)?.login_key !== login) {
        throw new Error('Alert preference session changed. Please retry.');
      }
      return data;
    },
    onMutate: async () => { await client.cancelQueries({ queryKey: key }); },
    onSuccess: data => {
      client.setQueryData(key, data);
      try { localStorage.setItem(signalKey, `${Date.now()}:${Math.random()}`); } catch { /* polling/focus still reconcile */ }
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  useEffect(() => {
    const refresh = event => {
      if (event.key === signalKey) {
        // Preserve last resolved data during ordinary cross-tab refreshes.
        client.invalidateQueries({ queryKey: key });
      } else if (event.key === 'agcas_member') {
        client.resetQueries({ queryKey: key });
      }
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [client, member?.id, member?.tenant_id]);
  useEffect(() => {
    if (!context.sessionValidated) client.removeQueries({ queryKey: key });
  }, [client, scope, context.sessionValidated]);
  return {
    data: query.data,
    ready: !!enabled && query.isSuccess && !query.isFetching && !query.isError,
    saving: pending.length > 0,
    error: mutation.error || query.error,
    loadError: query.error,
    save: mutation.mutateAsync,
    retry: () => { mutation.reset(); return query.refetch(); },
  };
}
