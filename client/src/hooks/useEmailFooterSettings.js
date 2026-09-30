import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || 'Unable to load email footer settings');
  return body;
}

// Resolve identity from authenticated server responses, never localStorage or
// public branding. The tab tenant is an intent guard, not proof of identity.
export async function resolveFooterTenant(options) {
  const admin = await request('/api/auth/tenant-user-me', options);
  if (admin?.authenticated && admin?.tenant?.id) return admin.tenant.id;
  const member = await request('/api/auth/me', options);
  if (member?.id && member?.tenant_id) return member.tenant_id;
  throw new Error('Authenticated organisation context is unavailable. Sign in again to load the footer.');
}

export function useEmailFooterSettings({ getActiveTenantId, subscribeToActiveTenantId }) {
  const queryClient = useQueryClient();
  const [context, setContext] = useState(() => ({ intent: getActiveTenantId(), visit: 0 }));
  const current = useRef(context);
  useEffect(() => {
    const update = intent => {
      if (current.current.intent === intent) return;
      const next = { intent, visit: current.current.visit + 1 };
      current.current = next; // Blocks stale save handlers before React rerenders.
      setContext(next);
    };
    const unsubscribe = subscribeToActiveTenantId(update);
    update(getActiveTenantId());
    return unsubscribe;
  }, [getActiveTenantId, subscribeToActiveTenantId]);
  const [draft, setDraft] = useState(null);
  const saveInFlight = useRef(false);
  const uncertainSave = useRef(null);
  const queryKey = ['email-footer-settings', context.intent, context.visit];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const headers = context.intent ? { 'X-Tenant-Id': context.intent } : {};
      const tenantId = await resolveFooterTenant({ signal, headers });
      if (context.intent && tenantId !== context.intent) {
        throw new Error('Organisation context changed. Reload this page before editing the footer.');
      }
      const read = async key => {
        const params = new URLSearchParams({ filter: JSON.stringify({ setting_key: key }) });
        const rows = await request(`/api/entities/SystemSettings?${params}`, {
          signal, headers: { 'X-Tenant-Id': tenantId },
        });
        if (!Array.isArray(rows) || rows.length > 1
          || rows.some(row => row.setting_key !== key || row.tenant_id !== tenantId)) {
          throw new Error('Invalid or duplicate email settings returned for this organisation.');
        }
        return rows[0] || null;
      };
      const [footer, social] = await Promise.all([read('email_footer_html'), read('social_icons_config')]);
      if (footer && typeof footer.setting_value !== 'string') throw new Error('Saved footer HTML is invalid.');
      let socialIcons = null;
      if (social?.setting_value) {
        try { socialIcons = JSON.parse(social.setting_value); }
        catch { throw new Error('Saved social icon configuration is invalid.'); }
      }
      if (uncertainSave.current === context) uncertainSave.current = null;
      return { tenantId, footer, socialIcons };
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const ready = query.isSuccess && !query.isFetching && current.current === context;
  const html = ready ? (draft?.context === context ? draft.html : query.data.footer?.setting_value ?? '') : '';
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!ready || saveInFlight.current || uncertainSave.current === context
        || current.current !== context || getActiveTenantId() !== context.intent) {
        throw new Error('Wait for the current organisation’s footer to finish loading before saving.');
      }
      // Read the cache synchronously: a create can finish before React has
      // rendered its returned row ID, and a second save must be an update.
      const loaded = queryClient.getQueryData(queryKey);
      const { tenantId, footer } = loaded;
      saveInFlight.current = true;
      try {
        const saved = await request(`/api/entities/SystemSettings${footer ? `/${footer.id}` : ''}`, {
          method: footer ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
          body: JSON.stringify(footer ? { setting_value: html } : {
            setting_key: 'email_footer_html', setting_value: html,
            description: 'HTML footer appended to all outgoing emails',
          }),
        });
        if (!saved?.id || saved.tenant_id !== tenantId || saved.setting_key !== 'email_footer_html') {
          throw new Error('Unable to confirm the saved footer. Reload its settings before trying again.');
        }
        if (current.current === context) {
          queryClient.setQueryData(queryKey, { ...loaded, footer: saved });
        }
        return saved;
      } catch (error) {
        // A lost response may still have created the row. Re-read before any
        // retry so an uncertain create cannot become a duplicate.
        if (current.current === context) {
          uncertainSave.current = context;
          void queryClient.invalidateQueries({ queryKey, exact: true });
        }
        throw error;
      } finally {
        saveInFlight.current = false;
      }
    },
  });
  return {
    html, socialIcons: ready ? query.data.socialIcons : null,
    ready, missing: ready && !query.data.footer,
    loading: query.isPending || query.isFetching,
    error: query.error, retry: query.refetch,
    setHtml: html => { if (ready) setDraft({ context, html }); },
    save: saveMutation.mutateAsync,
    saving: saveMutation.isPending,
  };
}