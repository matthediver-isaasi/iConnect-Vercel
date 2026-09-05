import { useRef, useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
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

export function useSavedListViews({ page, memberId, scopeId, enabled = true }) {
  const cfg = PAGE_CONFIG[page];
  if (!cfg) throw new Error(`useSavedListViews: unknown page "${page}"`);
  const prefKey = savedListViewPreferenceKey(page, memberId, scopeId);
  const legacyKey = memberId ? cfg.legacyKey(memberId, scopeId) : null;
  const queryClient = useQueryClient();
  const loadedRef = useRef(false);
  const loadedKeyRef = useRef(prefKey);
  const rowIdRef = useRef(null);
  const legacyRowIdRef = useRef(null);
  const [activeViewId, setActiveViewId] = useState(null);

  // A mounted list can navigate directly between custom objects. Re-arm the
  // one-shot query synchronously so the first render for the new object cannot
  // accidentally reuse the previous object's persistence row.
  if (loadedKeyRef.current !== prefKey) {
    loadedKeyRef.current = prefKey;
    loadedRef.current = false;
    rowIdRef.current = null;
    legacyRowIdRef.current = null;
  }

  useEffect(() => {
    setActiveViewId(null);
  }, [prefKey]);

  const { data } = useQuery({
    queryKey: ['crm-saved-list-views', prefKey],
    enabled: enabled && !!prefKey && !loadedRef.current,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (loadedRef.current) return null;
      loadedRef.current = true;
      try {
        const settings = await base44.entities.SystemSettings.list();
        const row = settings?.find((s) => s.setting_key === prefKey);
        if (row) {
          rowIdRef.current = row.id;
          let views = [];
          try {
            views = sanitizeViews(JSON.parse(row.setting_value)?.views);
          } catch {}
          // Track the legacy row (if it survived a partial migration) so the
          // next persist cleans it up; it is otherwise ignored.
          const legacyRow = legacyKey
            ? settings?.find((s) => s.setting_key === legacyKey)
            : null;
          if (legacyRow?.id) legacyRowIdRef.current = legacyRow.id;
          return { id: row.id, views };
        }
        // No views row yet: read the legacy single saved view as a first
        // named view so nobody loses their current setup.
        const legacyRow = legacyKey
          ? settings?.find((s) => s.setting_key === legacyKey)
          : null;
        if (legacyRow?.setting_value) {
          legacyRowIdRef.current = legacyRow.id;
          try {
            const f = JSON.parse(legacyRow.setting_value);
            if (f && typeof f === 'object') {
              return {
                id: null,
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
          } catch {}
        }
        return { id: null, views: [] };
      } catch {
        return { id: null, views: [] };
      }
    },
  });

  // Warm remount: recover the row id from cache (queryFn does not re-run).
  useEffect(() => {
    if (data?.id) rowIdRef.current = data.id;
  }, [data]);

  const views = data?.views || [];
  const viewsLoaded = data !== undefined && data !== null;
  const defaultView = views.find((v) => v.isDefault) || null;
  const activeView = views.find((v) => v.id === activeViewId) || null;

  const persistMutation = useMutation({
    mutationFn: async (nextViews) => {
      if (!prefKey) throw new Error('Member context not ready');
      const valueStr = JSON.stringify({ views: nextViews });
      if (rowIdRef.current) {
        await base44.entities.SystemSettings.update(rowIdRef.current, {
          setting_value: valueStr,
        });
      } else {
        const created = await base44.entities.SystemSettings.create({
          setting_key: prefKey,
          setting_value: valueStr,
          description: cfg.description,
        });
        if (created?.id) rowIdRef.current = created.id;
      }
      // The saved views now live in the new row; remove the legacy
      // single-view row so it can never be read back as a duplicate.
      if (legacyRowIdRef.current) {
        try {
          await base44.entities.SystemSettings.delete(legacyRowIdRef.current);
        } catch {}
        legacyRowIdRef.current = null;
      }
      return nextViews;
    },
    onSuccess: (nextViews) => {
      queryClient.setQueryData(['crm-saved-list-views', prefKey], {
        id: rowIdRef.current,
        views: nextViews,
      });
    },
  });

  const mutateViews = useCallback(
    (updater) => {
      const current =
        queryClient.getQueryData(['crm-saved-list-views', prefKey])?.views || [];
      return persistMutation.mutateAsync(updater(current));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefKey, queryClient]
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
