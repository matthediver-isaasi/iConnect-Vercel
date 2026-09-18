import { useState, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44, getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
import {
  savedListViewPreferenceKey,
  sanitizeSavedViews,
} from './savedListViewHelpers.mjs';

export { savedListViewPreferenceKey } from './savedListViewHelpers.mjs';

// Named personal saved views for the CRM list pages (/members, /organisations).
//
// Storage model: ONE SystemSettings row per user per page, keyed
// `crm_member_views_<memberId>` / `crm_org_views_<memberId>`, whose value is
// JSON `{ views: [{ id, name, isDefault, filters, columns }] }`.
//
// Backward compatibility: the previous single-saved-view rows
// (`crm_member_filters_<memberId>` / `crm_org_filters_<memberId>`) are read
// when no views row exists yet and surfaced as a first named view ("My view",
// marked default so the old auto-apply behaviour is preserved). The legacy row
// is deleted the first time the new views row is persisted.

const PAGE_CONFIG = {
  members: {
    viewsKey: (memberId) => `crm_member_views_${memberId}`,
    legacyKey: (memberId) => `crm_member_filters_${memberId}`,
    description: 'CRM member list saved views',
  },
  organisations: {
    viewsKey: (memberId) => `crm_org_views_${memberId}`,
    legacyKey: (memberId) => `crm_org_filters_${memberId}`,
    description: 'CRM organisation list saved views',
  },
  customObjects: {
    viewsKey: (memberId, scopeId) => `crm_custom_object_views_${memberId}_${scopeId}`,
    legacyKey: () => null,
    description: 'Custom object record list saved views',
    scoped: true,
  },
};

const genViewId = () =>
  `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// Sanitize a raw parsed views array: drop malformed entries, guarantee ids and
// at most one default view.
export const sanitizeViews = (raw) => {
  return sanitizeSavedViews(raw, genViewId);
};

const EMPTY_VIEWS = [];

export function useSavedListViews({ page, memberId, scopeId, tenantId, enabled = true }) {
  const cfg = PAGE_CONFIG[page];
  if (!cfg) throw new Error(`useSavedListViews: unknown page "${page}"`);
  const prefKey = savedListViewPreferenceKey(page, memberId, scopeId);
  const legacyKey = memberId ? cfg.legacyKey(memberId, scopeId) : null;
  const queryClient = useQueryClient();
  const activeTenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const queryKey = useMemo(
    () => ['crm-saved-list-views', tenantId || activeTenant || null, prefKey],
    [tenantId, activeTenant, prefKey],
  );
  const identity = JSON.stringify(queryKey);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [selection, setSelection] = useState(null);
  const activeViewId = selection?.identity === identity ? selection.id : null;
  const setActiveViewId = useCallback((next) => {
    setSelection(previous => ({
      identity,
      id: typeof next === 'function'
        ? next(previous?.identity === identity ? previous.id : null)
        : next,
    }));
  }, [identity]);

  const { data, isSuccess, error, refetch, isFetching } = useQuery({
    queryKey,
    enabled: enabled && !!prefKey,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
        // Match the keys on the server; an all-settings scan is expensive and
        // can miss this user's view beyond the entity API's row cap.
        const settings = await base44.entities.SystemSettings.list({
          filter: { setting_key: [prefKey, legacyKey].filter(Boolean) },
          signal,
        });
        if (!Array.isArray(settings)) throw new Error('Unable to read saved list views');
        const row = settings?.find((s) => s.setting_key === prefKey);
        const legacyRow = legacyKey ? settings.find(s => s.setting_key === legacyKey) : null;
        const legacyId = legacyRow?.id || null;
        if (row) {
          let views = [];
          try {
            views = sanitizeViews(JSON.parse(row.setting_value)?.views);
          } catch { throw new Error('The saved list view could not be read'); }
          // Track the legacy row (if it survived a partial migration) so the
          // next persist cleans it up; it is otherwise ignored.
          return { id: row.id, views, legacyId };
        }
        // No views row yet: read the legacy single saved view as a first
        // named view so nobody loses their current setup.
        if (legacyRow?.setting_value) {
          try {
            const f = JSON.parse(legacyRow.setting_value);
            if (f && typeof f === 'object') {
              return {
                id: null,
                legacyId,
                views: [
                  {
                    id: genViewId(),
                    name: 'My view',
                    isDefault: true,
                    filters: f,
                    columns: null,
                  },
                ],
              };
            }
          } catch { throw new Error('The legacy saved list view could not be read'); }
        }
        return { id: null, views: [], legacyId };
    },
  });

  const views = data?.views || EMPTY_VIEWS;
  const viewsLoaded = isSuccess;
  const defaultView = views.find((v) => v.isDefault) || null;
  const activeView = views.find((v) => v.id === activeViewId) || null;

  const persistMutation = useMutation({
    // Serialize changes within this query client, deriving each new value only
    // when it starts. Two quick saves must not both create from the same null id.
    scope: { id: identity },
    mutationFn: async ({ updater, cacheKey, preferenceKey, description, sourceIdentity }) => {
      if (identityRef.current !== sourceIdentity) throw new Error('List context changed before saving');
      const source = queryClient.getQueryData(cacheKey);
      if (!source) throw new Error('Saved views must load before saving');
      const nextViews = updater(source.views);
      const valueStr = JSON.stringify({ views: nextViews });
      let id = source.id;
      if (id) {
        await base44.entities.SystemSettings.update(id, {
          setting_value: valueStr,
        });
      } else {
        const created = await base44.entities.SystemSettings.create({
          setting_key: preferenceKey,
          setting_value: valueStr,
          description,
        });
        if (!created?.id) throw new Error('Unable to save list view');
        id = created.id;
      }
      // The saved views now live in the new row; remove the legacy
      // single-view row so it can never be read back as a duplicate.
      let legacyId = source.legacyId;
      if (legacyId) {
        try {
          await base44.entities.SystemSettings.delete(legacyId);
          legacyId = null;
        } catch {}
      }
      return { id, views: nextViews, legacyId };
    },
    onSuccess: (saved, variables) => {
      queryClient.setQueryData(variables.cacheKey, saved);
    },
  });

  const mutateViews = useCallback(
    (updater) => {
      const state = queryClient.getQueryState(queryKey);
      const source = state?.data;
      if (!enabled || !prefKey || state?.status !== 'success' || !source) {
        return Promise.reject(new Error('Saved views must load before saving; retry the load first.'));
      }
      return persistMutation.mutateAsync({
        updater, preferenceKey: prefKey, sourceIdentity: identity,
        description: cfg.description, cacheKey: queryKey,
      }).then(saved => saved.views);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefKey, queryClient, queryKey, identity, enabled, cfg.description, persistMutation.mutateAsync]
  );

  const createView = useCallback(
    (name, snapshot, { makeDefault = false } = {}) => {
      const view = {
        id: genViewId(),
        name,
        isDefault: makeDefault,
        filters: snapshot.filters,
        columns: snapshot.columns || null,
      };
      return mutateViews((curr) =>
        makeDefault
          ? [...curr.map((v) => ({ ...v, isDefault: false })), view]
          : [...curr, view]
      ).then(() => view);
    },
    [mutateViews]
  );

  const updateView = useCallback(
    (viewId, snapshot) =>
      mutateViews((curr) =>
        curr.map((v) =>
          v.id === viewId
            ? { ...v, filters: snapshot.filters, columns: snapshot.columns || null }
            : v
        )
      ),
    [mutateViews]
  );

  const renameView = useCallback(
    (viewId, name) =>
      mutateViews((curr) =>
        curr.map((v) => (v.id === viewId ? { ...v, name } : v))
      ),
    [mutateViews]
  );

  const deleteView = useCallback(
    (viewId) => {
      const result = mutateViews((curr) => curr.filter((v) => v.id !== viewId));
      setActiveViewId((prev) => (prev === viewId ? null : prev));
      return result;
    },
    [mutateViews]
  );

  // viewId = null clears the default (page opens unfiltered).
  const setDefaultView = useCallback(
    (viewId) =>
      mutateViews((curr) =>
        curr.map((v) => ({ ...v, isDefault: v.id === viewId }))
      ),
    [mutateViews]
  );

  return {
    views,
    viewsLoaded,
    viewsError: error,
    viewsFetching: isFetching,
    retryViews: refetch,
    defaultView,
    activeViewId,
    setActiveViewId,
    activeView,
    createView,
    updateView,
    renameView,
    deleteView,
    setDefaultView,
    isSaving: persistMutation.isPending,
  };
}
